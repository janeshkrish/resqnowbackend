import test from "node:test";
import assert from "node:assert/strict";

// Fix #10 (QA-008): when dispatch runs out of retries the customer is told, admins
// are alerted, and the customer can try again or cancel, instead of the request
// staying on "searching" forever.

process.env.JWT_SECRET ||= "synthetic-dispatch-exhaustion-secret";
Object.assign(process.env, { DB_MIGRATION_MODE: "off" });

const {
  processNewDispatchJob,
  markDispatchExhausted,
  retryExhaustedDispatch,
  recoverRecentPendingDispatchJobs,
} = await import("../services/dispatchQueueService.js");
const { notificationService } = await import("../services/notificationService.js");

const REQUEST = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";
const STRANGER = "77777777-7777-4777-8777-777777777777";

// A tiny in-memory service_requests row that understands the statements under test.
function fakePool(row) {
  const calls = [];
  const notifications = [];
  const matches = (sql, args) => {
    if (String(args[0]) !== row.id) return false;
    if (/user_id = \?/.test(sql) && String(args[1]) !== row.user_id) return false;
    if (/status, ''\)\) = 'pending'/.test(sql) && String(row.status).toLowerCase() !== "pending") return false;
    if (/technician_id IS NULL/.test(sql) && row.technician_id != null) return false;
    if (/dispatch_exhausted_at IS NULL/.test(sql) && row.dispatch_exhausted_at != null) return false;
    if (/dispatch_exhausted_at IS NOT NULL/.test(sql) && row.dispatch_exhausted_at == null) return false;
    return true;
  };
  return {
    row, calls, notifications,
    async execute(sql, args = []) {
      calls.push(sql);
      if (sql.startsWith("UPDATE service_requests SET dispatch_exhausted_at = UTC_TIMESTAMP(3)")) {
        if (!matches(sql, args)) return [{ affectedRows: 0 }];
        row.dispatch_exhausted_at = new Date();
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("UPDATE service_requests SET dispatch_exhausted_at = NULL")) {
        if (!matches(sql, args)) return [{ affectedRows: 0 }];
        row.dispatch_exhausted_at = null;
        row.booking_dispatch_pending = 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO notifications")) {
        notifications.push(args);
        return [{ affectedRows: 1 }];
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    async query(sql, args = []) {
      calls.push(sql);
      if (/FROM service_requests/.test(sql) && /WHERE (sr\.)?id = \?/.test(sql)) {
        return [String(args[0]) === row.id ? [{ ...row }] : []];
      }
      if (/FROM service_requests sr/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function fakeSockets() {
  const user = [];
  const admin = [];
  return {
    user, admin, io: null,
    notifyUser: (userId, event, data) => user.push({ userId, event, data }),
    notifyAdmins: (event, data) => admin.push({ event, data }),
    notifyTechnician() {},
  };
}

const pendingRow = (extra = {}) => ({
  id: REQUEST, user_id: OWNER, status: "pending", technician_id: null, dispatch_exhausted_at: null,
  booking_dispatch_pending: 0, service_type: "car-towing", address: "Anna Salai, Chennai", ...extra,
});

test("running out of retries marks the request once, tells the customer and alerts admins", async () => {
  const pool = fakePool(pendingRow());
  const sockets = fakeSockets();
  const result = await processNewDispatchJob({ jobId: REQUEST, userId: OWNER, retryCount: 100_000 }, { pool, sockets });
  assert.equal(result.reason, "max_retries_reached");
  assert.equal(result.exhausted, true);
  assert.ok(pool.row.dispatch_exhausted_at instanceof Date);

  assert.equal(sockets.user.length, 1);
  assert.equal(sockets.user[0].userId, OWNER);
  assert.equal(sockets.user[0].event, "job:status_update");
  assert.equal(sockets.user[0].data.requestId, REQUEST);
  assert.equal(sockets.user[0].data.status, "pending", "status is unchanged so older apps keep working");
  assert.equal(sockets.user[0].data.dispatchOutcome, "no_technician");

  assert.equal(pool.notifications.length, 1, "an admin bell notification is stored");
  assert.match(pool.notifications[0][1], /no technician/i);
  assert.equal(sockets.admin.length, 1);
  assert.equal(sockets.admin[0].event, "admin:notification");
  assert.equal(sockets.admin[0].data.requestId, REQUEST);

  // A second exhausted job for the same request (e.g. a duplicate queue entry) is silent.
  const again = await processNewDispatchJob({ jobId: REQUEST, userId: OWNER, retryCount: 100_000 }, { pool, sockets });
  assert.equal(again.exhausted, false);
  assert.equal(sockets.user.length, 1);
  assert.equal(pool.notifications.length, 1);
});

test("a request that was assigned, cancelled or is no longer pending is never marked", async () => {
  for (const extra of [{ technician_id: "88888888-8888-4888-8888-888888888888", status: "assigned" }, { status: "cancelled" }]) {
    const pool = fakePool(pendingRow(extra));
    const sockets = fakeSockets();
    assert.deepEqual(await markDispatchExhausted(pool, REQUEST, { sockets }), { marked: false });
    assert.equal(pool.row.dispatch_exhausted_at, null);
    assert.equal(sockets.user.length + sockets.admin.length, 0);
  }
});

test("the customer can try again: the mark is cleared and dispatch restarts through the reliable handoff", async () => {
  const pool = fakePool(pendingRow({ dispatch_exhausted_at: new Date() }));
  const sockets = fakeSockets();
  const delivered = [];
  const result = await retryExhaustedDispatch({ pool, requestId: REQUEST, userId: OWNER, sockets, deliver: async (_p, id) => delivered.push(id) });
  assert.deepEqual(result, { ok: true });
  assert.equal(pool.row.dispatch_exhausted_at, null);
  assert.equal(pool.row.booking_dispatch_pending, 1, "the 15-second recovery sweep will finish it if the handoff fails");
  assert.deepEqual(delivered, [REQUEST]);
  assert.equal(sockets.user[0].data.dispatchOutcome, "searching");
});

test("try again works even if the immediate handoff fails (the recovery sweep picks it up)", async () => {
  const pool = fakePool(pendingRow({ dispatch_exhausted_at: new Date() }));
  const result = await retryExhaustedDispatch({ pool, requestId: REQUEST, userId: OWNER, sockets: fakeSockets(),
    deliver: async () => { throw new Error("queue unavailable"); } });
  assert.deepEqual(result, { ok: true });
  assert.equal(pool.row.booking_dispatch_pending, 1);
});

test("only the owner can try again, and only while the request is waiting with no technician", async () => {
  const cases = [
    { row: pendingRow({ dispatch_exhausted_at: new Date() }), userId: STRANGER },
    { row: pendingRow(), userId: OWNER }, // still searching: nothing to retry
    { row: pendingRow({ dispatch_exhausted_at: new Date(), status: "cancelled" }), userId: OWNER },
    { row: pendingRow({ dispatch_exhausted_at: new Date(), status: "assigned", technician_id: "88888888-8888-4888-8888-888888888888" }), userId: OWNER },
  ];
  for (const { row, userId } of cases) {
    const pool = fakePool(row);
    const delivered = [];
    const result = await retryExhaustedDispatch({ pool, requestId: REQUEST, userId, sockets: fakeSockets(), deliver: async (_p, id) => delivered.push(id) });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(delivered.length, 0);
  }
});

test("startup recovery leaves requests that already ran out of technicians alone", async () => {
  const pool = fakePool(pendingRow());
  await recoverRecentPendingDispatchJobs({ pool, enqueue: async () => ({ queued: true }) });
  const recoverySql = pool.calls.find((sql) => /FROM service_requests sr/.test(sql));
  assert.match(recoverySql, /dispatch_exhausted_at IS NULL/);
});

test("the customer's phone gets a clear 'no technician' notification; a restarted search sends none", async () => {
  const pool = { query: async () => [[{ service_type: "car-towing", technician_name: null }]] };
  const payload = await notificationService.buildPayload(OWNER, "user", "job:status_update",
    { requestId: REQUEST, status: "pending", dispatchOutcome: "no_technician" }, pool);
  assert.ok(payload, "a push is built");
  const text = JSON.stringify(payload);
  assert.match(text, /No technician free right now/);
  assert.match(text, /try again or cancel/i);
  assert.match(text, new RegExp(`/service-tracking/${REQUEST}`));

  const searching = await notificationService.buildPayload(OWNER, "user", "job:status_update",
    { requestId: REQUEST, status: "pending", dispatchOutcome: "searching" }, pool);
  assert.equal(searching, null);
});

test("the try-again route is registered for signed-in customers", async () => {
  const { default: router } = await import("../routes/service_requests.js");
  const layer = router.stack.find((l) => l.route?.path === "/:id/retry-dispatch" && l.route.methods.post);
  assert.ok(layer, "POST /:id/retry-dispatch exists");
  assert.ok(layer.route.stack.some((s) => s.handle?.name === "verifyUser"), "requires a signed-in customer");
});
