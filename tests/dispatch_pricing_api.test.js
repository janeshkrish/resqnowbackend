import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import Redis from "ioredis";

// Install the driver boundaries before importing routes or initializing runtime.
// No server, real database, Redis, email provider, or payment gateway is started.
process.env.DB_HOST = "simulated.invalid";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";
process.env.REDIS_URL = "redis://simulated.invalid:6379";
process.env.ADMIN_EMAIL = "";
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.SMTP_HOST;
delete process.env.RESEND_API_KEY;

let state;
const snapshot = () => ({ version: 1, request_id: 101, technician_id: 7, currency: "INR",
  technician_earning: 1200, customer_base_amount: 1200, customer_total_amount: 1322,
  payment_mode: "upi", platform_fee: 120, payment_fee: 2, discount_amount: 0,
  pricing_breakdown: { tax_percent: 0, tax_amount: 0 }, earnings_source: "technician_pricing",
  calculated_at: "2026-10-14T06:00:00.000Z", offer_id: 44 });
const row = (overrides = {}) => ({ id: 101, user_id: 3, technician_id: null, status: "pending",
  service_type: "car-towing", vehicle_type: "car", amount: 599, service_charge: 599,
  price: 599, estimated_price: 938.54, final_price: 938.54, technician_estimated_earning: 400,
  pricing_breakdown_json: { base_amount: 599, final_estimated_price: 938.54 },
  pricing_snapshot: snapshot(), route_distance_km: 12, route_metadata_json: { geometry: [1, 2] },
  location_lat: 11, location_lng: 76, drop_address: "Workshop", payment_method: "upi", payment_status: "pending",
  technician_pricing: [{ service_domain: "battery", vehicle_type: "car", service_charge: 9000 }],
  ...overrides });
