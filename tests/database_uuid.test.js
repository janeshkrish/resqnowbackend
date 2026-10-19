import assert from "node:assert/strict";
import test from "node:test";
import { createId, isUuid, migratedId, recordId } from "../models/identifiers.js";
import { prepareUuidInsert, withUuidPersistence, assertUuidSchema } from "../models/persistence.js";
import { TABLES } from "../models/schema/index.js";
import { buildUuidMigrationPlan, applyUuidMigrationPlan, migrateJsonIds } from "../models/migrations/uuidMigration.js";
import { consolidatedOtpRows, convertCreateTable, convertedRow, insertSql } from "../models/migrations/uuidExport.js";
import { markTechnicianReserved } from "../services/technicianStateService.js";
import { enforceOtpRateLimit } from "../models/otp.js";
import { ensureAdminIdentity } from "../models/userIdentity.js";
import { compactPaymentReceipt, boundedIdempotencyKey } from "../utils/paymentReference.js";
import { referenceTarget } from "../models/relationships.js";
import { buildDispatchPricingSnapshot, readDispatchPricingSnapshot } from "../services/dispatchPricingService.js";

const USER = "d9695b75-b6cc-432a-944e-5ca18fb26121";
const TECH = "8773c7fa-7491-43b1-a447-ae9ba4186f74";
const REQUEST = "429f0845-8772-4f24-8862-a94ed05f9772";

test("every active table has a UUID primary key; external provider IDs and counters retain their types", () => {
  assert.equal(Object.keys(TABLES).length, 42);
  assert.equal(TABLES.otp_rate_limits, undefined);
  for (const [table, sql] of Object.entries(TABLES)) {
    assert.match(sql, /\bid CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY/, table);
    assert.doesNotMatch(sql, /AUTO_INCREMENT/, table);
    assert.doesNotMatch(sql, /\b(?:user_id|technician_id|request_id|service_request_id|wallet_id|payment_id) (?:INT|BIGINT)\b/, table);
  }
  assert.match(TABLES.users, /google_id VARCHAR\(255\)/);
  assert.match(TABLES.payments, /razorpay_payment_id VARCHAR\(255\)/);
  assert.match(TABLES.technician_location_history, /sequence_id BIGINT/);
  assert.match(TABLES.otp_requests, /otp_request_count INT/);
});

