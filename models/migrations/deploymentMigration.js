import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { TABLES } from "../schema/index.js";
import { MODEL_TABLES, RETIRED_TABLES } from "../relationships.js";
import { buildUuidMigrationPlan, foreignKeySql, quoteIdentifier } from "./uuidMigration.js";
import { consolidatedOtpRows, convertCreateTable } from "./uuidExport.js";
import { assertConsolidationColumns, consolidatedForeignKeys, consolidatedSchema, destinationTable, stripForeignKeys, transformRelationalRow } from "./relationalRows.js";
import { LEGACY_KEYS, migrationRowKey } from "./preservation.js";

const VERSION = 2;
const DIGEST_MODULUS = 1n << 256n;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const enabled = value => String(value || "").toLowerCase() === "true";
const sqlName = value => { quoteIdentifier(value); if (value.length > 64) throw new Error("Database names must fit 64 characters."); return value; };

export function migrationConfiguration(env) {
  const configured = sqlName(String(env.DB_NAME || "test").trim());
  const mode = String(env.DB_MIGRATION_MODE || "auto").trim().toLowerCase();
  if (!["auto", "off"].includes(mode)) throw new Error("DB_MIGRATION_MODE must be auto or off.");
  const source = sqlName(String(env.DB_LEGACY_NAME || configured).trim());
  const target = sqlName(String(env.DB_MIGRATION_TARGET || (env.DB_LEGACY_NAME ? configured :
    source.length <= 50 ? `${source}_relational_v2` : `${source.slice(0, 40)}_v2_${sha256(source).slice(0, 8)}`)).trim());
  if (env.DB_LEGACY_NAME && source === target) throw new Error("DB_LEGACY_NAME and DB_NAME must differ for a data transfer.");
  const lockIdentity = sha256(JSON.stringify([env.DB_HOST, String(env.DB_PORT || 4000), source, target, VERSION]));
  const identity = sha256(`${lockIdentity}:all-records-v1`);
  return { configured, source, target, mode, maintenance: enabled(env.DB_MIGRATION_MAINTENANCE),
    marker: `resqnow-relational-v${VERSION}:${identity}`, lock: `resqnow-migrate:${lockIdentity.slice(0, 40)}` };
}

export function databaseConnectionOptions(env, database) {
  return { host: env.DB_HOST || "localhost", port: Number(env.DB_PORT || 4000), user: env.DB_USER || "root",
    password: env.DB_PASSWORD || "", ...(database ? { database } : {}),
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, timezone: "Z", connectTimeout: 15000,
    enableKeepAlive: true,
    ...(enabled(env.DB_SSL) || env.DB_SSL === "1" ? { ssl: { rejectUnauthorized: env.DB_SSL_STRICT === "true" } } : {}),
  };
}

async function schemaTables(connection, name) {
  const [rows] = await connection.query(
    "SELECT table_name AS table_name, table_comment AS table_comment FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [name]
  );
  return rows;
}

async function exists(connection, name) {
  const [rows] = await connection.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?", [name]);
  return rows.length > 0;
}

