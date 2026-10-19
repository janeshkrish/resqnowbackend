import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { databaseConnectionOptions, addRowDigest } from "../models/migrations/deploymentMigration.js";
import { quoteIdentifier } from "../models/migrations/uuidMigration.js";

// Private snapshot for operator recovery. This never migrates or modifies rows.
// The connection file is private JSON containing the DB_* settings, not a CLI
// argument with credential values. Backup content must never be committed.
const [connectionFile, destination] = process.argv.slice(2);
if (!connectionFile || !destination) throw new Error("Usage: node scripts/backup-deployment-source.mjs <private-connection.json> <private-backup.jsonl.gz>");
const env = JSON.parse(await fs.readFile(connectionFile, "utf8"));
const connection = await mysql.createConnection(databaseConnectionOptions({ ...env, DB_SSL: "true", DB_SSL_STRICT: "true" }, env.DB_NAME));
const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
const gzip = createGzip();
gzip.pipe(output);
output.on("error", error => gzip.destroy(error));
const completed = finished(output);
// Attach a rejection handler immediately, preserving the rejection for await.
completed.catch(() => {});
const write = async data => {
  if (!gzip.write(JSON.stringify(data) + "\n")) await once(gzip, "drain");
};
const manifest = { version: 1, database: env.DB_NAME, complete: false, tables: {} };
try {
  await connection.query("SET time_zone = '+00:00'");
  await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const [tables] = await connection.query("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name");
  const [columns] = await connection.query("SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position");
  await write({ type: "header", version: 1, database: env.DB_NAME, columns, binaryEncoding: "base64 by binary column type" });
  for (const { table_name: table } of tables) {
    const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quoteIdentifier(table)}`);
    const ddl = definition["Create Table"];
    await write({ type: "schema", table, ddl });
    const [rows] = await connection.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    const tableColumns = columns.filter(column => column.table_name === table);
    const digest = { sum: 0n, count: 0 };
    for (const row of rows) {
      addRowDigest(digest, row, tableColumns);
      const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? { base64: value.toString("base64") } : value]));
      await write({ type: "row", table, values });
    }
    manifest.tables[table] = { rows: digest.count, digest: digest.sum.toString(16).padStart(64, "0"), ddlSha256: createHash("sha256").update(ddl).digest("hex") };
    console.log(`[Backup] ${table}: ${digest.count} rows`);
  }
  await connection.query("ROLLBACK");
  manifest.complete = true;
  await write({ type: "manifest", ...manifest });
  gzip.end();
  await completed;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  manifest.backupSha256 = hash.digest("hex");
  await fs.writeFile(`${destination}.manifest.json`, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ complete: true, tables: tables.length, rows: Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0), backupSha256: manifest.backupSha256 }));
} catch (error) {
  gzip.destroy();
  output.destroy();
  try { await connection.query("ROLLBACK"); } catch { /* preserve error */ }
  throw error;
} finally { await connection.end(); }
