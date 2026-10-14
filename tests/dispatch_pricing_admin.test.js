import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import * as db from "../db.js";
import { assignRequest, overrideRequestPricing } from "../controllers/requestController.js";
import { socketService } from "../services/socket.js";

// All database and socket calls stop at this in-memory boundary.
process.env.DB_HOST = "simulated.invalid";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";
delete process.env.ADMIN_EMAIL;
const quote = (technicianId = 7) => ({ version: 1, request_id: 101, technician_id: technicianId, currency: "INR",
  technician_earning: 1000, customer_base_amount: 1000, customer_total_amount: 1100, payment_mode: "cash",
  platform_fee: 100, payment_fee: 0, discount_amount: 0, pricing_breakdown: { tax_amount: 0, tax_percent: 0 },
  earnings_source: "technician_pricing", calculated_at: "2026-10-14T04:00:00.000Z", offer_id: 61 });
let state;
const clone = value => structuredClone(value);
const applyUpdate = (sql, params) => {
  const set = sql.split(/\bSET\b/i)[1]?.split(/\bWHERE\b/i)[0] || "";
  let index = 0;
  for (const match of set.matchAll(/([a-z_]+)\s*=\s*(\?|COALESCE\([^)]*\)|'[^']*'|NULL|NOW\(\))/gi)) {
    const [, column, value] = match;
    if (value === "?") state.request[column] = params[index++];
    else if (value.startsWith("COALESCE")) { if (params[index] != null) state.request[column] = params[index]; index++; }
    else if (value === "NULL") state.request[column] = null;
    else if (value.startsWith("'")) state.request[column] = value.slice(1, -1);
  }
  if (/status = CASE/.test(sql) && ["pending", "open", "assigned"].includes(state.request.status)) state.request.status = "assigned";
  return [{ affectedRows: 1 }];
};
const pool = { query: async (sql, params = []) => {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (/FROM technician_services/.test(sql)) return [state.registered ? [state.serviceRow ?? { id: 71, technician_id: 7, service_domain: "battery", vehicle_type: "car", service_charge: 900, visit_charge: 100, metadata: {} }] : []];
  if (/FROM technician_fleet_vehicles/.test(sql)) return [state.fleet ?? []];
  if (/FROM technicians/.test(sql) && /SELECT/.test(sql)) return [[{ id: Number(params[0] || 7), name: "Simulated technician", status: "approved", is_active: 1,
    is_available: 1, current_job_id: null, service_costs: null }]];
  if (/FROM service_requests/.test(sql) && /SELECT \*/.test(sql)) {
    if (state.acceptOnLock && /FOR UPDATE/.test(sql)) {
      Object.assign(state.request, { status: "accepted", technician_id: 7, pricing_snapshot: JSON.stringify(quote()) });
      state.acceptOnLock = false;
    }
    return [[clone(state.request)]];
  }
  if (/FROM service_requests/.test(sql) && /sr.id <>|id <>/.test(sql)) return [[]];
  if (/FROM service_requests/.test(sql) && /SELECT/.test(sql)) return [[clone(state.request)]];
  if (/UPDATE dispatch_offers/.test(sql)) {
    for (const offer of state.offers) if (offer.technician_id === Number(params[1]) && offer.status === "pending") offer.status = "expired";
    return [{ affectedRows: 1 }];
  }
  if (/INSERT INTO dispatch_offers/.test(sql)) {
    if (state.failOfferInsert) throw new Error("Simulated offer persistence failure");
    const row = { id: 61 + state.offers.length, service_request_id: params[0], technician_id: params[1], status: "pending", expires_at: params[2], pricing_snapshot: params[3] };
    state.offers.push(row); return [{ insertId: row.id }];
  }
  if (/UPDATE technicians/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected simulated admin SQL: ${sql}`);
}, execute: async (sql, params = []) => {
  if (/UPDATE service_requests/.test(sql)) return applyUpdate(sql, params);
  if (/admin_actions_log|request_timeline/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected simulated admin mutation: ${sql}`);
}, getConnection: async () => {
  let backup;
  return { query: pool.query, execute: pool.execute, beginTransaction: async () => { backup = clone(state); },
    commit: async () => { state.commits++; }, rollback: async () => { state = { ...backup, rollbacks: state.rollbacks + 1 }; }, release: () => {} };
}, end: async () => {} };
const driver = mock.method(mysql, "createPool", () => pool);
const sockets = ["notifyUser", "notifyTechnician", "broadcast"].map(method => mock.method(socketService, method, (...args) => state.events.push({ method, args })));
beforeEach(() => { state = { request: { id: 101, user_id: 41, technician_id: null, status: "pending", service_type: "car-battery", vehicle_type: "car",
  amount: 399, final_price: 438.9, pricing_snapshot: null, pricing_breakdown_json: null, payment_status: "pending" },
  registered: true, offers: [], events: [], commits: 0, rollbacks: 0 }; });