const query = async (sql) => {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (state.creating && /SELECT id FROM service_requests WHERE user_id/.test(sql)) return [[]];
  if (/FROM service_requests/.test(sql)) return [[{ ...state.request }]];
  if (/FROM users/.test(sql)) return [[{ full_name: "Simulated customer", email: null }]];
  if (/FROM payments/.test(sql)) return [[]];
  if (/FROM platform_pricing_config/.test(sql)) return [[{ id: 1, currency: "INR", welcome_coupon_active: false }]];
  if (/FROM technicians|FROM technician_services/.test(sql)) {
    state.profileQueries++;
    return [[{ id: 7, pricing: [{ service_domain: "battery", vehicle_type: "car", service_charge: 9000 }] }]];
  }
  throw new Error(`Unexpected simulated database query: ${sql}`);
};
const execute = async (sql, params = []) => {
  state.executions.push({ sql, params });
  if (/INSERT INTO service_requests/.test(sql)) {
    const columns = sql.match(/INSERT INTO service_requests\s*\(([^)]*)\)/s)[1].split(",").map((value) => value.trim());
    state.request = { id: 101, ...Object.fromEntries(columns.map((column, index) => [column, params[index]])) };
    return [{ insertId: 101 }];
  }
  if (/UPDATE service_requests/.test(sql)) {
    state.request.status = params[0]; state.request.technician_id = null;
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE dispatch_offers/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected simulated database update: ${sql}`);
};
const connection = { query, execute, beginTransaction: async () => {}, commit: async () => {},
  rollback: async () => {}, release: () => {} };
const pool = { query, execute, getConnection: async () => connection, end: async () => {} };
mock.method(mysql, "createPool", () => pool);
mock.method(Redis.prototype, "connect", async function () { return this; });
mock.method(Redis.prototype, "sendCommand", async () => null);

const db = await import("../db.js");
const { getLiveTrackingRuntime, closeLiveTrackingRuntime } = await import("../services/liveTrackingRuntime.js");
const runtime = getLiveTrackingRuntime();
mock.method(runtime.ingestion, "getRecoverySnapshot", async () => { state.recoveryCalls++; return null; });
const serviceRoutes = await import("../routes/service_requests.js");
const { default: jobsRouter } = await import("../routes/jobs.js");
const { jobDispatchService } = await import("../services/jobDispatchService.js");
const { socketService } = await import("../services/socket.js");
for (const method of ["notifyUser", "notifyTechnician", "broadcast"]) mock.method(socketService, method, () => {});

beforeEach(async () => {
  await db.closePool();
  state = { request: row(), profileQueries: 0, recoveryCalls: 0, executions: [], released: [] };
});
after(async () => { await db.closePool(); await closeLiveTrackingRuntime(); mock.restoreAll(); });

const response = () => ({ statusCode: 200, body: null, status(value) { this.statusCode = value; return this; },
  json(value) { this.body = value; return this; }, set() { return this; }, setHeader() {} });
async function call(router, path, method = "get", extra = {}) {
  const handler = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])?.route.stack.at(-1)?.handle;
  assert.ok(handler, `${method} ${path} exists`);
  const res = response();
  await handler({ user: { userId: 3 }, technicianId: 7, params: { id: "101" }, query: {}, body: {}, ...extra }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}
function assertWaitingPriceHidden(value) {
  assert.equal(value.pricing_status, "pending");
  assert.equal(value.pricing_finalized, false);
  for (const key of ["amount", "price", "service_charge", "final_price", "estimated_price", "finalAmount", "final_amount",
    "base_amount", "baseAmount", "platform_fee", "platformFee", "payment_fee", "technician_estimated_earning",
    "technicianEstimatedEarning", "pricing_snapshot", "pricingBreakdown", "pricing_breakdown_json", "pricing_breakdown"])
    assert.equal(value[key], undefined, `waiting customer must not receive ${key}`);
  assert.equal(Number(value.route_distance_km), 12);
  assert.equal(value.drop_address, "Workshop");
}

for (const status of ["pending", "assigned"]) {
  test(`customer list hides ${status} request pricing while retaining route details`, async () => {
    state.request = row({ status, technician_id: status === "assigned" ? 7 : null });
    const result = await call(serviceRoutes.default, "/");
    assertWaitingPriceHidden(result[0]);
  });
  test(`customer detail hides ${status} pricing and does not initialize live tracking recovery`, async () => {
    state.request = row({ status, technician_id: status === "assigned" ? 7 : null });
    const result = await call(serviceRoutes.default, "/:id");
    assertWaitingPriceHidden(result);
    assert.equal(state.recoveryCalls, 0);
  });
}

test("accepted customer list exposes the accepting technician's saved price", async () => {
  state.request = row({ status: "accepted", technician_id: 7, accepted_time: "2026-10-14T06:10:00Z" });
  const result = (await call(serviceRoutes.default, "/"))[0];
  assert.equal(result.pricing_finalized, true);
  assert.equal(result.amount, 1200);
  assert.equal(result.final_price, 1322);
});

test("accepted customer detail retains saved service price after registered prices change", async () => {
  state.request = row({ status: "accepted", service_type: "car-battery", technician_id: 7,
    amount: 1200, final_price: 1322, accepted_time: "2026-10-14T06:10:00Z" });
  const result = await call(serviceRoutes.default, "/:id");
  assert.equal(result.amount, 1200);
  assert.equal(result.final_price, 1322);
  assert.equal(result.pricing_status, "confirmed");
  assert.equal(state.profileQueries, 0);
});

test("legacy accepted recorded base is preserved instead of re-reading technician rates", async () => {
  assert.equal(typeof serviceRoutes.resolveRequestBaseAmount, "function", "recorded customer base resolver must be exported");
  for (const request of [row({ status: "accepted", technician_id: 7, service_type: "car-battery", pricing_snapshot: null,
    amount: 350 }), row({ status: "completed", technician_id: 7, service_type: "car-battery", pricing_snapshot: null,
    amount: null, service_charge: 400 })]) {
    assert.equal(await serviceRoutes.resolveRequestBaseAmount(request), request.amount ?? request.service_charge);
  }
  assert.equal(state.profileQueries, 0);
});

test("request creation returns no customer-specific price before a technician accepts", async () => {
  state.creating = true;
  const previousRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL; // Runtime above is already isolated; dispatch uses its no-queue fallback.
  const matcher = mock.method(jobDispatchService, "findTopTechnicians", async () => []);
  try {
    const result = await call(serviceRoutes.default, "/", "post", { body: {
      service_type: "car-battery", vehicle_type: "car", address: "Simulated pickup",
      location_lat: 11, location_lng: 76, amount: 777, contact_name: "Simulated customer",
    } });
    assert.equal(result.status, "pending");
    assert.equal(result.pricing_status, "pending");
    assert.equal(result.pricing_finalized, false);
    assert.equal(result.amount, undefined);
    assert.equal(result.technicianEstimatedEarning, undefined);
    assert.equal(result.estimatedEarnings, undefined);
    assert.equal(state.request.id, 101);
  } finally { matcher.mock.restore(); process.env.REDIS_URL = previousRedisUrl; }
});

for (const [service, vehicle, subtype, port, code] of [
  ['ev-fuel', 'ev', 'electric-scooter', null, 'ev_fuel_not_supported'],
  ['car-fuel', 'car', 'electric-car', null, 'ev_fuel_not_supported'],
  ['ev-charging', 'car', 'sedan', 'ccs2', 'ev_vehicle_required'],
  ['ev-ev-charging', 'ev', 'electric-car', 'dk', 'ev_connector_required'],
  ['ev-ev-charging', 'ev', 'electric-car', 'brand', 'ev_brand_required'],
]) {
  test(`booking refuses invalid EV service ${service}/${vehicle}/${port} before database writes`, async () => {
    const handler = serviceRoutes.default.stack.find(entry => entry.route?.path === '/' && entry.route.methods.post).route.stack.at(-1).handle;
    const res = response();
    await handler({ user: { userId: 3 }, body: { service_type: service, vehicle_type: vehicle, vehicle_subtype: subtype,
      address: 'Simulated pickup', details: { answers: port ? [{ id: 'port', question: 'Port', label: port, value: port }] : [] } } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, code);
    assert.equal(state.executions.length, 0);
    assert.equal(state.profileQueries, 0);
  });
}

test('booking preserves EV identity and known body while keeping the waiting price hidden', async () => {
  state.creating = true;
  const previousRedisUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const matcher = mock.method(jobDispatchService, 'findTopTechnicians', async () => []);
  try {
    const result = await call(serviceRoutes.default, '/', 'post', { body: {
      service_type: 'car-flat-tire', vehicle_type: 'car', vehicle_subtype: 'electric-car',
      vehicle_brand: 'Tata', vehicle_model: 'Tiago EV', address: 'Simulated pickup', location_lat: 11, location_lng: 76,
      details: { vehicle_base_subtype: 'hatchback', answers: [{ id: 'tyretype', question: 'Tyre', value: 'tubeless', label: 'Tubeless' }] },
    } });
    assert.equal(state.request.service_type, 'ev-flat-tire');
    assert.equal(state.request.vehicle_type, 'ev');
    assert.equal(state.request.vehicle_subtype, 'electric-car');
    assert.equal(JSON.parse(state.request.request_details_json).vehicle_base_subtype, 'hatchback');
    assert.equal(result.pricing_status, 'pending');
    assert.equal(result.amount, undefined);
  } finally { matcher.mock.restore(); process.env.REDIS_URL = previousRedisUrl; }
});

for (const status of ["pending", "accepted"]) {
  test(`cancelling a ${status} request returns the appropriate customer pricing visibility`, async () => {
    state.request = row({ status, technician_id: status === "accepted" ? 7 : null,
      accepted_time: status === "accepted" ? "2026-10-14T06:10:00Z" : null,
      final_price: status === "accepted" ? 1322 : 938.54 });
    const res = response();
    await serviceRoutes.handleCustomerCancel({ user: { userId: 3 }, params: { id: "101" }, body: { reason: "Price unacceptable" } }, res,
    { getPool: async () => pool, release: async (_conn, techId) => { state.released.push(techId); }, sockets: socketService });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.request.status, "cancelled");
    if (status === "pending") assertWaitingPriceHidden(res.body.request);
    else {
      assert.equal(res.body.request.pricing_finalized, true);
      assert.equal(res.body.request.amount, 1200);
      assert.equal(res.body.request.final_price, 1322);
      assert.deepEqual(state.released, [7]);
    }
  });
}

test("job acceptance forwards the selected immutable offer ID", async () => {
  let observed;
  const stub = mock.method(jobDispatchService, "acceptJob", async (...args) => {
    observed = args; return { success: true, job: { id: 101, status: "accepted" } };
  });
  try {
    await call(jobsRouter, "/accept", "post", { body: { jobId: 101, offerId: 44 } });
    assert.deepEqual(observed, [7, "101", { offerId: 44 }]);
  } finally { stub.mock.restore(); }
});

test("acceptance recovery checks the same selected offer ID", async () => {
  let observed;
  const stub = mock.method(jobDispatchService, "getAcceptanceOutcome", async (...args) => {
    observed = args; return { state: "accepted", job: { id: 101 } };
  });
  try {
    await call(jobsRouter, "/:id/acceptance", "get", { query: { offerId: "44" } });
    assert.deepEqual(observed, [7, "101", { offerId: "44" }]);
  } finally { stub.mock.restore(); }
});

for (const serviceType of ["car-battery", "car-towing"]) {
  test(`${serviceType} cannot start travel while merely assigned without accepting its price`, async () => {
    state.request = row({ status: "assigned", service_type: serviceType, technician_id: 7, pricing_snapshot: null });
    const res = response();
    await serviceRoutes.handleTechnicianStatusUpdate({ technicianId: 7, params: { id: "101" },
      body: { status: serviceType === "car-towing" ? "en_route_pickup" : "en-route" } }, res,
    { getPool: async () => pool });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "acceptance_required");
    assert.equal(state.executions.length, 0);
    assert.equal(state.request.status, "assigned");
  });
}
