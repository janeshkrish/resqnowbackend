import assert from "node:assert/strict";
import test from "node:test";
import * as bootstrap from "../models/bootstrap.js";

test("existing request tables gain nullable booking fields and an account-scoped unique key", async () => {
  const columns = new Set();
  const indexes = new Map();
  let writes = 0;
  const database = { async query(sql, params = []) {
    if (/FROM information_schema.columns/i.test(sql)) return [columns.has(params[1]) ? [{ present: 1 }] : []];
    if (/FROM information_schema.statistics/i.test(sql)) return [indexes.get(params[1]) ?? []];
    if (/ALTER TABLE service_requests ADD COLUMN/.test(sql)) {
      const match = sql.match(/ADD COLUMN (\w+) (?:(?:VAR)?CHAR\(\d+\) CHARACTER SET ascii COLLATE ascii_bin NULL|BOOLEAN NOT NULL DEFAULT FALSE)/i);
      assert.ok(match, "historic rows need nullable fields"); columns.add(match[1]);
    } else {
      const match = sql.match(/CREATE (UNIQUE )?INDEX (\w+) ON service_requests \(([^)]+)\)/i);
      assert.ok(match, sql); indexes.set(match[2], match[3].split(", ").map(column_name => ({ column_name, non_unique: match[1] ? 0 : 1 })));
    }
    writes++; return [{}];
  } };
  assert.equal(typeof bootstrap.ensureBookingIdempotencySchema, "function");
  await bootstrap.ensureBookingIdempotencySchema(database);
  await bootstrap.ensureBookingIdempotencySchema(database);
  assert.deepEqual([...columns], ["idempotency_key", "booking_payload_hash", "booking_dispatch_pending"]);
  assert.deepEqual(indexes.get("uq_service_request_user_attempt").map(row => row.column_name), ["user_id", "idempotency_key"]);
  assert.equal(writes, 5);
});