after(async () => { await db.closePool(); driver.mock.restore(); sockets.forEach(item => item.mock.restore()); });
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const assignment = async (technicianId = 7) => { const res = response(); await assignRequest({ params: { requestId: 101 }, body: { technicianId } }, res, { getPool: async () => pool }); return res; };
const override = async () => { const res = response(); await overrideRequestPricing({ params: { requestId: 101 }, body: { baseAmount: 1500, finalPrice: 1650 } }, res, { getPool: async () => pool }); return res; };

test("manual assignment saves the technician's registered-price offer before notifying them", async () => {
  const res = await assignment();
  assert.equal(res.statusCode, 200);
  assert.equal(state.offers.length, 1);
  assert.equal(JSON.parse(state.offers[0].pricing_snapshot).technician_earning, 1000);
  assert.equal(state.request.status, "assigned");
  const tech = state.events.find(event => event.method === "notifyTechnician" && event.args[1] === "job:assigned");
  assert.equal(tech.args[2].offerId, 61);
  assert.equal(tech.args[2].amount, 1000);
  const user = state.events.find(event => event.method === "notifyUser");
  assert.equal(user.args[2].pricing_finalized, false);
  assert.equal("amount" in user.args[2], false);
});

test("manual assignment rolls back ownership when registered pricing is missing", async () => {
  state.registered = false;
  const res = await assignment();
  assert.equal(res.statusCode, 409);
  assert.equal(state.request.technician_id, null);
  assert.equal(state.request.status, "pending");
  assert.equal(state.offers.length, 0);
  assert.equal(state.events.length, 0);
});

test("admin cannot silently override an accepted versioned pricing agreement", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 7, amount: 1000, pricing_snapshot: JSON.stringify(quote()) });
  const res = await override();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "pricing_locked");
  assert.equal(state.request.amount, 1000);
  assert.equal(state.events.length, 0);
});

for (const status of ["pending", "assigned"]) {
  test(`admin provisional override stays hidden from customers while ${status}`, async () => {
    Object.assign(state.request, { status, technician_id: status === "assigned" ? 7 : null });
    const res = await override();
    assert.equal(res.statusCode, 200);
    const user = state.events.find(event => event.method === "notifyUser");
    assert.equal("amount" in user.args[2], false);
    assert.equal("finalPrice" in user.args[2], false);
    assert.equal(user.args[2].pricing_finalized, false);
    assert.equal(state.events.some(event => event.method === "notifyTechnician"), false);
  });
}

test("a different technician cannot inherit an accepted versioned quote through admin assignment", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 9, pricing_snapshot: JSON.stringify(quote(9)) });
  const res = await assignment();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "job_already_accepted");
  assert.equal(state.request.technician_id, 9);
  assert.equal(state.offers.length, 0);
});

test("assigning the already accepted owner is idempotent and preserves the agreed price", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 7, amount: 1000, pricing_snapshot: JSON.stringify(quote()) });
  const res = await assignment();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(state.request.status, "accepted");
  assert.equal(state.request.amount, 1000);
  assert.equal(state.offers.length, 0);
  assert.equal(state.events.length, 0);
});

test("override locks and reads the latest acceptance before changing money", async () => {
  state.acceptOnLock = true;
  const res = await override();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "pricing_locked");
  assert.equal(state.events.length, 0);
});

test("manual towing assignment uses registered truck rates and checks equipment", async () => {
  Object.assign(state.request, { service_type: "car-towing", route_distance_km: 12, tow_truck_type: "flatbed" });
  state.serviceRow = { id: 71, technician_id: 7, service_domain: "towing", vehicle_type: "car", base_price: 900, free_km: 5, per_km_price: 30, night_charge: 0, metadata: {} };
  state.fleet = [{ vehicle_type: "flatbed", status: "available" }];
  const res = await assignment();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(state.offers[0].pricing_snapshot).technician_earning, 1110);
});

test("historical accepted same-owner assignments preserve their recorded amount", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 7, amount: 700, technician_estimated_earning: 650 });
  const res = await assignment();
  assert.equal(res.body.idempotent, true);
  assert.equal(state.request.amount, 700);
  assert.equal(state.request.technician_estimated_earning, 650);
  assert.equal(state.offers.length, 0);
});

test("historical accepted pricing and ownership cannot be reset through admin reassignment", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 9, amount: 700, accepted_time: "2026-10-14T03:00:00.000Z" });
  const res = await assignment();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "job_already_accepted");
  assert.equal(state.request.status, "accepted");
  assert.equal(state.request.accepted_time, "2026-10-14T03:00:00.000Z");
  assert.equal(state.request.amount, 700);
  assert.equal(state.offers.length, 0);
  assert.equal(state.events.length, 0);
});

test("historical accepted requests preserve recorded prices without a versioned snapshot", async () => {
  Object.assign(state.request, { status: "accepted", technician_id: 7, amount: 700 });
  const res = await override();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "pricing_locked");
  assert.equal(state.request.amount, 700);
  assert.equal(state.events.length, 0);
});
