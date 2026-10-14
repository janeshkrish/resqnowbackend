import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import * as db from "../db.js";
import * as technicianRoutes from "../routes/technicians.js";

process.env.DB_HOST = "simulated.invalid";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";

const snapshot = (overrides = {}) => ({ version: 1, request_id: 101, technician_id: 7, currency: "INR",
  technician_earning: 1000, customer_base_amount: 1180, customer_total_amount: 1300,
  payment_mode: "upi", platform_fee: 118, payment_fee: 2, discount_amount: 0,
  pricing_breakdown: { tax_percent: 0.18, tax_amount: 180 }, earnings_source: "technician_pricing",
  calculated_at: "2026-10-14T06:00:00.000Z", offer_id: 44, ...overrides });
const job = (overrides = {}) => ({ id: 101, technician_id: 7, service_type: "car-battery", vehicle_type: "car",
  status: "accepted", amount: 1180, technician_estimated_earning: 1000, pricing_snapshot: snapshot(), ...overrides });

let row;
let offers;
let profileReads;
const query = async (sql) => {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (/FROM technician_wallets/.test(sql)) return [[{ id: 50, technician_id: 7, total_earned: 1000,
    withdrawable_balance: 800, total_paid_out: 200, on_hold_balance: 0, currency: "INR" }]];
  if (/FROM wallet_transactions/.test(sql)) {
    return [/DATE\(wt.created_at\) as date/.test(sql) ? [{ date: new Date().toISOString().slice(0, 10), amount: 1000 }]
      : [{ today: 1000 }]];
  }
  if (/FROM technician_dues/.test(sql)) return [[{ total: 0 }]];
  if (/FROM payments p/.test(sql)) return [[{ total: 118 }]];
  if (/COUNT\(\*\).*FROM service_requests/.test(sql)) return [[{ count: 1 }]];
  if (/FROM service_requests/.test(sql)) return [[row]];
  if (/FROM dispatch_offers/.test(sql)) return [offers];
  if (/FROM payments/.test(sql)) return [[]];
  if (/FROM technicians/.test(sql)) { profileReads++; return [[{ id: 7, service_costs: [{
    service_domain: "battery", vehicle_type: "car", service_charge: 9000, visit_charge: 999,
  }] }]]; }
  if (/FROM technician_services/.test(sql)) return [[{ service_domain: "battery", service_charge: 9000, visit_charge: 999 }]];
  if (/FROM settings/.test(sql)) return [[]];
  throw new Error(`Unexpected simulated query: ${sql}`);
};
const pool = { query, execute: query, end: async () => {} };
mock.method(mysql, "createPool", () => pool);
beforeEach(async () => {
  await db.closePool();
  row = job(); offers = [{ id: 44, pricing_snapshot: snapshot(), status: "pending", expired: 0 }]; profileReads = 0;
});
after(async () => { await db.closePool(); mock.restoreAll(); });

const requireResolver = () => {
  assert.equal(typeof technicianRoutes.resolveTechnicianJobPricing, "function", "technician views must read agreed offer pricing");
  return technicianRoutes.resolveTechnicianJobPricing;
};
async function routeResponse(path) {
  const handler = technicianRoutes.default.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.get)
    ?.route.stack.at(-1)?.handle;
  assert.ok(handler, `route ${path} exists`);
  let body;
  let status = 200;
  const res = { json: (value) => { body = value; return res; }, status: (value) => { status = value; return res; } };
  await handler({ technicianId: 7, params: { techId: "7" } }, res);
  assert.equal(status, 200);
  return body;
}

test("accepted technician view uses saved earnings without any profile price lookup", async () => {
  const result = await requireResolver()(row, { technicianId: 7, connection: pool });
  assert.equal(result.amount, 1000);
  assert.equal(result.snapshot.customer_total_amount, 1300);
  assert.equal(profileReads, 0);
});

test("legacy accepted non-towing history retains recorded earnings after rates increase", async () => {
  const result = await requireResolver()(job({ status: "completed", pricing_snapshot: null,
    technician_estimated_earning: 350, amount: 400 }), { technicianId: 7, connection: pool });
  assert.equal(result.amount, 350);
  assert.equal(profileReads, 0);
});

test("assigned technician sees their current saved offer, not the provisional customer amount", async () => {
  const result = await requireResolver()(job({ status: "assigned", pricing_snapshot: null,
    amount: 599, technician_estimated_earning: 500 }), { technicianId: 7, connection: pool });
  assert.equal(result.amount, 1000);
  assert.equal(result.offerId, 44);
});

test("unpriced or expired assigned offers expose no invented technician earnings", async () => {
  const resolver = requireResolver();
  for (const offer of [null, { id: 44, pricing_snapshot: null, status: "pending", expired: 0 },
    { id: 44, pricing_snapshot: snapshot(), status: "pending", expired: 1 }]) {
    offers = offer ? [offer] : [];
    const result = await resolver(job({ status: "assigned", amount: 9999 }), { technicianId: 7, connection: pool });
    assert.equal(result.amount, null);
  }
});

for (const path of ["/me/active-job", "/active-job/:techId", "/current-job", "/me/active-job-legacy"]) {
  test(`${path} separates technician earnings from customer taxes and fees`, async () => {
    const result = await routeResponse(path);
    assert.equal(result.amount, 1000);
    assert.equal(result.priceAmount, 1000);
    assert.equal(result.technicianEstimatedEarning, 1000);
    assert.equal(result.estimatedEarnings, 1000);
    assert.equal(result.customer_base_amount, 1180);
    assert.equal(result.customer_total_amount, 1300);
    assert.equal(profileReads, 0);
  });
}

for (const path of ["/requests", "/jobs/history"]) {
  test(`${path} does not reprice accepted jobs from current technician rates`, async () => {
    row = job({ status: "completed" });
    const result = (await routeResponse(path))[0];
    assert.equal(result.amount, 1000);
    assert.equal(result.priceAmount, 1000);
    assert.equal(result.technicianEstimatedEarning, 1000);
    assert.equal(result.customer_total_amount, 1300);
    assert.equal(profileReads, 0);
  });
}

test("active assigned dashboard carries the same offer ID and earnings as the notification", async () => {
  row = job({ status: "assigned", amount: 599, pricing_snapshot: null, technician_estimated_earning: null });
  const result = await routeResponse("/me/active-job");
  assert.equal(result.amount, 1000);
  assert.equal(result.offerId, 44);
  assert.equal(result.pricing_finalized, false);
});

test("technician dashboard statistics exclude customer tax and fees from wallet earnings", async () => {
  row = job({ status: "completed", amount: 1180, final_price: 1300 });
  const result = await routeResponse("/dashboard-stats");
  assert.equal(result.totalEarnings, 1000);
  assert.equal(result.todayEarnings, 1000);
  assert.equal(result.withdrawableBalance, 800);
  assert.equal(result.totalPaidOut, 200);
  assert.equal(result.completedJobs, 1);
});

test("technician earnings history displays wallet credits rather than the taxed customer base", async () => {
  row = job({ status: "completed", amount: 1180, final_price: 1300 });
  const result = await routeResponse("/earnings-history");
  assert.equal(result.reduce((sum, day) => sum + day.amount, 0), 1000);
});

test("financial summary keeps earnings and withdrawable wallet balance separate from customer charges", async () => {
  row = job({ status: "completed", amount: 1180, final_price: 1300 });
  const result = await routeResponse("/me/financials");
  assert.equal(result.total_earnings, 1000);
  assert.equal(result.withdrawable_balance, 800);
  assert.equal(result.total_paid_out, 200);
  assert.equal(result.pending_dues, 118);
});