test("UUID generation and stable migration mappings keep different entity IDs distinct", () => {
  const ids = new Set(Array.from({ length: 1000 }, createId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.ok(isUuid(id));
  assert.equal(migratedId("users", 7), migratedId("users", "7"));
  assert.notEqual(migratedId("users", 7), migratedId("technicians", 7));
  assert.equal(migratedId("users", USER), USER);
  assert.equal(recordId(USER.toUpperCase()), USER);
  assert.equal(recordId("not-an-id"), null);
  assert.equal(recordId(true), null);
});

test("single INSERTs bind their UUID ahead of existing values and expose it as insertId", async () => {
  const calls = [];
  const raw = { execute: async (...args) => { calls.push(args); return [{ affectedRows: 1, insertId: 0 }]; } };
  const pool = withUuidPersistence(raw);
  const [result] = await pool.execute("INSERT INTO users (full_name, email) VALUES (?, ?)", ["Customer", "customer@example.invalid"]);
  assert.ok(isUuid(result.insertId));
  assert.match(calls[0][0], /\(id, full_name, email\) VALUES \(\?, \?, \?\)/);
  assert.deepEqual(calls[0][1], [result.insertId, "Customer", "customer@example.invalid"]);
  assert.equal(withUuidPersistence(pool), pool);
});

test("bulk INSERT tuples and nested SQL functions preserve parameter order", () => {
  const ids = [USER, TECH];
  const prepared = prepareUuidInsert(
    "INSERT INTO notifications (title, message, created_at) VALUES (?, CONCAT('?,)', ?), NOW()), (?, ?, NOW()) ON DUPLICATE KEY UPDATE title = ?",
    ["first", "message", "second", "other", "replacement"], () => ids.shift()
  );
  assert.deepEqual(prepared.values, [USER, "first", "message", TECH, "second", "other", "replacement"]);
  assert.match(prepared.sql, /VALUES \(\?, \?, CONCAT/);
  const rows = prepareUuidInsert("INSERT INTO fuel_prices (state_key, price) VALUES ? ON DUPLICATE KEY UPDATE price = VALUES(price)", [[['tn', 100], ['ka', 101]]]);
  assert.equal(rows.values[0].length, 2);
  assert.ok(rows.values[0].every(row => isUuid(row[0]) && row.length === 3));
  assert.notEqual(rows.values[0][0][0], rows.values[0][1][0]);
});

test("transactions use the same UUID insertion path and never invent an upsert ID", async () => {
  let values;
  let released = false;
  const raw = { query: async (_sql, params) => { values = params; return [{ affectedRows: 1, insertId: 0 }]; }, release() { released = true; } };
  const pool = withUuidPersistence({ getConnection: async () => raw });
  const conn = await pool.getConnection();
  const [inserted] = await conn.query("INSERT INTO service_requests (user_id, service_type) VALUES (?, ?)", [USER, "car-battery"]);
  assert.equal(values[0], inserted.insertId);
  assert.equal(values[1], USER);
  const [upserted] = await conn.query("INSERT INTO email_templates (event_type, subject, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)", ["EVENT", "subject", "content"]);
  assert.equal(upserted.insertId, 0);
  conn.release();
  assert.equal(released, true);
  assert.throws(() => prepareUuidInsert("INSERT INTO users (id, email) VALUES (?, ?)", [1, "x"]), /omit id/);
  assert.throws(() => prepareUuidInsert("INSERT INTO unmodeled (name) VALUES (?)", ["x"]), /modeled table/);
});

test("startup refuses numeric schemas and interrupted UUID conversions", async () => {
  await assert.rejects(assertUuidSchema({ query: async () => [[{ table_name: "users", column_name: "id", data_type: "int", character_maximum_length: null }]] }), /migration required/);
  let queries = 0;
  await assert.rejects(assertUuidSchema({ query: async () => ++queries === 1
    ? [[{ table_name: "users", column_name: "id", data_type: "char", character_maximum_length: 36 }]] : [[{ id: "7" }]] }), /Incomplete UUID migration/);
});

function migrationDatabase({ extra = {}, engine = "8.0.36" } = {}) {
  const data = {
    users: [{ id: 1, email: "customer@example.invalid" }],
    service_requests: [{ id: 10, user_id: 1, pricing_snapshot: { request_id: 10, userId: 1 }, updated_at: "2026-01-01 00:00:00" }],
    ...extra,
  };
  const metadata = Object.entries(data).flatMap(([table, rows]) => [...new Set(rows.flatMap(Object.keys))].map(column => ({
    table_name: table, column_name: column, data_type: column === "id" || column.endsWith("_id") ? "int" :
      ["pricing_snapshot", "metadata"].includes(column) ? "json" : "varchar",
    column_type: column === "id" ? "int" : "varchar(255)", is_nullable: column === "id" ? "NO" : "YES",
    column_default: null, extra: column === "id" ? "auto_increment" : "", character_maximum_length: null,
  })));
  let fks = [{ table_name: "service_requests", constraint_name: "fk_request_user", column_name: "user_id", referenced_table_name: "users", referenced_column_name: "id", ordinal_position: 1, update_rule: "RESTRICT", delete_rule: "RESTRICT" }];
  let failNextUpdate = false;
  const statements = [];
  const connection = {
    query: async (sql) => {
      statements.push(sql);
      if (/SELECT VERSION/.test(sql)) return [[{ version: engine }]];
      if (/FROM information_schema.columns/.test(sql)) return [structuredClone(metadata)];
      if (/FROM information_schema.key_column_usage/.test(sql)) return [structuredClone(fks)];
      if (/FROM information_schema.table_constraints/.test(sql)) return [[]];
      if (/DROP FOREIGN KEY/.test(sql)) { fks = []; return [{}]; }
      if (/ADD CONSTRAINT/.test(sql)) { fks = [{ table_name: "service_requests", constraint_name: "fk_request_user", column_name: "user_id", referenced_table_name: "users", referenced_column_name: "id", ordinal_position: 1, update_rule: "RESTRICT", delete_rule: "RESTRICT" }]; return [{}]; }
      const modify = sql.match(/ALTER TABLE `(\w+)` MODIFY COLUMN `(\w+)`/);
      if (modify) { const column = metadata.find(item => item.table_name === modify[1] && item.column_name === modify[2]); column.data_type = "char"; column.character_maximum_length = 36; return [{}]; }
      const from = sql.match(/FROM `(\w+)`/);
      if (from && /COUNT\(\*\)/.test(sql)) return [[{ count: data[from[1]].length }]];
      if (from && /^SELECT/.test(sql)) return [structuredClone(data[from[1]])];
      throw new Error(`Unexpected migration query ${sql}`);
    },
    execute: async (sql, params) => {
      statements.push(sql);
      if (failNextUpdate) { failNextUpdate = false; throw new Error("simulated interruption"); }
      const table = sql.match(/^UPDATE `(\w+)`/)[1];
      const row = data[table].find(row => [params.at(-2), params.at(-1)].includes(String(row.id)));
      const columns = [...sql.matchAll(/`(\w+)` = \?/g)].map(match => match[1]);
      if (row) columns.forEach((column, index) => { row[column] = params[index]; });
      return [{ affectedRows: row ? 1 : 0 }];
    },
  };
  return { connection, data, statements, interrupt: () => { failNextUpdate = true; } };
}

test("migration plans deterministic keys, foreign keys and nested snapshots without writes", async () => {
  const db = migrationDatabase();
  const plan = await buildUuidMigrationPlan(db.connection);
  const user = plan.conversions.find(row => row.table === "users");
  const request = plan.conversions.find(row => row.table === "service_requests");
  assert.equal(request.changes.user_id, user.newId);
  assert.equal(JSON.parse(request.changes.pricing_snapshot).request_id, request.newId);
  assert.equal(db.data.users[0].id, 1);
  assert.ok(db.statements.every(sql => /^SELECT/.test(sql)));
});

test("migration refuses orphans and blocks unsupported TiDB ALTER before writing", async () => {
  const orphan = migrationDatabase({ extra: { service_requests: [{ id: 10, user_id: 99 }] } });
  await assert.rejects(buildUuidMigrationPlan(orphan.connection), /orphan users reference 99/);
  const tidb = migrationDatabase({ engine: "8.0.11-TiDB-v8.1.0" });
  const plan = await buildUuidMigrationPlan(tidb.connection);
  assert.equal(plan.inPlaceSupported, false);
  const before = tidb.statements.length;
  await assert.rejects(applyUuidMigrationPlan(tidb.connection, plan), /Use --export/);
  assert.equal(tidb.statements.length, before);
});

test("in-place migration refuses OTP consolidation before any rows can be retired", async () => {
  const fixture = migrationDatabase({ extra: { otp_requests: [{ id: 3, email: "pending@example.invalid", otp_hash: "original", created_at: "2026-01-01" }] } });
  const plan = await buildUuidMigrationPlan(fixture.connection);
  const before = fixture.statements.length;
  await assert.rejects(applyUuidMigrationPlan(fixture.connection, plan), /preserve every OTP/);
  assert.equal(fixture.statements.length, before);
  assert.equal(fixture.data.otp_requests[0].otp_hash, "original");
});

test("an interrupted migration resumes, preserves timestamps and restores constraints", async () => {
  const db = migrationDatabase();
  const plan = await buildUuidMigrationPlan(db.connection);
  let completed = [];
  db.interrupt();
  await assert.rejects(applyUuidMigrationPlan(db.connection, plan, { checkpoint: async value => { completed = value; } }), /simulated interruption/);
  assert.ok(completed.includes("drop-fk:service_requests.fk_request_user"));
  await applyUuidMigrationPlan(db.connection, plan, { completed: new Set(completed) });
  assert.ok(isUuid(db.data.users[0].id));
  assert.equal(db.data.service_requests[0].user_id, db.data.users[0].id);
  assert.equal(db.data.service_requests[0].updated_at, "2026-01-01 00:00:00");
  assert.ok(db.statements.some(sql => /updated_at = updated_at/.test(sql)));
  assert.ok(db.statements.some(sql => /ADD CONSTRAINT.*ON DELETE RESTRICT/.test(sql)));
  assert.deepEqual((await buildUuidMigrationPlan(db.connection)).conversions, []);
});

test("portable export preserves blobs, snapshots, every OTP history row and current throttle state", () => {
  const plan = { otp: { requests: [
    { id: 1, email: "new@example.invalid", otp_hash: "old", created_at: "2026-01-01" },
    { id: 10, email: "new@example.invalid", otp_hash: "latest", created_at: "2026-01-02" },
    { id: 2, email: "new@example.invalid", otp_hash: "older-in-same-second", created_at: "2026-01-02" },
  ], limits: [{ email: "new@example.invalid", otp_request_count: 3, otp_last_request_time: "2026-01-02", otp_window_start_time: "2026-01-02" }] } };
  const rows = consolidatedOtpRows(plan);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].otp_hash, "latest");
  assert.equal(rows[0].otp_request_count, 3);
  assert.ok(isUuid(rows[0].id));
  assert.equal(rows[0].id, migratedId("otp_requests", 10));
  assert.equal(rows[0].migration_history.requests.length, 3);
  assert.deepEqual(rows[0].migration_history.requests.map(row => row.otp_hash).sort(), ["latest", "old", "older-in-same-second"]);
  assert.equal(rows[0].migration_history.rate_limits.length, 1);
  const [recopied] = consolidatedOtpRows({ otp: { requests: [rows[0]], limits: [] } });
  assert.deepEqual(recopied, rows[0]);
  const [throttleOnly] = consolidatedOtpRows({ otp: { requests: [], limits: [{ email: "throttle@example.invalid", created_at: "2026-01-01", updated_at: "2026-01-02" }] } });
  assert.equal(throttleOnly.created_at, "2026-01-01");
  assert.equal(throttleOnly.updated_at, "2026-01-02");
  const sql = insertSql("files", { id: USER, content: Buffer.from([0, 255, 1]), filename: "a'b.jpg" });
  assert.match(sql, /X'00ff01'/);
  assert.match(sql, /a\\'b/);
  const row = convertedRow({}, "files", { id: 7, content: Buffer.from([5]) }, new Map([["7", { id: USER }]]));
  assert.deepEqual(row.content, Buffer.from([5]));
  const ddl = convertCreateTable("CREATE TABLE `users` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `email` varchar(255),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42", "users", [{ column_name: "id", is_nullable: "NO" }, { column_name: "email" }], []);
  assert.match(ddl, /`id` CHAR\(36\)/);
  assert.doesNotMatch(ddl, /AUTO_INCREMENT/);
});

test("UUID request reservations and accepted prices preserve their owners", async () => {
  const queries = [];
  const conn = { query: async (sql, params) => {
    queries.push([sql, params]);
    if (/FROM technicians/.test(sql)) return [[{ id: TECH, status: "approved", is_active: 1, is_available: 1, current_job_id: null }]];
    if (/SELECT id FROM service_requests/.test(sql)) return [[]];
    if (/SELECT \* FROM service_requests/.test(sql)) return [[{ id: REQUEST, user_id: USER, service_type: "car-battery" }]];
    return [{ affectedRows: 1 }];
  } };
  assert.equal(await markTechnicianReserved(conn, TECH, REQUEST), true);
  assert.ok(queries.some(([sql, params]) => /UPDATE technicians/.test(sql) && params[0] === REQUEST && params[1] === TECH));
  const snapshot = await buildDispatchPricingSnapshot({ request: { id: REQUEST, user_id: USER, service_type: "car-battery", payment_method: "cash" },
    technicianId: TECH, connection: conn, estimateEarning: async () => ({ amount: 300, source: "technician_pricing" }) });
  assert.equal(snapshot.request_id, REQUEST);
  assert.equal(snapshot.technician_id, TECH);
  assert.ok(readDispatchPricingSnapshot(snapshot, { requestId: REQUEST, technicianId: TECH }));
  assert.equal(readDispatchPricingSnapshot(snapshot, { requestId: createId(), technicianId: TECH }), null);
  const json = migrateJsonIds({ request_id: 10, google_id: "external", sequenceId: 2 }, (table, id) => migratedId(table, id));
  assert.ok(isUuid(json.request_id));
  assert.equal(json.google_id, "external");
  assert.equal(json.sequenceId, 2);
});

test("one OTP record serializes concurrent sends and preserves its throttle after verification", async () => {
  let row = null;
  let tail = Promise.resolve();
  const pool = { getConnection: async () => {
    let unlock;
    let before;
    const finish = () => { unlock?.(); unlock = null; };
    return {
      beginTransaction: async () => {
        const previous = tail;
        tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        before = structuredClone(row);
      },
      execute: async (sql, params) => {
        if (/INSERT INTO otp_requests/.test(sql)) {
          row ??= { id: USER, email: params[0], otp_request_count: 0, otp_last_request_time: null, otp_window_start_time: null };
        } else Object.assign(row, { otp_request_count: params[0], otp_last_request_time: params[1], otp_window_start_time: params[2] });
        return [{ affectedRows: 1 }];
      },
      query: async () => [[{ ...row }]],
      commit: async () => finish(),
      rollback: async () => { row = before; finish(); },
      release: finish,
    };
  } };
  const start = Date.parse("2026-10-15T00:00:00Z");
  const attempts = await Promise.all([1, 2].map(() => enforceOtpRateLimit(pool, "new@example.invalid", new Date(start))));
  assert.equal(attempts.filter(attempt => attempt.allowed).length, 1);
  assert.equal(attempts.find(attempt => attempt.allowed).otpRequestId, USER);
  assert.equal(row.otp_request_count, 1);
  assert.equal((await enforceOtpRateLimit(pool, row.email, new Date(start + 61_000))).allowed, true);
  assert.equal((await enforceOtpRateLimit(pool, row.email, new Date(start + 122_000))).allowed, true);
  row.otp_hash = null; row.expires_at = null; // Verification consumes the challenge only.
  assert.equal((await enforceOtpRateLimit(pool, row.email, new Date(start + 183_000))).allowed, false);
  assert.equal(row.otp_request_count, 3);
  assert.equal((await enforceOtpRateLimit(pool, row.email, new Date(start + 3_601_000))).allowed, true);
  assert.equal(row.otp_request_count, 1);
  assert.equal(row.id, USER);
});

test("admin logins resolve to an existing users UUID instead of an email identity", async () => {
  const calls = [];
  const id = await ensureAdminIdentity("OPS@example.invalid", {
    execute: async (...args) => { calls.push(args); return [{ affectedRows: 1 }]; },
    query: async (...args) => { calls.push(args); return [[{ id: USER }]]; },
  });
  assert.equal(id, USER);
  assert.deepEqual(calls[0][1], ["ops@example.invalid"]);
  await assert.rejects(ensureAdminIdentity("ops@example.invalid", { execute: async () => [{}], query: async () => [[{ id: 7 }]] }), /UUID identity/);
});

test("UUID receipts and idempotency keys stay within provider/database limits", () => {
  const receipt = `reg_receipt_${TECH}_1792023456000`;
  assert.ok(receipt.length > 40);
  assert.ok(compactPaymentReceipt(receipt).length <= 40);
  assert.equal(compactPaymentReceipt(receipt), compactPaymentReceipt(receipt));
  assert.notEqual(compactPaymentReceipt(receipt), compactPaymentReceipt(receipt.replace(TECH, USER)));
  assert.equal(compactPaymentReceipt("receipt_101_reused"), "receipt_101_reused");
  const key = `wallet-payout:${TECH}:1000:${"external-reference".repeat(12)}`;
  assert.ok(boundedIdempotencyKey(key).length <= 128);
  assert.equal(boundedIdempotencyKey(key), boundedIdempotencyKey(key));
  assert.notEqual(boundedIdempotencyKey(key), boundedIdempotencyKey(key + "x"));
});

test("audit target mapping follows request parameter priority rather than action keywords", () => {
  assert.equal(referenceTarget("admin_audit_logs", "targetId", { targetId: 10, metadata: {
    path: "/api/admin/requests/10/assign-technician", params: { requestId: 10 }, body: { technicianId: 7 },
  } }), "service_requests");
  assert.equal(referenceTarget("admin_audit_logs", "targetId", { targetId: 7, metadata: {
    path: "/api/admin/technicians/7/requests", params: { id: 7 },
  } }), "technicians");
  assert.equal(referenceTarget("withdrawal_requests", "requested_by"), "technicians");
  assert.equal(referenceTarget("device_tokens", "user_id", { user_type: "technician" }), "technicians");
});

test("migration updates internal idempotency keys so payment and payout retries still deduplicate", async () => {
  const db = migrationDatabase({ extra: {
    payments: [{ id: 30, user_id: 1, service_request_id: 10 }],
    wallet_transactions: [{ id: 40, payment_id: 30, idempotency_key: "payment-credit:30" }],
    payouts: [{ id: 50, idempotency_key: "payment-payout:30" }],
  } });
  const plan = await buildUuidMigrationPlan(db.connection);
  const paymentId = migratedId("payments", 30);
  assert.equal(plan.conversions.find(row => row.table === "wallet_transactions").changes.idempotency_key, `payment-credit:${paymentId}`);
  assert.equal(plan.conversions.find(row => row.table === "payouts").changes.idempotency_key, `payment-payout:${paymentId}`);
});
