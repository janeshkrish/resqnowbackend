import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { addRowDigest } from "../models/migrations/deploymentMigration.js";

const [filename] = process.argv.slice(2);
if (!filename) throw new Error("Usage: node scripts/verify-deployment-backup.mjs <private-backup.jsonl.gz>");
const saved = JSON.parse(await fs.readFile(`${filename}.manifest.json`, "utf8"));
if (!saved.complete || saved.version !== 1) throw new Error("Backup manifest is incomplete or unsupported.");
const hash = createHash("sha256");
for await (const chunk of createReadStream(filename)) hash.update(chunk);
if (hash.digest("hex") !== saved.backupSha256) throw new Error("Backup file SHA-256 does not match its manifest.");
const input = createReadStream(filename);
const gzip = createGunzip();
input.on("error", error => gzip.destroy(error));
const lines = createInterface({ input: input.pipe(gzip), crlfDelay: Infinity });
let header;
let embeddedManifest;
const states = new Map();
const binary = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit"]);
for await (const line of lines) {
  if (embeddedManifest) throw new Error("Unexpected records after backup completion.");
  const record = JSON.parse(line);
  if (record.type === "header") {
    if (header || record.version !== 1 || record.database !== saved.database) throw new Error("Invalid backup header.");
    header = record;
  } else if (record.type === "schema") {
    if (!header || states.has(record.table)) throw new Error("Invalid/duplicate table schema.");
    if (createHash("sha256").update(record.ddl).digest("hex") !== saved.tables[record.table]?.ddlSha256) throw new Error(`Backup DDL mismatch: ${record.table}`);
    states.set(record.table, { sum: 0n, count: 0 });
  } else if (record.type === "row") {
    if (!header || !states.has(record.table)) throw new Error("Row encountered without its schema.");
    const columns = header.columns.filter(column => column.table_name === record.table);
    const row = { ...record.values };
    for (const column of columns) {
      if (!Object.hasOwn(row, column.column_name)) throw new Error(`Missing backup column: ${record.table}.${column.column_name}`);
      const value = row[column.column_name];
      if (value != null && binary.has(column.data_type)) {
        if (typeof value.base64 !== "string") throw new Error("Invalid backup binary encoding.");
        row[column.column_name] = Buffer.from(value.base64, "base64");
      }
    }
    addRowDigest(states.get(record.table), row, columns);
  } else if (record.type === "manifest") {
    embeddedManifest = record;
  } else throw new Error("Unknown backup record type.");
}
if (!embeddedManifest?.complete || JSON.stringify(embeddedManifest.tables) !== JSON.stringify(saved.tables)) throw new Error("Embedded and external backup manifests disagree.");
if (states.size !== Object.keys(saved.tables).length) throw new Error("Backup table count mismatch.");
for (const [table, state] of states) {
  const expected = saved.tables[table];
  if (state.count !== expected.rows || state.sum.toString(16).padStart(64, "0") !== expected.digest) throw new Error(`Backup content verification failed: ${table}`);
}
console.log(JSON.stringify({ verified: true, tables: states.size, rows: [...states.values()].reduce((sum, state) => sum + state.count, 0), backupSha256: saved.backupSha256 }));
