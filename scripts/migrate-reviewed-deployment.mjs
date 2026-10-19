import dotenv from "dotenv";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { addRowDigest, databaseConnectionOptions, prepareDeploymentDatabase } from "../models/migrations/deploymentMigration.js";
import { buildUuidMigrationPlan, quoteIdentifier } from "../models/migrations/uuidMigration.js";
import { assertConsolidationColumns } from "../models/migrations/relationalRows.js";
import { reviewedSourceConnection } from "../models/migrations/reviewedSource.js";
import { LEGACY_KEYS } from "../models/migrations/preservation.js";

dotenv.config();
const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (["--all-records", "--apply", "--writers-stopped", "--help"].includes(flag)) flags.set(flag, true);
  else if (["--connection", "--review", "--backup-manifest", "--review-sha", "--backend-url", "--result"].includes(flag) && args[i + 1] && !args[i + 1].startsWith("--")) flags.set(flag, args[++i]);
  else throw new Error(`Invalid argument: ${flag}`);
}
if (flags.has("--help")) {
  console.log("Read-only by default. --all-records --connection <private JSON> --backup-manifest <private backup manifest JSON>. To apply, additionally require --apply --writers-stopped --review-sha <rehearsed SHA256> --backend-url <maintenance API URL> --result <new private result file>. No source records or modules are excluded. See docs/railway-tidb-deployment.md.");
  process.exit(0);
}
for (const flag of ["--connection", "--backup-manifest"]) if (!flags.has(flag)) throw new Error(`Missing ${flag}`);
const backup = JSON.parse(await fs.readFile(flags.get("--backup-manifest"), "utf8"));
const fullCounts = Object.fromEntries(Object.entries(backup.tables).map(([table, info]) => [table, info.rows]));
const planOptions = flags.has("--all-records") ? { preservedTables: Object.keys(LEGACY_KEYS), restoreMissingPrincipals: true } : {};
const fullReview = { database: backup.database, mode: "full-preservation", sourceCounts: fullCounts, eligibleSourceCounts: fullCounts,
  unmodeledTablesRetainedInSource: [], quarantinedRowsRetainedInSource: {}, planOptions, backupSha256: backup.backupSha256 };
if (flags.has("--apply") && !flags.has("--all-records")) throw new Error("Row-excluding migrations are disabled. Use --all-records to retain every record in the destination.");
const rawReview = flags.has("--all-records") ? JSON.stringify(fullReview) : await fs.readFile(flags.get("--review"), "utf8");
const reviewSha256 = createHash("sha256").update(rawReview).digest("hex");
const review = JSON.parse(rawReview);
const connectionEnv = JSON.parse(await fs.readFile(flags.get("--connection"), "utf8"));
const env = { ...process.env, ...connectionEnv, DB_SSL: "true", DB_SSL_STRICT: "true", DB_MIGRATION_MODE: "auto" };
if (!backup.complete || backup.version !== 1 || backup.database !== env.DB_NAME || review.database !== env.DB_NAME) throw new Error("Backup, review and connection database identities must match.");
const expectedCounts = Object.fromEntries(Object.entries(backup.tables).map(([table, info]) => [table, info.rows]));
const sameCounts = (left, right) => JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
if (!sameCounts(expectedCounts, review.sourceCounts)) throw new Error("Review counts do not match the complete source backup.");
const requireMaintenance = async () => {
  const api = new URL(flags.get("--backend-url"));
  if (api.protocol !== "https:" || api.username || api.password) throw new Error("Maintenance API must use HTTPS without embedded credentials.");
  const response = await fetch(new URL("/health", api), { signal: AbortSignal.timeout(20000), cache: "no-store" });
  const status = await response.json();
  if (!response.ok || status.maintenance !== true) throw new Error("Railway API is not in maintenance. Stop all old writers before applying.");
};
if (flags.has("--apply")) {
  if (!flags.has("--writers-stopped") || flags.get("--review-sha") !== reviewSha256 || !flags.has("--backend-url") || !flags.has("--result")) throw new Error("Apply requires stopped writers, the exact approved review hash, a maintenance API URL and a new private result file.");
  await requireMaintenance();
  // Reserve the result path before any database writes, never overwrite evidence.
  const reservation = await fs.open(flags.get("--result"), "wx", 0o600);
  await reservation.close();
}
const source = await mysql.createConnection(databaseConnectionOptions(env, env.DB_NAME));
try {
  await source.query("SET time_zone = '+00:00'");
  await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  const [tables] = await source.query("SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name");
  if (JSON.stringify(tables.map(row => row.table_name)) !== JSON.stringify(Object.keys(backup.tables))) throw new Error("Source table inventory changed after backup.");
  const [columns] = await source.query("SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position");
  for (const { table_name: table } of tables) {
    const [[definition]] = await source.query(`SHOW CREATE TABLE ${quoteIdentifier(table)}`);
    const expected = backup.tables[table];
    if (createHash("sha256").update(definition["Create Table"]).digest("hex") !== expected.ddlSha256) throw new Error(`Source schema changed after backup: ${table}`);
    const [rows] = await source.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    const digest = { sum: 0n, count: 0 };
    const tableColumns = columns.filter(column => column.table_name === table);
    for (const row of rows) addRowDigest(digest, row, tableColumns);
    if (digest.count !== expected.rows || digest.sum.toString(16).padStart(64, "0") !== expected.digest) throw new Error(`Source content changed after backup: ${table}`);
    console.log(`[Preflight] ${table}: schema and ${digest.count} source rows match backup`);
  }
  const plan = await buildUuidMigrationPlan(flags.has("--all-records") ? source : reviewedSourceConnection(source, review), { adminEmail: env.ADMIN_EMAIL || "", ...planOptions });
  assertConsolidationColumns(plan);
  if (!sameCounts(plan.counts, review.eligibleSourceCounts)) throw new Error("Eligible migration counts changed after review.");
  console.log(JSON.stringify({ sourceVerifiedAgainstBackup: true, reviewSha256, eligibleSourceRows: Object.values(plan.counts).reduce((sum, count) => sum + count, 0),
    archiveOnlyTables: review.unmodeledTablesRetainedInSource.length, archiveRowCounts: Object.fromEntries(Object.entries(review.quarantinedRowsRetainedInSource).map(([table, ids]) => [table, ids.length])),
    fullPreservation: flags.has("--all-records"), restoredHistoricalIdentities: plan.restoredPrincipals.length }));
  if (flags.has("--all-records")) await fs.writeFile("uuid-migration-private/full-preservation-review.json", JSON.stringify({ ...fullReview, reviewSha256, restoredPrincipals: plan.restoredPrincipals }, null, 2));
  await source.query("ROLLBACK");
} finally { await source.end(); }
if (flags.has("--apply")) {
  await requireMaintenance();
  const result = await prepareDeploymentDatabase({ ...env, DB_MIGRATION_MAINTENANCE: "true" }, {
    connect: async options => {
      const connection = await mysql.createConnection(options);
      return !flags.has("--all-records") && options.database === env.DB_NAME ? reviewedSourceConnection(connection, review) : connection;
    },
    planOptions,
  });
  const evidence = { ...result, originalDatabaseRetained: env.DB_NAME, backupSha256: backup.backupSha256, reviewSha256,
    fullPreservation: flags.has("--all-records"), archiveOnlyTables: review.unmodeledTablesRetainedInSource, archivedRowIds: review.quarantinedRowsRetainedInSource };
  await fs.writeFile(flags.get("--result"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ database: result.database, migrated: result.migrated, reused: result.reused || false, originalDatabaseRetained: env.DB_NAME, reviewSha256 }));
}