async function columns(connection, database) {
  const [rows] = await connection.query(
    `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type,
            column_type AS column_type, is_nullable AS is_nullable, column_default AS column_default,
            extra AS extra, character_maximum_length AS character_maximum_length
     FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, [database]
  );
  return rows;
}

export function needsDeploymentTransfer(tableList, columnList) {
  if (tableList.some(table => RETIRED_TABLES.includes(table.table_name))) return true;
  if (columnList.some(column => column.column_name === "id" &&
    (column.data_type !== "char" || Number(column.character_maximum_length) !== 36))) return true;
  if (tableList.some(table => table.table_name === "otp_requests") &&
    !columnList.some(column => column.table_name === "otp_requests" && column.column_name === "migration_history")) return true;
  return tableList.some(table => table.table_name === "admin_actions_log") &&
    !columnList.some(column => column.table_name === "admin_actions_log" && column.column_name === "source");
}

function normalizedValue(value, column) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return { binary: value.toString("base64") };
  if (column.data_type === "json") {
    const object = typeof value === "string" ? JSON.parse(value) : value;
    const stable = input => Array.isArray(input) ? input.map(stable) : input && typeof input === "object"
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])])) : input;
    return stable(object);
  }
  if (["tinyint", "smallint", "mediumint", "int", "bigint"].includes(column.data_type)) return String(typeof value === "boolean" ? Number(value) : value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

// A multiset digest permits different source/UUID primary-key orders. Counts and
// individual key uniqueness are checked as well; no extra hash/mapping table.
export function addRowDigest(state, row, tableColumns) {
  const normalized = tableColumns.map(column => [column.column_name, normalizedValue(row[column.column_name], column)]);
  state.sum = (state.sum + BigInt(`0x${sha256(JSON.stringify(normalized))}`)) % DIGEST_MODULUS;
  state.count++;
}
const digestState = () => ({ sum: 0n, count: 0 });

function completeRow(row, tableColumns, timestamp) {
  const complete = {};
  for (const column of tableColumns) {
    const name = column.column_name;
    let value = row[name];
    if (value === undefined) {
      if (/^current_timestamp/i.test(String(column.column_default || ""))) value = timestamp;
      else value = column.column_default;
    }
    if (value == null && column.is_nullable === "NO") throw new Error(`Missing required migrated value ${column.table_name}.${name}`);
    complete[name] = column.data_type === "json" && value != null && typeof value !== "string" ? JSON.stringify(value) : value ?? null;
  }
  return complete;
}

async function insertBatch(target, table, rows, tableColumns) {
  if (!rows.length) return;
  const names = tableColumns.map(column => column.column_name);
  const tuple = `(${names.map(() => "?").join(",")})`;
  await target.execute(`INSERT INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(",")}) VALUES ${rows.map(() => tuple).join(",")}`,
    rows.flatMap(row => names.map(name => row[name])));
}

async function* sourceRows(source, table, preservedTables = []) {
  const keys = preservedTables.includes(table) ? LEGACY_KEYS[table] : ["id"];
  if (keys.length !== 1) {
    const [rows] = await source.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    if (rows.length) yield rows;
    return;
  }
  const key = keys[0];
  let cursor = null;
  for (;;) {
    const keySql = key === "id" ? "id" : quoteIdentifier(key);
    const [rows] = await source.query(`SELECT * FROM ${quoteIdentifier(table)} ${cursor == null ? "" : `WHERE ${keySql} > ?`} ORDER BY ${keySql} LIMIT 100`, cursor == null ? [] : [cursor]);
    if (!rows.length) return;
    yield rows;
    cursor = rows.at(-1)[key];
  }
}

function withMarker(sql, marker) {
  return sql.replace(/\s+COMMENT\s*=\s*'(?:[^'\\]|\\.|'')*'/ig, "") + ` COMMENT='${marker}:copying'`;
}

export async function transferDatabase({ source, target, control, config, env, assertLock, log = console.log, planOptions = {} }) {
  await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
  try {
    const plan = await buildUuidMigrationPlan(source, { adminEmail: env.ADMIN_EMAIL || "", ...planOptions });
    const preservedTables = (planOptions.preservedTables || []).filter(table => plan.metadata.tables[table]);
    const destinations = [...MODEL_TABLES, ...preservedTables];
    assertConsolidationColumns(plan);
    const sourceForeignKeys = consolidatedForeignKeys(plan.metadata.foreignKeys);
    if (Object.values(plan.metadata.tables).flat().some(column => /(?:VIRTUAL|STORED) GENERATED/i.test(column.extra || ""))) throw new Error("Generated columns need an explicit migration mapping before automatic transfer.");
    const sources = Object.keys(plan.metadata.tables);
    const definitions = new Map();
    // Preflight every schema before the first target write.
    for (const table of destinations) {
      let ddl = consolidatedSchema(table);
      if (!ddl && plan.metadata.tables[table]) {
        const [[schema]] = await source.query(`SHOW CREATE TABLE ${quoteIdentifier(table)}`);
        ddl = convertCreateTable(schema["Create Table"], table, plan.metadata.tables[table], plan.metadata.foreignKeys, { preserveIdentity: preservedTables.includes(table) });
      }
      definitions.set(table, stripForeignKeys(ddl || TABLES[table]));
    }
    await assertLock();
    const existing = await schemaTables(control, config.target);
    if (existing.some(table => !destinations.includes(table.table_name) || table.table_comment !== `${config.marker}:copying`)) {
      throw new Error("Migration target contains unowned or active tables; it will not be overwritten.");
    }
    // Only this migration's unpublished target can be rebuilt on retry.
    const [keys] = await target.query("SELECT table_name AS table_name, constraint_name AS constraint_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL GROUP BY table_name, constraint_name");
    for (const key of keys) await target.query(`ALTER TABLE ${quoteIdentifier(key.table_name)} DROP FOREIGN KEY ${quoteIdentifier(key.constraint_name)}`);
    for (const table of existing) {
      await assertLock();
      await target.query(`DROP TABLE ${quoteIdentifier(table.table_name)}`);
    }
    for (const table of destinations) {
      await assertLock();
      await target.query(withMarker(definitions.get(table), config.marker));
    }
    const targetColumns = await columns(control, config.target);
    const byTable = new Map(destinations.map(table => [table, targetColumns.filter(column => column.table_name === table)]));
    const expected = new Map(destinations.map(table => [table, digestState()]));
    const [[clock]] = await source.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS timestamp");
    const timestamp = clock.timestamp;
    const changes = new Map(plan.conversions.map(row => [`${row.table}:${row.oldId}`, row.changes]));
    let pending = [];
    let pendingBytes = 0;
    const append = async (table, input) => {
      const row = completeRow(input, byTable.get(table), timestamp);
      addRowDigest(expected.get(table), row, byTable.get(table));
      return row;
    };
    for (const table of destinations) {
      const flush = async () => { if (pending.length) { await assertLock(); await insertBatch(target, table, pending, byTable.get(table)); pending = []; pendingBytes = 0; } };
      const queue = async input => {
        const row = await append(table, input);
        const bytes = Object.values(row).reduce((sum, value) => sum + (Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ""))), 0);
        if (pending.length && (pending.length >= 100 || pendingBytes + bytes > 4 * 1024 * 1024)) await flush();
        pending.push(row); pendingBytes += bytes;
      };
      if (table === "otp_requests") {
        for (const row of consolidatedOtpRows(plan)) await queue(row);
      } else {
        for (const oldTable of sources.filter(oldTable => destinationTable(oldTable) === table)) {
          let count = 0;
          for await (const batch of sourceRows(source, oldTable, preservedTables)) {
            for (const original of batch) { await queue(transformRelationalRow(plan, oldTable, original, changes.get(`${oldTable}:${migrationRowKey(oldTable, original, preservedTables)}`))); count++; }
          }
          if (count !== plan.counts[oldTable]) throw new Error(`Snapshot row count mismatch for ${oldTable}`);
        }
        if (table === "users") {
          for (const principal of plan.newUsers) await queue({ id: principal.id, full_name: "Historical admin", email: principal.email, is_verified: 1, status: "approved" });
        }
        for (const principal of plan.restoredPrincipals || []) if (principal.table === table) await queue(principal.row);
      }
      await flush();
      log(`[DB migration] ${table}: copied ${expected.get(table).count} rows`);
    }
    for (const table of destinations) {
      const actual = digestState();
      for await (const batch of sourceRows(target, table, preservedTables)) for (const row of batch) addRowDigest(actual, row, byTable.get(table));
      const wanted = expected.get(table);
      if (actual.count !== wanted.count || actual.sum !== wanted.sum) throw new Error(`Migration content verification failed for ${table}`);
    }
    const keysToRestore = new Map();
    for (const fk of sourceForeignKeys) {
      const name = `${fk.table_name}.${fk.constraint_name}`;
      if (!keysToRestore.has(name)) keysToRestore.set(name, []);
      keysToRestore.get(name).push(fk);
    }
    for (const rows of keysToRestore.values()) { await assertLock(); await target.query(foreignKeySql(rows)); }
    const verified = await buildUuidMigrationPlan(target, { adminEmail: env.ADMIN_EMAIL || "", preservedTables });
    if (verified.conversions.length || verified.newUsers.length) throw new Error("Target UUID relationships or stored retry keys are incomplete.");
    await assertLock();
    await target.query(`ALTER TABLE users COMMENT='${config.marker}:ready'`);
    await source.query("ROLLBACK");
    return { database: config.target, migrated: true, tables: destinations.length,
      restoredPrincipals: plan.restoredPrincipals || [],
      preservedSourceRows: plan.counts,
      counts: Object.fromEntries([...expected].map(([table, state]) => [table, state.count])) };
  } catch (error) {
    try { await source.query("ROLLBACK"); } catch { /* keep original migration error */ }
    throw error;
  }
}

export async function prepareDeploymentDatabase(env = process.env, { connect = options => mysql.createConnection(options), log = console.log, planOptions = {} } = {}) {
  const config = migrationConfiguration(env);
  if (config.mode === "off") return { database: config.configured, migrated: false };
  const control = await connect(databaseConnectionOptions(env));
  let source;
  let target;
  let locked = false;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const [[lock]] = await control.query("SELECT GET_LOCK(?, 10) AS acquired", [config.lock]);
      if (Number(lock.acquired) === 1) { locked = true; break; }
      if (lock.acquired == null) throw new Error("Database migration lock could not be acquired.");
      log("[DB migration] waiting for another deployment to finish");
    }
    if (!locked) throw new Error("Another deployment still holds the database migration lock. Retry startup after it completes.");
    const assertLock = async () => {
      const [[owner]] = await control.query("SELECT IS_USED_LOCK(?) AS owner, CONNECTION_ID() AS connection_id", [config.lock]);
      if (String(owner.owner) !== String(owner.connection_id)) throw new Error("Lost database migration lock; target will not be activated.");
    };
    const targetTables = await schemaTables(control, config.target);
    if (targetTables.some(table => table.table_name === "users" && table.table_comment === `${config.marker}:ready`)) {
      return { database: config.target, migrated: false, reused: true, tables: MODEL_TABLES.length };
    }
    if (!(await exists(control, config.source))) {
      if (env.DB_LEGACY_NAME) throw new Error("DB_LEGACY_NAME does not exist.");
      await control.query(`CREATE DATABASE ${quoteIdentifier(config.source)} CHARACTER SET utf8mb4`);
      return { database: config.source, migrated: false };
    }
    const sourceTables = await schemaTables(control, config.source);
    if (!sourceTables.length && !env.DB_LEGACY_NAME) return { database: config.source, migrated: false };
    const sourceColumns = await columns(control, config.source);
    if (!env.DB_LEGACY_NAME && !needsDeploymentTransfer(sourceTables, sourceColumns)) return { database: config.source, migrated: false };
    if (!config.maintenance) throw new Error("Automatic TiDB transfer is required. Stop old API/worker writers and set DB_MIGRATION_MAINTENANCE=true for the first deployment; original data will be preserved in DB_NAME/DB_LEGACY_NAME.");
    if (config.source === config.target) throw new Error("Source and target databases must differ.");
    const allowedTables = [...MODEL_TABLES, ...(planOptions.preservedTables || [])];
    if (targetTables.some(table => !allowedTables.includes(table.table_name) || table.table_comment !== `${config.marker}:copying`)) throw new Error("Migration target contains unowned data; choose an empty DB_MIGRATION_TARGET.");
    source = await connect(databaseConnectionOptions(env, config.source));
    // A new empty target database is reversible; source data is never changed.
    await assertLock();
    await control.query(`CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(config.target)} CHARACTER SET utf8mb4`);
    // The lock and every target write use the SAME session. If the session dies,
    // it cannot keep writing after a different replica acquires its released lock.
    await control.query(`USE ${quoteIdentifier(config.target)}`);
    target = control;
    await source.query("SET time_zone = '+00:00'");
    await target.query("SET time_zone = '+00:00'");
    log(`[DB migration] transferring ${config.source} -> ${config.target}; API remains unready`);
    return await transferDatabase({ source, target, control, config, env, assertLock, log, planOptions });
  } finally {
    if (source) await Promise.allSettled([source.end()]);
    if (locked) { try { await control.query("SELECT RELEASE_LOCK(?)", [config.lock]); } catch { /* closed connections release their lock */ } }
    await control.end();
  }
}
