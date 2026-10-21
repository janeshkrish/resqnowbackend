import test from "node:test";
import assert from "node:assert/strict";
import { migrationConfiguration, needsDeploymentTransfer, prepareDeploymentDatabase } from "../models/migrations/deploymentMigration.js";
import { MODEL_TABLES, RETIRED_TABLES } from "../models/relationships.js";
import { TABLES } from "../models/schema/index.js";
import { migratedId, isUuid } from "../models/identifiers.js";
import { buildUuidMigrationPlan } from "../models/migrations/uuidMigration.js";
import { exportUuidDatabase } from "../models/migrations/uuidExport.js";
import { assertConsolidationColumns, consolidatedForeignKeys, transformRelationalRow } from "../models/migrations/relationalRows.js";
import { databaseReadiness } from "../middleware/databaseReadiness.js";
import { reviewedSourceConnection } from "../models/migrations/reviewedSource.js";

const env = { DB_HOST: "fixture.invalid", DB_PORT: "4000", DB_USER: "fixture", DB_NAME: "legacy", DB_MIGRATION_MAINTENANCE: "true", ADMIN_EMAIL: "ops@example.invalid" };
const stamp = "2026-10-15 09:00:00";
const clone = value => Buffer.isBuffer(value) ? Buffer.from(value) : Array.isArray(value) ? value.map(clone) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;

