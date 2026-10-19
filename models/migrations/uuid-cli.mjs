import "../../loadEnv.js";
import mysql from "mysql2/promise";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyUuidMigrationPlan, buildUuidMigrationPlan } from "./uuidMigration.js";
import { exportUuidDatabase } from "./uuidExport.js";
import { foreignKeySql } from "./uuidMigration.js";
import { consolidatedForeignKeys } from "./relationalRows.js";

// This entry point deliberately uses a raw connection: normal application inserts
// already use UUIDs, whereas this tool must read the old schema during cutover.
export async function runUuidMigration(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Plan (read only): npm run db:migrate:uuid -- --plan --plan-file <file.json>\nTiDB/portable export, writers stopped: npm run db:migrate:uuid -- --export <file.sql> --maintenance\nMySQL in-place apply, API/workers stopped: npm run db:migrate:uuid -- --apply --plan-file <file.json> --backup <verified-backup-file> --maintenance\nResume the same plan: add --resume to the apply command.\nThe plan, export and checkpoint contain private database data: keep them out of Git.");
    return;
  }
  const allowed = new Set(["--plan", "--apply", "--export", "--resume", "--maintenance", "--plan-file", "--backup"]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
    if (["--plan-file", "--backup", "--export"].includes(args[i])) {
      if (!args[++i] || args[i].startsWith("--")) throw new Error("Missing file argument.");
    }
  }
  const apply = args.includes("--apply");
  const exportData = args.includes("--export");
  if ([apply, exportData, args.includes("--plan")].filter(Boolean).length !== 1) throw new Error("Choose exactly one of --plan, --apply, or --export.");
  const argument = name => args[args.indexOf(name) + 1];
  if (!exportData && !args.includes("--plan-file")) throw new Error("Provide --plan-file <private-file.json>.");
  if (exportData && !args.includes("--maintenance")) throw new Error("Stop all writers and pass --maintenance before exporting a consistent snapshot.");
  const planPath = exportData ? null : path.resolve(argument("--plan-file"));
  const checkpointPath = `${planPath}.checkpoint.json`;
  if (apply) {
    if (!args.includes("--maintenance") || !args.includes("--backup")) throw new Error("Apply requires --maintenance (API/workers stopped) and --backup <verified-backup-file>.");
    const backup = await fs.stat(path.resolve(argument("--backup")));
    if (!backup.isFile() || backup.size === 0) throw new Error("The verified backup must be a nonempty file.");
  }
  for (const name of ["DB_HOST", "DB_USER", "DB_NAME"]) if (!process.env[name]) throw new Error(`${name} must be set explicitly.`);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD || "", database: process.env.DB_NAME,
    supportBigNumbers: true, bigNumberStrings: true,
    timezone: "Z", dateStrings: true,
    ...(process.env.DB_SSL === "true" || process.env.DB_SSL === "1" ? { ssl: { rejectUnauthorized: process.env.DB_SSL_STRICT === "true" } } : {}),
  });
  const digest = value => createHash("sha256").update(value).digest("hex");
  const atomicWrite = async (target, data) => {
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temporary, target);
  };
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [[database]] = await connection.query("SELECT DATABASE() AS database_name, @@hostname AS server_host, @@port AS server_port");
    if (exportData) {
      const target = path.resolve(argument("--export"));
      const output = await fs.open(target, "wx", 0o600);
      try {
        const plan = await buildUuidMigrationPlan(connection, { adminEmail: process.env.ADMIN_EMAIL || "" });
        const exportedCounts = await exportUuidDatabase(connection, plan, text => output.write(text));
        const keys = new Map();
        for (const fk of consolidatedForeignKeys(plan.metadata.foreignKeys)) {
          const name = `${fk.table_name}.${fk.constraint_name}`;
          if (!keys.has(name)) keys.set(name, []);
          keys.get(name).push(fk);
        }
        for (const rows of keys.values()) await output.write(`${foreignKeySql(rows)};\n`);
        const signature = value => JSON.stringify({ metadata: value.metadata, counts: value.counts, conversions: value.conversions, otp: value.otp });
        const after = await buildUuidMigrationPlan(connection, { adminEmail: plan.adminEmail });
        if (signature(after) !== signature(plan)) throw new Error("Source changed during export. Stop writers and export again.");
        await output.write("-- EXPORT COMPLETE. Verify row counts and relationships after restore.\n");
        await fs.writeFile(`${target}.manifest.json`, JSON.stringify({ database, exportedCounts, createdAt: new Date().toISOString() }, null, 2), { flag: "wx", mode: 0o600 });
        console.log(JSON.stringify({ mode: "export", file: target, tables: exportedCounts, next: "Restore into a separate empty database; verify counts/references, run bootstrap, then change DB_NAME and sign in again." }, null, 2));
      } finally { await output.close(); }
      return;
    }
    if (!apply) {
      const plan = await buildUuidMigrationPlan(connection, { adminEmail: process.env.ADMIN_EMAIL || "" });
      const text = JSON.stringify({ database, ...plan }, null, 2);
      await fs.writeFile(planPath, text, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ mode: "plan", planFile: planPath, sha256: digest(text), tables: plan.counts, rowsToConvert: plan.conversions.length, historicalAdminAccounts: plan.newUsers.length, removedTables: plan.metadata.tables.otp_rate_limits ? ["otp_rate_limits"] : [] }, null, 2));
      return;
    }
    const text = await fs.readFile(planPath, "utf8");
    const plan = JSON.parse(text);
    if (JSON.stringify(database) !== JSON.stringify(plan.database)) throw new Error("This plan belongs to another database/server.");
    const planSha256 = digest(text);
    let completed = [];
    if (args.includes("--resume")) {
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      if (checkpoint.planSha256 !== planSha256) throw new Error("Checkpoint belongs to a different plan.");
      completed = checkpoint.completed;
    } else {
      const current = await buildUuidMigrationPlan(connection, { adminEmail: plan.adminEmail });
      const signature = value => JSON.stringify({ metadata: value.metadata, counts: value.counts, newUsers: value.newUsers, conversions: value.conversions, otp: value.otp });
      if (signature(current) !== signature(plan)) throw new Error("Database changed after planning. Stop writers and generate a fresh plan.");
      await fs.writeFile(checkpointPath, JSON.stringify({ planSha256, completed }), { flag: "wx", mode: 0o600 });
    }
    const result = await applyUuidMigrationPlan(connection, plan, {
      completed: new Set(completed), checkpoint: async completed => atomicWrite(checkpointPath, { planSha256, completed }),
    });
    console.log(`UUID migration complete. ${result.tables} modeled tables; references and row counts verified. Restart the API/workers, clear old dispatch/tracking caches, and sign in again.`);
  } finally { await connection.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUuidMigration().catch(error => { console.error(error.message); process.exitCode = 1; });
}