// Stateful SQL boundary double. It models separate databases, schema metadata,
// primary-key uniqueness, durable table comments, row data, and connection locks.
// It cannot certify TiDB's DDL syntax or permissions; a hosted rehearsal is required.
function cluster() {
  const databases = new Map();
  const calls = [];
  const state = { failTable: null, corruptTable: null, lockFailures: 0, loseLock: false, endCount: 0 };
  function table(ddl, rows = []) {
    const name = ddl.match(/CREATE TABLE(?: IF NOT EXISTS)? `?(\w+)/i)[1];
    const columns = ddl.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*`?(\w+)`?\s+(CHAR|VARCHAR|INT|BIGINT|TINYINT|BOOLEAN|TIMESTAMP|DATETIME|DECIMAL|FLOAT|DOUBLE|JSON|TEXT|LONGTEXT|LONGBLOB|BLOB|ENUM|SMALLINT)\b(\([^\n]*?\))?/i);
      if (!match) return [];
      const dataType = match[2].toLowerCase() === "boolean" ? "tinyint" : match[2].toLowerCase();
      const defaultMatch = line.match(/\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i);
      let defaultValue = defaultMatch?.[1] ?? null;
      if (defaultValue?.startsWith("'")) defaultValue = defaultValue.slice(1, -1);
      else if (/^false$/i.test(defaultValue)) defaultValue = "0";
      else if (/^true$/i.test(defaultValue)) defaultValue = "1";
      else if (/^null$/i.test(defaultValue)) defaultValue = null;
      return [{ table_name: name, column_name: match[1], data_type: dataType, column_type: match[2] + (match[3] || ""),
        is_nullable: /NOT NULL|PRIMARY KEY/i.test(line) ? "NO" : "YES", column_default: defaultValue,
        extra: /AUTO_INCREMENT/i.test(line) ? "auto_increment" : "", character_maximum_length: ["char", "varchar"].includes(dataType) ? Number(match[3]?.slice(1, -1)) : null }];
    });
    return { name, ddl, columns, rows: clone(rows), comment: ddl.match(/COMMENT='([^']+)'/)?.[1] || "", keys: [] };
  }
  function seed(database, name, fields, rows) {
    if (!databases.has(database)) databases.set(database, new Map());
    databases.get(database).set(name, table(`CREATE TABLE ${name} (\n${fields.map(field => `  ${field}`).join(",\n")}\n)`, rows));
  }
  seed("legacy", "users", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "full_name VARCHAR(255) NOT NULL", "email VARCHAR(255)", "is_verified BOOLEAN DEFAULT FALSE", "status VARCHAR(20) DEFAULT 'approved'", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
    [{ id: 1, full_name: "Customer", email: "customer@example.invalid", is_verified: 1, status: "approved", created_at: stamp }, { id: 2, full_name: "Admin", email: env.ADMIN_EMAIL, is_verified: 1, status: "approved", created_at: stamp }]);
  seed("legacy", "technicians", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "name VARCHAR(255) NOT NULL", "email VARCHAR(255) NOT NULL", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, name: "Technician", email: "technician@example.invalid", created_at: stamp }]);
  seed("legacy", "service_requests", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "user_id INT NOT NULL", "technician_id INT", "pricing_snapshot JSON", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 10, user_id: 1, technician_id: 1, pricing_snapshot: JSON.stringify({ request_id: 10, user_id: 1 }), created_at: stamp }]);
  databases.get("legacy").get("service_requests").keys.push({ table_name: "service_requests", constraint_name: "fk_request_user", column_name: "user_id", referenced_table_name: "users", referenced_column_name: "id", ordinal_position: 1, delete_rule: "RESTRICT", update_rule: "CASCADE" });
  seed("legacy", "files", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "data LONGBLOB", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 5, data: Buffer.from([0, 255, 39, 92, 10]), created_at: stamp }]);
  seed("legacy", "technician_admin_notes", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "technician_id INT NOT NULL", "admin_id VARCHAR(255) NOT NULL", "note_type VARCHAR(64)", "note_text TEXT", "metadata JSON", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, technician_id: 1, admin_id: env.ADMIN_EMAIL, note_type: "visibility", note_text: null, metadata: '{"isVisible":false}', created_at: stamp }]);
  seed("legacy", "admin_customer_notes", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "user_id INT NOT NULL", "admin_id VARCHAR(255) NOT NULL", "note TEXT", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, user_id: 1, admin_id: env.ADMIN_EMAIL, note: "Call before arrival", created_at: stamp }]);
  seed("legacy", "technician_approval_audit", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "technician_id INT NOT NULL", "admin_email VARCHAR(255) NOT NULL", "action VARCHAR(20)", "previous_status VARCHAR(50)", "new_status VARCHAR(50)", "reason TEXT", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, technician_id: 1, admin_email: "historical@example.invalid", action: "approved", previous_status: "pending", new_status: "approved", reason: "Documents checked", created_at: stamp }]);
  seed("legacy", "admin_audit_logs", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "adminId VARCHAR(255) NOT NULL", "actionType VARCHAR(255)", "targetId INT", "metadata JSON", "timestamp TIMESTAMP"], [{ id: 1, adminId: env.ADMIN_EMAIL, actionType: "PATCH:/requests/10", targetId: 10, metadata: JSON.stringify({ path: "/api/admin-extended/requests/10", params: { requestId: 10 }, statusCode: 200 }), timestamp: stamp }]);
  seed("legacy", "admin_actions_log", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "admin_id VARCHAR(255) NOT NULL", "action_type VARCHAR(255)", "target_type VARCHAR(120)", "target_id VARCHAR(120)", "metadata JSON", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, admin_id: env.ADMIN_EMAIL, action_type: "assign", target_type: "service_request", target_id: "10", metadata: JSON.stringify({ technicianId: 1 }), created_at: stamp }]);
  seed("legacy", "otp_requests", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "email VARCHAR(255)", "otp_hash VARCHAR(255)", "expires_at DATETIME", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], [{ id: 1, email: "pending@example.invalid", otp_hash: "old", expires_at: stamp, created_at: "2026-10-14 09:00:00" }, { id: 2, email: "pending@example.invalid", otp_hash: "latest", expires_at: stamp, created_at: stamp }]);
  seed("legacy", "otp_rate_limits", ["id INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "email VARCHAR(255)", "otp_request_count INT", "otp_last_request_time DATETIME", "otp_window_start_time DATETIME", "updated_at TIMESTAMP"], [{ id: 1, email: "pending@example.invalid", otp_request_count: 3, otp_last_request_time: stamp, otp_window_start_time: stamp, updated_at: stamp }]);

  const connect = async options => {
    let database = options.database;
    const current = () => databases.get(database);
    const conn = {
      end: async () => { state.endCount++; },
      async query(sql, params = []) {
        calls.push({ database, sql, params: clone(params) });
        if (/GET_LOCK/.test(sql)) return [[{ acquired: state.lockFailures-- > 0 ? 0 : 1 }]];
        if (/IS_USED_LOCK/.test(sql)) return [[{ owner: state.loseLock ? null : 7, connection_id: 7 }]];
        if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
        if (/FROM information_schema.schemata/.test(sql)) return [databases.has(params[0]) ? [{ schema_name: params[0] }] : []];
        if (/FROM information_schema.tables/.test(sql)) return [[...(databases.get(params[0]) || new Map()).values()].map(item => ({ table_name: item.name, table_comment: item.comment }))];
        if (/FROM information_schema.columns/.test(sql)) return [[...(databases.get(database || params[0]) || new Map()).values()].flatMap(item => clone(item.columns))];
        if (/FROM information_schema.key_column_usage/.test(sql)) return [[...current().values()].flatMap(item => clone(item.keys))];
        if (/SELECT VERSION/.test(sql)) return [[{ version: "8.0.11-TiDB-v8.5.0" }]];
        if (sql === "SELECT 1") return [[{ 1: 1 }]];
        const use = sql.match(/^USE `(\w+)`/);
        if (use) { database = use[1]; return [{}]; }
        if (/^(SET |START TRANSACTION|ROLLBACK)/.test(sql)) return [{}];
        if (/SELECT DATE_FORMAT/.test(sql)) return [[{ timestamp: stamp }]];
        const createDatabase = sql.match(/^CREATE DATABASE(?: IF NOT EXISTS)? `(\w+)`/);
        if (createDatabase) { if (!databases.has(createDatabase[1])) databases.set(createDatabase[1], new Map()); return [{}]; }
        if (/^CREATE TABLE/.test(sql)) { const item = table(sql); assert.equal(current().has(item.name), false); current().set(item.name, item); return [{}]; }
        const drop = sql.match(/^DROP TABLE `(\w+)`/);
        if (drop) { current().delete(drop[1]); return [{}]; }
        const alter = sql.match(/^ALTER TABLE `?(\w+)`? /);
        if (alter) {
          const item = current().get(alter[1]);
          if (/COMMENT=/.test(sql)) item.comment = sql.match(/COMMENT='([^']+)'/)[1];
          if (/DROP FOREIGN KEY/.test(sql)) item.keys = [];
          if (/ADD CONSTRAINT/.test(sql)) {
            const key = sql.match(/ADD CONSTRAINT `(\w+)` FOREIGN KEY \(`(\w+)`\) REFERENCES `(\w+)` \(`(\w+)`\) ON UPDATE (\w+) ON DELETE (\w+)/);
            item.keys.push({ table_name: item.name, constraint_name: key[1], column_name: key[2], referenced_table_name: key[3], referenced_column_name: key[4], ordinal_position: 1, update_rule: key[5], delete_rule: key[6] });
          }
          return [{}];
        }
        const show = sql.match(/^SHOW CREATE TABLE `(\w+)`/);
        if (show) return [[{ "Create Table": current().get(show[1]).ddl }]];
        const from = sql.match(/FROM `(\w+)`/);
        if (from && /^SELECT/.test(sql)) {
          let rows = current().get(from[1]).rows;
          const pagination = sql.match(/ORDER BY `?(\w+)`? LIMIT 100/);
          if (pagination) {
            const key = pagination[1];
            const hasCursor = /WHERE `?\w+`? > \?/.test(sql);
            const exclusions = /id NOT IN/.test(sql) ? params.slice(hasCursor ? 1 : 0).map(String) : [];
            rows = rows.filter(row => (!hasCursor || row[key] > params[0]) && !exclusions.includes(String(row.id)))
              .slice().sort((a, b) => a[key] < b[key] ? -1 : 1).slice(0, 100);
          }
          return [clone(rows)];
        }
        throw new Error(`Unsupported fixture query: ${sql}`);
      },
      async execute(sql, params) {
        calls.push({ database, sql, params: clone(params) });
        const insert = sql.match(/^INSERT INTO `(\w+)` \(([^)]+)\) VALUES /);
        assert.ok(insert, sql);
        if (state.failTable === insert[1]) { state.failTable = null; throw new Error("simulated copy interruption"); }
        const item = current().get(insert[1]);
        const names = [...insert[2].matchAll(/`(\w+)`/g)].map(match => match[1]);
        for (let offset = 0; offset < params.length; offset += names.length) {
          const row = Object.fromEntries(names.map((name, index) => [name, clone(params[offset + index])]));
          for (const column of item.columns.filter(column => column.data_type === "decimal" && row[column.column_name] != null)) {
            const scale = Number(column.column_type.match(/,\s*(\d+)\)/)?.[1] || 0);
            const [whole, fraction = ""] = String(row[column.column_name]).split(".");
            row[column.column_name] = whole + (scale ? `.${fraction.padEnd(scale, "0")}` : "");
          }
          assert.ok(!item.rows.some(existing => existing.id === row.id), "duplicate UUID");
          if (state.corruptTable === item.name) row[names.find(name => name !== "id")] = "CORRUPTED";
          item.rows.push(row);
        }
        return [{ affectedRows: params.length / names.length }];
      },
    };
    return conn;
  };
  return { databases, calls, state, connect, seed };
}

const run = (fixture, overrides = {}) => prepareDeploymentDatabase({ ...env, ...overrides }, { connect: fixture.connect, log() {} });

test("deployment configuration defaults to automatic, validates names, and can bypass database access", async () => {
  const config = migrationConfiguration(env);
  assert.equal(config.target, "legacy_relational_v2");
  assert.ok(config.lock.length <= 64);
  assert.throws(() => migrationConfiguration({ DB_NAME: "bad;DROP" }), /Unsafe/);
  assert.throws(() => migrationConfiguration({ DB_NAME: "same", DB_LEGACY_NAME: "same" }), /must differ/);
  assert.throws(() => migrationConfiguration({ DB_MIGRATION_MODE: "invalid" }), /auto or off/);
  const result = await prepareDeploymentDatabase({ DB_NAME: "isolated", DB_MIGRATION_MODE: "off" }, { connect() { throw new Error("unexpected connection"); } });
  assert.equal(result.database, "isolated");
});

test("automatic TiDB copy preserves source, relationships, merged histories, OTP state, and binary files", async () => {
  const fixture = cluster();
  const before = clone([...fixture.databases.get("legacy")]);
  const result = await run(fixture);
  assert.equal(result.migrated, true);
  assert.equal(result.tables, 42);
  const target = fixture.databases.get(result.database);
  assert.deepEqual([...target.keys()].sort(), [...MODEL_TABLES].sort());
  assert.ok(RETIRED_TABLES.every(name => !target.has(name)));
  assert.deepEqual(clone([...fixture.databases.get("legacy")]), before);
  assert.ok(fixture.calls.filter(call => call.database === "legacy").every(call => /^(SELECT|SHOW|SET|START|ROLLBACK)/.test(call.sql)));
  assert.equal(target.get("users").rows.length, 3);
  assert.ok(target.get("users").rows.every(row => isUuid(row.id)));
  const request = target.get("service_requests").rows[0];
  assert.equal(request.user_id, migratedId("users", 1));
  assert.equal(JSON.parse(request.pricing_snapshot).request_id, request.id);
  const notes = target.get("account_notes").rows;
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].id, notes[1].id);
  assert.ok(notes.some(row => row.user_id === request.user_id && row.note_text === "Call before arrival"));
  assert.ok(notes.some(row => row.technician_id === migratedId("technicians", 1) && row.note_text === null));
  const audits = target.get("admin_actions_log").rows;
  assert.deepEqual(audits.map(row => row.source).sort(), ["action", "approval", "http"]);
  assert.equal(new Set(audits.map(row => row.id)).size, 3);
  assert.ok(audits.some(row => row.reason === "Documents checked" && row.previous_status === "pending"));
  assert.equal(audits.find(row => row.source === "http").target_id, request.id);
  assert.deepEqual(target.get("files").rows[0].data, Buffer.from([0, 255, 39, 92, 10]));
  assert.equal(target.get("otp_requests").rows.length, 1);
  assert.equal(target.get("otp_requests").rows[0].otp_hash, "latest");
  assert.equal(target.get("otp_requests").rows[0].otp_request_count, 3);
  const history = JSON.parse(target.get("otp_requests").rows[0].migration_history);
  assert.equal(history.requests.length, 2);
  assert.equal(history.rate_limits.length, 1);
  assert.deepEqual(history.requests.map(row => row.otp_hash).sort(), ["latest", "old"]);
  assert.deepEqual(history.requests, fixture.databases.get("legacy").get("otp_requests").rows.map(row => ({ ...row, id: migratedId("otp_requests", row.id) })));
  assert.deepEqual(history.rate_limits, fixture.databases.get("legacy").get("otp_rate_limits").rows.map(row => ({ ...row, id: migratedId("otp_rate_limits", row.id) })));
  assert.ok(history.requests.every(row => isUuid(row.id)));
  assert.equal(result.preservedSourceRows.otp_requests, 2);
  assert.equal(target.get("service_requests").keys[0].update_rule, "CASCADE");
  assert.match(target.get("users").comment, /:ready$/);
  assert.equal(fixture.state.endCount, 2);
});

test("successful restart reuses the migrated database without overwriting new application records", async () => {
  const fixture = cluster();
  await run(fixture);
  const target = fixture.databases.get("legacy_relational_v2");
  target.get("users").rows.push({ id: migratedId("users", 999), full_name: "New live user" });
  const before = fixture.calls.length;
  const result = await run(fixture, { DB_MIGRATION_MAINTENANCE: "false" });
  assert.equal(result.reused, true);
  assert.equal(target.get("users").rows.length, 4);
  assert.ok(fixture.calls.slice(before).every(call => /^(SELECT|SHOW)/.test(call.sql)));
});

test("a slow binary read keeps the lock session alive and stops its heartbeat after migration", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fixture = cluster();
  let reading = false;
  let probed = false;
  let closed = false;
  const connect = async options => {
    const connection = await fixture.connect(options);
    const query = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      if (!options.database && /IS_USED_LOCK/.test(sql)) {
        if (closed) throw new Error("lock session expired during binary read");
        if (reading) probed = true;
      }
      if (options.database === "legacy" && /^SELECT \* FROM `files`.*LIMIT 100/.test(sql)) {
        reading = true;
        probed = false;
        t.mock.timers.tick(60000);
        await new Promise(setImmediate);
        closed = !probed;
        reading = false;
      }
      return query(sql, params);
    };
    return connection;
  };
  const result = await prepareDeploymentDatabase(env, { connect, log() {} });
  assert.equal(result.migrated, true);
  assert.deepEqual(fixture.databases.get(result.database).get("files").rows[0].data, Buffer.from([0, 255, 39, 92, 10]));
  const calls = fixture.calls.length;
  t.mock.timers.tick(60000);
  await new Promise(setImmediate);
  assert.equal(fixture.calls.length, calls);
});

test("lock loss detected during a slow binary read prevents subsequent target writes and activation", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const fixture = cluster();
  let writesAtLockLoss;
  const connect = async options => {
    const connection = await fixture.connect(options);
    const query = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      if (options.database === "legacy" && /^SELECT \* FROM `files`.*LIMIT 100/.test(sql)) {
        fixture.state.loseLock = true;
        writesAtLockLoss = fixture.calls.filter(call => /^(INSERT|CREATE|DROP|ALTER)/.test(call.sql)).length;
        t.mock.timers.tick(20000);
        await new Promise(setImmediate);
      }
      return query(sql, params);
    };
    return connection;
  };
  await assert.rejects(prepareDeploymentDatabase(env, { connect, log() {} }), /Lost database migration lock/);
  assert.equal(fixture.calls.filter(call => /^(INSERT|CREATE|DROP|ALTER)/.test(call.sql)).length, writesAtLockLoss);
  assert.match(fixture.databases.get("legacy_relational_v2").get("users").comment, /:copying$/);
});

test("full preservation retains legacy modules and orphan history with disabled, traceable historical identities", async () => {
  const fixture = cluster();
  const oldUsers = clone(fixture.databases.get("legacy").get("users").rows);
  fixture.seed("legacy", "users", ["id INT PRIMARY KEY", "full_name VARCHAR(255) NOT NULL", "email VARCHAR(255)", "is_verified BOOLEAN DEFAULT FALSE", "status VARCHAR(20)", "settings JSON", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"], oldUsers);
  fixture.seed("legacy", "technicians", ["id INT PRIMARY KEY", "name VARCHAR(255) NOT NULL", "email VARCHAR(255) NOT NULL", "status VARCHAR(20)", "is_active BOOLEAN DEFAULT TRUE", "is_available BOOLEAN DEFAULT TRUE", "settings JSON", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
    [{ id: 1, name: "Technician", email: "tech@example.invalid", status: "approved", is_active: 1, is_available: 1, settings: null, created_at: stamp }]);
  fixture.databases.get("legacy").get("service_requests").rows.push({ id: 11, user_id: "missing-legacy-customer", technician_id: 999, pricing_snapshot: null, created_at: stamp });
  fixture.seed("legacy", "vehicles", ["`id` INT NOT NULL PRIMARY KEY AUTO_INCREMENT", "`user_id` INT NOT NULL", "`vehicle_number` VARCHAR(64)"], [{ id: 7, user_id: 1, vehicle_number: "original plate" }]);
  fixture.seed("legacy", "technician_availability", ["`technician_id` INT NOT NULL PRIMARY KEY", "`is_available` BOOLEAN DEFAULT FALSE"], [{ technician_id: 1, is_available: 0 }]);
  const before = clone([...fixture.databases.get("legacy")]);
  const result = await prepareDeploymentDatabase(env, { connect: fixture.connect, log() {},
    planOptions: { preservedTables: ["vehicles", "technician_availability"], restoreMissingPrincipals: true } });
  const target = fixture.databases.get(result.database);
  assert.equal(result.tables, 44);
  assert.equal(result.preservedSourceRows.service_requests, 2);
  assert.equal(target.get("service_requests").rows.length, 2);
  assert.equal(target.get("vehicles").rows[0].id, 7);
  assert.equal(target.get("vehicles").rows[0].user_id, migratedId("users", 1));
  assert.equal(target.get("technician_availability").rows[0].technician_id, migratedId("technicians", 1));
  const customer = target.get("users").rows.find(row => row.id === migratedId("users", "missing-legacy-customer"));
  assert.equal(customer.is_verified, 0);
  assert.equal(customer.email, null);
  assert.equal(customer.status, "legacy_unresolved");
  assert.equal(JSON.parse(customer.settings).migration.state, "unresolved_historical_identity");
  const technician = target.get("technicians").rows.find(row => row.id === migratedId("technicians", 999));
  assert.equal(technician.status, "rejected");
  assert.equal(technician.is_active, 0);
  assert.equal(technician.is_available, 0);
  assert.match(technician.email, /@migration\.invalid$/);
  assert.deepEqual(clone([...fixture.databases.get("legacy")]), before);
});

test("restored identities verify against TiDB decimal defaults without rounding money or changing source digests", async () => {
  const fixture = cluster();
  fixture.seed("legacy", "technicians", ["id INT PRIMARY KEY", "name VARCHAR(255) NOT NULL", "email VARCHAR(255) NOT NULL", "base_price DECIMAL(30, 2) DEFAULT 1234567890123456789012345678.9", "rating DECIMAL(3, 2) DEFAULT 5.0", "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"],
    [{ id: 1, name: "Technician", email: "technician@example.invalid", base_price: "1234567890123456789012345678.90", rating: "5.00", created_at: stamp }]);
  fixture.databases.get("legacy").get("service_requests").rows[0].technician_id = 999;
  const before = clone([...fixture.databases.get("legacy")]);
  const result = await prepareDeploymentDatabase(env, { connect: fixture.connect, log() {}, planOptions: { restoreMissingPrincipals: true } });
  const rows = fixture.databases.get(result.database).get("technicians").rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.base_price === "1234567890123456789012345678.90" && row.rating === "5.00"));
  assert.deepEqual(clone([...fixture.databases.get("legacy")]), before);
  assert.equal(result.migrated, true);
});

test("a reviewed scope preserves excluded rows and legacy modules unchanged in the source while verifying the active target", async () => {
  const fixture = cluster();
  fixture.seed("legacy", "old_module", ["id INT PRIMARY KEY", "note TEXT"], [{ id: 1, note: "retained original history" }]);
  fixture.databases.get("legacy").get("service_requests").rows.push({ id: 11, user_id: 999, technician_id: 1, pricing_snapshot: null, created_at: stamp });
  const before = clone([...fixture.databases.get("legacy")]);
  const review = { unmodeledTablesRetainedInSource: ["old_module"], quarantinedRowsRetainedInSource: { service_requests: ["11"] } };
  const connect = async options => {
    const connection = await fixture.connect(options);
    return options.database === "legacy" ? reviewedSourceConnection(connection, review) : connection;
  };
  const result = await prepareDeploymentDatabase(env, { connect, log() {} });
  assert.equal(result.preservedSourceRows.service_requests, 1);
  assert.equal(fixture.databases.get(result.database).get("service_requests").rows.length, 1);
  assert.equal(fixture.databases.get(result.database).has("old_module"), false);
  assert.deepEqual(clone([...fixture.databases.get("legacy")]), before);
  assert.match(fixture.databases.get(result.database).get("users").comment, /:ready$/);
});

test("migration requires stopped writers and refuses to overwrite an unowned destination", async () => {
  const fixture = cluster();
  await assert.rejects(run(fixture, { DB_MIGRATION_MAINTENANCE: "false" }), /Stop old API/);
  assert.equal(fixture.databases.has("legacy_relational_v2"), false);
  fixture.seed("legacy_relational_v2", "users", ["id INT PRIMARY KEY"], [{ id: 77 }]);
  await assert.rejects(run(fixture), /unowned data/);
  assert.deepEqual(fixture.databases.get("legacy_relational_v2").get("users").rows, [{ id: 77 }]);
});

test("an interrupted copy leaves target unactivated and rebuilds only its owned staging tables on retry", async () => {
  const fixture = cluster();
  fixture.state.failTable = "account_notes";
  await assert.rejects(run(fixture), /simulated copy interruption/);
  assert.match(fixture.databases.get("legacy_relational_v2").get("users").comment, /:copying$/);
  const result = await run(fixture);
  assert.equal(result.counts.account_notes, 2);
  assert.equal(result.counts.admin_actions_log, 3);
  assert.ok(fixture.calls.some(call => call.database === result.database && /^DROP TABLE/.test(call.sql)));
  assert.equal(fixture.databases.get("legacy").get("users").rows[0].id, 1);
});

test("content corruption fails verification and never publishes the target", async () => {
  const fixture = cluster();
  fixture.state.corruptTable = "files";
  await assert.rejects(run(fixture), /content verification failed for files/);
  assert.match(fixture.databases.get("legacy_relational_v2").get("users").comment, /:copying$/);
});

test("lock contention retries, and lost ownership prevents target writes", async () => {
  const waiting = cluster();
  waiting.state.lockFailures = 2;
  await run(waiting);
  assert.equal(waiting.calls.filter(call => /GET_LOCK/.test(call.sql)).length, 3);
  const lost = cluster();
  lost.state.loseLock = true;
  await assert.rejects(run(lost), /Lost database migration lock/);
  assert.equal(lost.databases.has("legacy_relational_v2"), false);
  assert.equal(lost.state.endCount, 2);
});

test("current UUID schema needs no copy; an empty installation starts in its configured database", async () => {
  assert.equal(needsDeploymentTransfer([{ table_name: "users" }], [{ table_name: "users", column_name: "id", data_type: "char", character_maximum_length: 36 }]), false);
  assert.equal(needsDeploymentTransfer([{ table_name: "admin_actions_log" }], []), true);
  const fixture = cluster();
  fixture.databases.set("legacy", new Map());
  assert.equal((await run(fixture)).database, "legacy");
  assert.equal(fixture.databases.has("legacy_relational_v2"), false);
  assert.equal((await run(fixture, { DB_NAME: "brand_new" })).database, "brand_new");
});

test("unknown legacy columns and orphans stop preflight without writing target tables", async () => {
  const fixture = cluster();
  fixture.databases.get("legacy").get("service_requests").rows[0].user_id = 999;
  await assert.rejects(run(fixture), /orphan users reference/);
  assert.equal(fixture.databases.get("legacy_relational_v2").size, 0);
  assert.throws(() => assertConsolidationColumns({ metadata: { tables: { account_notes: [{ column_name: "custom_payload" }] } } }), /lossless/);
  assert.throws(() => transformRelationalRow({}, "account_notes", { id: "x", user_id: "u", technician_id: "t" }), /exactly one/);
});

test("portable export uses consolidated tables and preserves all distinct note and audit events", async () => {
  const fixture = cluster();
  const source = await fixture.connect({ database: "legacy" });
  const plan = await buildUuidMigrationPlan(source, { adminEmail: env.ADMIN_EMAIL });
  const chunks = [];
  const counts = await exportUuidDatabase(source, plan, text => chunks.push(text));
  const sql = chunks.join("");
  assert.equal(counts.account_notes, 2);
  assert.equal(counts.admin_actions_log, 3);
  assert.equal(counts.otp_requests, 1);
  for (const name of RETIRED_TABLES) assert.doesNotMatch(sql, new RegExp(`(?:CREATE TABLE|INSERT INTO) [\x60]?${name}\\b`));
  assert.match(sql, /Call before arrival/);
  assert.match(sql, /Documents checked/);
  assert.match(sql, /X'00ff275c0a'/i);
  assert.ok(MODEL_TABLES.every(name => TABLES[name].includes("CHAR(36)")));
});

test("consolidation remaps parent relationships and rejects conflicting deletion semantics", () => {
  const key = { table_name: "technician_admin_notes", constraint_name: "fk_owner", column_name: "technician_id", referenced_table_name: "technicians", referenced_column_name: "id", delete_rule: "CASCADE", update_rule: "RESTRICT" };
  assert.equal(consolidatedForeignKeys([key])[0].table_name, "account_notes");
  assert.throws(() => consolidatedForeignKeys([key, { ...key, table_name: "account_notes", delete_rule: "RESTRICT" }]), /Conflicting/);
});

test("copying more than one batch preserves every row exactly once", async () => {
  const fixture = cluster();
  const notes = fixture.databases.get("legacy").get("admin_customer_notes").rows;
  for (let id = 2; id <= 205; id++) notes.push({ ...notes[0], id, note: `Historical note ${id}` });
  const result = await run(fixture);
  const copied = fixture.databases.get(result.database).get("account_notes").rows;
  assert.equal(copied.length, 206);
  assert.equal(new Set(copied.map(row => row.id)).size, 206);
  assert.ok(copied.some(row => row.note_text === "Historical note 205"));
});

test("HTTP readiness allows probes but blocks API, webhooks and uploads until bootstrap completes", () => {
  const state = { ready: false };
  const guard = databaseReadiness(state);
  for (const path of ["/api/users", "/api/payments/razorpay/webhook", "/uploads/file.pdf", "/health", "/ready"]) {
    let passed = false;
    const response = { setHeader(name, value) { this[name] = value; }, status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
    guard({ path }, response, () => { passed = true; });
    assert.equal(passed, ["/health", "/ready"].includes(path));
    if (!passed) { assert.equal(response.code, 503); assert.equal(response["Retry-After"], "30"); }
  }
  state.ready = true;
  let passed = false;
  guard({ path: "/api/users" }, {}, () => { passed = true; });
  assert.equal(passed, true);
});
