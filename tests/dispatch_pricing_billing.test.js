import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import Razorpay from "razorpay";
import crypto from "node:crypto";
import { socketService } from "../services/socket.js";
import * as db from "../db.js";
import { buildServiceRequestPaymentDetails, resolveServiceRequestTechnicianAmount } from "../services/serviceRequestPaymentService.js";
import { backfillMarketplaceWalletCredits } from "../services/marketplaceWalletService.js";

// Every DB call is intercepted; no real TiDB, gateway, mail, or wallet service is contacted.
process.env.DB_HOST = "simulated.invalid";
process.env.DB_MIGRATION_MODE = "off";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";
process.env.RAZORPAY_KEY_ID = "rzp_test_simulated";
process.env.RAZORPAY_KEY_SECRET = "simulated-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "simulated-secret";
const gatewayMock = mock.method(Razorpay.prototype, "addResources", function () {
  this.orders = { create: async data => {
    state.gatewayCalls.push(data);
    return { id: "order_simulated", amount: data.amount, currency: data.currency };
  } };
  this.payments = { fetch: async id => {
    state.gatewayFetches.push(id);
    if (state.gatewayFailure) throw new Error("Simulated gateway outage");
    return { id, order_id: "order_simulated", amount: Math.round(Number(state.payments[0]?.amount ?? 1322) * 100), currency: "INR",
      status: "captured", captured: true, notes: { requestId: "501", userId: "3" }, ...state.gatewayPayment };
  } };
});
const { default: paymentsRouter, razorpayWebhookHandler } = await import("../routes/payments.js");
const socketMocks = ["broadcast", "notifyTechnician", "notifyUser"].map(method => mock.method(socketService, method, () => {}));

const snapshot = () => ({ version: 1, request_id: 501, technician_id: 7, currency: "INR",
  technician_earning: 1200, customer_base_amount: 1200, customer_total_amount: 1322,
  payment_mode: "upi", platform_fee: 120, payment_fee: 2, discount_amount: 0,
  pricing_breakdown: { subtotal: 1200 }, earnings_source: "technician_pricing", calculated_at: "2026-10-14T00:00:00.000Z", offer_id: 91 });
const accepted = (extra = {}) => ({ id: 501, user_id: 3, technician_id: 7, status: "accepted",
  service_type: "towing", vehicle_type: "car", amount: 599, service_charge: 599,
  technician_estimated_earning: 900, payment_method: "upi", payment_status: "pending",
  pricing_snapshot: JSON.stringify(snapshot()), ...extra });
let state;
const pool = { query: async (sql, params = []) => {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (/information_schema.columns/.test(sql)) return [state.columns.has(`${params[0]}.${params[1]}`) ? [{ result: 1 }] : []];
  if (/information_schema.statistics/.test(sql)) return [[{ result: 1 }]];
  if (/^ALTER TABLE/.test(sql)) {
    const match = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    state.columns.add(`${match[1]}.${match[2]}`); state.ddl.push(sql); return [{ affectedRows: 0 }];
  }
  if (/FROM platform_pricing_config/.test(sql)) return [[{ id: 1, currency: "INR", welcome_coupon_active: false }]];
  if (/COUNT\(\*\)/.test(sql)) return [[{ count: 0 }]];
  if (/FROM payments/.test(sql)) return [state.payments.map(row => ({ user_id: 3, ...row }))];
  if (/FROM invoices/.test(sql)) return [[{ id: 32, status: "EMAILED" }]];
  if (/FROM wallet_transactions/.test(sql)) return [[{ id: 44, amount: 1200 }]];
  if (/FROM service_requests/.test(sql)) return [[{ ...state.request }]];
  if (/FROM technicians/.test(sql)) return [[{ pricing: '{"car-battery":9000}' }]];
  throw new Error(`Unexpected simulated query: ${sql}`);
}, execute: async (sql, params = []) => {
  state.executions.push({ sql, params });
  if (/CREATE TABLE IF NOT EXISTS/.test(sql)) { state.createSql.push(sql); return [{ affectedRows: 0 }]; }
  if (/INSERT INTO payments/.test(sql)) {
    const columns = sql.match(/INSERT INTO payments\s*\(([^)]*)\)/s)[1].split(",").map(value => value.trim());
    state.payments.push(Object.fromEntries(columns.map((column, index) => [column, params[index]])));
    return [{ insertId: 31 }];
  }
  if (/UPDATE service_requests/.test(sql)) return [{ affectedRows: 1 }];
  if (/UPDATE payments|UPDATE invoices|UPDATE technicians/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected simulated mutation: ${sql}`);
}, end: async () => {}, getConnection: async () => ({ query: pool.query, execute: pool.execute,
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) };
const driverMock = mock.method(mysql, "createPool", () => pool);
beforeEach(() => { state = { request: accepted(), columns: new Set(), ddl: [], createSql: [], gatewayCalls: [], gatewayFetches: [], payments: [], executions: [] }; });
after(async () => { await db.closePool(); driverMock.mock.restore(); gatewayMock.mock.restore(); socketMocks.forEach(item => item.mock.restore()); });
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const handler = path => paymentsRouter.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;

for (const path of ['/quote', '/create-order', '/cash']) {
  test(`${path} refuses an underfunded historical price before creating a payment or payout`, async () => {
    state.request = accepted({ pricing_snapshot: null, amount: 599, service_charge: 599, technician_estimated_earning: 900 });
    const res = response();
    await handler(path)({ body: { requestId: 501 }, user: { userId: 3 } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'UNFUNDED_ACCEPTED_PRICE');
    assert.equal(state.gatewayCalls.length, 0);
    assert.equal(state.executions.length, 0);
    assert.equal(state.payments.length, 0);
  });
}

test("billing details use the accepted offer rather than the earlier platform towing quote", () => {
  const result = buildServiceRequestPaymentDetails({ requestRow: accepted() });
  assert.equal(result.baseAmount, 1200);
  assert.equal(result.platformFee, 120);
  assert.equal(result.totalAmount, 1322);
});

test("payment quote uses frozen earnings after registered rates change", async () => {
  state.request = accepted({ service_type: "car-battery", technician_pricing: '{"car-battery":9000}' });
  const res = response();
  await handler("/quote")({ body: { requestId: 501, paymentMode: "cash" }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.breakdown.base_amount, 1200);
  assert.equal(res.body.breakdown.total_amount, 1320);
});

for (const status of ["pending", "assigned"]) {
  test(`payment quote rejects ${status} requests before actual acceptance`, async () => {
    state.request = accepted({ status, accepted_time: null });
    const res = response();
    await handler("/quote")({ body: { requestId: 501 }, user: { userId: 3 } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /accept/i);
  });
}

function walletScenario(paymentChanges = {}) {
  const payment = { payment_id: 31, service_request_id: 501, technician_id: 7, currency: "INR", payment_method: "razorpay",
    technician_amount: 1000, base_amount: 1180, amount: 1300, wallet_transaction_id: null, ...paymentChanges };
  const wallet = { id: 11, technician_id: 7, total_earned: 0, withdrawable_balance: 0 };
  const entries = [];
  const conn = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params = []) => {
      if (/FROM wallet_transactions/.test(sql) && /payment_id =/.test(sql)) return [entries.filter(entry => entry.payment_id === params[0])];
      if (/FROM technician_wallets/.test(sql)) return [[wallet]];
      if (/FROM wallet_transactions/.test(sql)) return [[{ total_earned: entries.reduce((sum, entry) => sum + entry.amount, 0), total_paid_out: 0 }]];
      if (/FROM withdrawal_requests/.test(sql)) return [[{ pending_withdrawals: 0 }]];
      throw new Error(`Unexpected wallet backfill query: ${sql}`);
    }, execute: async (sql, params = []) => {
      if (/INSERT INTO wallet_transactions/.test(sql)) {
        const entry = { id: 44 + entries.length, payment_id: params[3], amount: params[7] };
        entries.push(entry); return [{ insertId: entry.id }];
      }
      if (/UPDATE technician_wallets/.test(sql)) { wallet.total_earned = params[0]; wallet.withdrawable_balance = params[1]; return [{ affectedRows: 1 }]; }
      if (/UPDATE payments/.test(sql)) { payment.wallet_transaction_id = params[8]; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected wallet backfill mutation: ${sql}`);
    } };
  return { payment, wallet, entries, pool: { query: async () => [payment.wallet_transaction_id ? [] : [payment]], getConnection: async () => conn } };
}

test("wallet backfill credits recorded technician earnings rather than the customer base including tax", async () => {
  const scenario = walletScenario();
  const result = await backfillMarketplaceWalletCredits(scenario.pool);
  assert.equal(result.creditsCreated, 1);
  assert.equal(scenario.entries[0].amount, 1000);
  assert.equal(scenario.wallet.withdrawable_balance, 1000);
  const retry = await backfillMarketplaceWalletCredits(scenario.pool);
  assert.equal(retry.creditsCreated, 0);
  assert.equal(scenario.entries.length, 1);
});

for (const technician_amount of [null, 0]) {
  test(`wallet backfill retains a legacy base fallback when recorded earnings are ${technician_amount}`, async () => {
    const scenario = walletScenario({ technician_amount, base_amount: 700 });
    const result = await backfillMarketplaceWalletCredits(scenario.pool);
    assert.equal(result.creditsCreated, 1);
    assert.equal(scenario.entries[0].amount, 700);
  });
}

test("wallet backfill skips an invalid negative recorded earning instead of crediting tax-inclusive base", async () => {
  const scenario = walletScenario({ technician_amount: -50 });
  const result = await backfillMarketplaceWalletCredits(scenario.pool);
  assert.equal(result.creditsCreated, 0);
  assert.equal(scenario.entries.length, 0);
});

test("online order records the agreed technician earnings and funded customer amount", async () => {
  const res = response();
  await handler("/create-order")({ body: { requestId: 501 }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.gatewayCalls[0].amount, 132200);
  assert.equal(state.payments[0].base_amount, 1200);
  assert.equal(state.payments[0].technician_amount, 1200);
  assert.equal(JSON.parse(state.payments[0].pricing_snapshot).technician_amount, 1200);
});

test("online order creation rejects an assigned but unaccepted technician without calling the gateway", async () => {
  state.request = accepted({ status: "assigned" });
  const res = response();
  await handler("/create-order")({ body: { requestId: 501 }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(state.gatewayCalls.length, 0);
});

test("captured payment retains the checkout quote even if request discount fields change afterward", async () => {
  state.request = accepted({ applied_discount_amount: 0 });
  state.payments = [{ id: 31, service_request_id: 501, razorpay_order_id: "order_simulated", payment_method: "razorpay",
    status: "pending", currency: "INR", base_amount: 1200, technician_amount: 1200, platform_fee: 100, payment_fee: 2,
    amount: 1302, pricing_snapshot: JSON.stringify({ currency: "INR", base_amount: 1200, technician_amount: 1200,
      platform_fee: 100, original_platform_fee: 120, discount_amount: 20, payment_fee: 2, total_amount: 1302 }) }];
  const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    order_id: "order_simulated", id: "pay_simulated", amount: 130200, currency: "INR", status: "captured", captured: true } } } }));
  const signature = crypto.createHmac("sha256", "simulated-secret").update(body).digest("hex");
  const res = response();
  await razorpayWebhookHandler({ body, headers: { "x-razorpay-signature": signature } }, res);
  assert.equal(res.statusCode, 200);
  const capture = state.executions.find(item => /UPDATE payments/.test(item.sql) && /captured_at/.test(item.sql));
  assert.ok(capture);
  assert.equal(capture.params[2], 1302);
  assert.equal(capture.params[4], 100);
  assert.equal(capture.params[6], 1200);
});

test("even a correctly signed payment confirmation cannot price an unaccepted request", async () => {
  state.request = accepted({ status: "pending" });
  const signature = crypto.createHmac("sha256", "simulated-secret").update("order_simulated|pay_simulated").digest("hex");
  const res = response();
  await handler("/confirm")({ body: { requestId: 501, razorpay_order_id: "order_simulated", razorpay_payment_id: "pay_simulated", razorpay_signature: signature }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(state.payments.length, 0);
});

test("client confirmation does not overwrite an order's saved discount and total", async () => {
  state.request = accepted({ applied_discount_amount: 0 });
  state.payments = [{ id: 31, service_request_id: 501, razorpay_order_id: "order_simulated", payment_method: "razorpay",
    status: "pending", currency: "INR", base_amount: 1200, technician_amount: 1200, platform_fee: 100, payment_fee: 2, amount: 1302 }];
  const signature = crypto.createHmac("sha256", "simulated-secret").update("order_simulated|pay_simulated").digest("hex");
  const res = response();
  await handler("/confirm")({ body: { requestId: 501, razorpay_order_id: "order_simulated", razorpay_payment_id: "pay_simulated", razorpay_signature: signature }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 200);
  const verification = state.executions.find(item => /UPDATE payments/.test(item.sql) && /verified_at/.test(item.sql) && !/COALESCE/.test(item.sql));
  assert.ok(verification);
  assert.equal(verification.params[4], 1302);
  assert.equal(verification.params[6], 100);
});

test("a stale platform-priced order cannot settle a newly accepted technician quote", async () => {
  state.payments = [{ id: 31, service_request_id: 501, razorpay_order_id: "order_simulated", payment_method: "razorpay",
    status: "pending", currency: "INR", base_amount: 599, technician_amount: 900, platform_fee: 59.9, payment_fee: 2, amount: 660.9 }];
  const signature = crypto.createHmac("sha256", "simulated-secret").update("order_simulated|pay_simulated").digest("hex");
  const res = response();
  await handler("/confirm")({ body: { requestId: 501, razorpay_order_id: "order_simulated", razorpay_payment_id: "pay_simulated", razorpay_signature: signature }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(state.executions.length, 0);
  const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    order_id: "order_simulated", id: "pay_simulated", amount: 66090 } } } }));
  const webhookRes = response();
  await razorpayWebhookHandler({ body, headers: { "x-razorpay-signature": crypto.createHmac("sha256", "simulated-secret").update(body).digest("hex") } }, webhookRes);
  assert.equal(webhookRes.body.processed, false);
  assert.equal(webhookRes.body.reason, "stale_payment_quote");
  assert.equal(state.executions.length, 0);
});

const checkout = (extra = {}) => ({ id: 31, user_id: 3, service_request_id: 501, razorpay_order_id: "order_simulated", payment_method: "razorpay",
  status: "pending", currency: "INR", base_amount: 1200, technician_amount: 1200, platform_fee: 120, payment_fee: 2, amount: 1322, ...extra });
const confirmExisting = async () => {
  const signature = crypto.createHmac("sha256", "simulated-secret").update("order_simulated|pay_simulated").digest("hex");
  const res = response();
  await handler("/confirm")({ body: { requestId: 501, razorpay_order_id: "order_simulated", razorpay_payment_id: "pay_simulated", razorpay_signature: signature }, user: { userId: 3 } }, res);
  return res;
};
const capturedWebhook = async (extra = {}) => {
  const body = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
    order_id: "order_simulated", id: "pay_simulated", amount: 132200, currency: "INR", status: "captured", captured: true,
    notes: { requestId: "501", userId: "3" }, ...extra } } } }));
  const res = response();
  await razorpayWebhookHandler({ body, headers: { "x-razorpay-signature": crypto.createHmac("sha256", "simulated-secret").update(body).digest("hex") } }, res);
  return res;
};

test("missing checkout rows cannot be reconstructed from a captured older order and today's accepted quote", async () => {
  const res = await capturedWebhook({ amount: 10200 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, false);
  assert.equal(res.body.reason, "payment_row_not_found");
  assert.equal(state.executions.length, 0);
});

test("signed client IDs cannot reconstruct a missing immutable checkout agreement", async () => {
  const res = await confirmExisting();
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "PAYMENT_ORDER_NOT_FOUND");
  assert.equal(state.executions.length, 0);
  assert.equal(state.gatewayFetches.length, 0);
});

for (const [changes, reason] of [
  [{ amount: 10200 }, "captured_amount_mismatch"],
  [{ currency: "USD" }, "captured_currency_mismatch"],
  [{ amount: null }, "invalid_captured_price"],
  [{ currency: null }, "invalid_captured_price"],
  [{ notes: { requestId: "999", userId: "3" } }, "payment_request_mismatch"],
  [{ notes: { requestId: "501", userId: "99" } }, "payment_request_mismatch"],
]) {
  test(`signed capture rejects ${reason} without invoice or wallet writes: ${JSON.stringify(changes)}`, async () => {
    state.payments = [checkout()];
    const res = await capturedWebhook(changes);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.processed, false);
    assert.equal(res.body.reason, reason);
    assert.equal(state.executions.length, 0);
  });
}

for (const changes of [{ amount: 10200 }, { currency: "USD" }, { order_id: "order_someone_else" }, { notes: { requestId: "999" } }]) {
  test(`client confirmation validates gateway payment against its stored checkout: ${JSON.stringify(changes)}`, async () => {
    state.payments = [checkout()];
    state.gatewayPayment = changes;
    const res = await confirmExisting();
    assert.equal(res.statusCode, 409);
    assert.equal(state.executions.length, 0);
  });
}

test("an authorised payment waits for actual capture instead of marking the request paid", async () => {
  state.payments = [checkout()];
  state.gatewayPayment = { status: "authorized", captured: false };
  const res = await confirmExisting();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.immediateFinalization, false);
  assert.equal(state.executions.some(item => /captured_at/.test(item.sql)), false);
});

test("gateway verification failure leaves the stored checkout and request unsettled", async () => {
  state.payments = [checkout()];
  state.gatewayFailure = true;
  const res = await confirmExisting();
  assert.equal(res.statusCode, 500);
  assert.equal(state.executions.length, 0);
});

test("captured checkout remains bound to the customer who owns its request", async () => {
  state.payments = [checkout({ user_id: 99 })];
  const res = await capturedWebhook();
  assert.equal(res.body.processed, false);
  assert.equal(res.body.reason, "payment_request_mismatch");
  assert.equal(state.executions.length, 0);
});

for (const changes of [
  { base_amount: null, technician_amount: null },
  { base_amount: 0, technician_amount: 0 },
  { platform_fee: null },
  { amount: 1320 },
  { technician_amount: 1300 },
]) {
  test(`incomplete or unfunded stored checkout cannot be replaced with current request prices: ${JSON.stringify(changes)}`, async () => {
    state.request = accepted({ pricing_snapshot: null });
    state.payments = [checkout(changes)];
    const res = await capturedWebhook({ amount: Math.round(Number(state.payments[0].amount) * 100) });
    assert.equal(res.body.processed, false);
    assert.equal(res.body.reason, "invalid_checkout_contract");
    assert.equal(state.executions.length, 0);
  });
}

test("a valid historical stored checkout without a JSON snapshot can still settle its actual capture", async () => {
  state.request = accepted({ pricing_snapshot: null, amount: 700, technician_estimated_earning: 650 });
  state.payments = [checkout({ pricing_snapshot: null, base_amount: 700, technician_amount: 650, platform_fee: 70, payment_fee: 2, amount: 772 })];
  const res = await capturedWebhook({ amount: 77200 });
  assert.equal(res.body.processed, true);
  const capture = state.executions.find(item => /UPDATE payments/.test(item.sql) && /captured_at/.test(item.sql));
  assert.equal(capture.params[2], 772);
  assert.equal(capture.params[6], 650);
});

test("historical accepted jobs retain recorded service price without current profile repricing", async () => {
  state.request = accepted({ pricing_snapshot: null, amount: 700, technician_estimated_earning: 650, service_type: "car-battery", technician_pricing: '{"car-battery":9000}' });
  const res = response();
  await handler("/quote")({ body: { requestId: 501, paymentMode: "cash" }, user: { userId: 3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.breakdown.base_amount, 700);
  assert.equal(resolveServiceRequestTechnicianAmount(state.request), 650);
});

test("schema setup adds missing snapshots once and keeps the request schema in parity", async () => {
  await db.ensureServiceRequestsTable();
  await db.ensureDispatchOffersTable();
  await db.ensureServiceRequestsTable();
  await db.ensureDispatchOffersTable();
  assert.ok(state.createSql.every(sql => /pricing_snapshot JSON/.test(sql)));
  assert.deepEqual(state.ddl.map(sql => sql.match(/ALTER TABLE (\w+)/)[1]).sort(), ["dispatch_offers", "service_requests"]);
});

test("billing preserves the accepted platform fee discount when no new discount is requested", () => {
  const discounted = { ...snapshot(), platform_fee: 100, discount_amount: 20, customer_total_amount: 1302 };
  const result = buildServiceRequestPaymentDetails({ requestRow: accepted({ pricing_snapshot: discounted }) });
  assert.equal(result.platformFee, 100);
  assert.equal(result.discountAmount, 20);
  assert.equal(result.totalAmount, 1302);
});

test("accepted snapshot amount overrides stale customer finalAmount fields", () => {
  const result = buildServiceRequestPaymentDetails({ requestRow: accepted({ finalAmount: 660 }) });
  assert.equal(result.totalAmount, 1322);
});

test("stored checkout details retain their discount alongside their saved fee", () => {
  const result = buildServiceRequestPaymentDetails({ paymentRow: { base_amount: 1200, platform_fee: 100,
    payment_fee: 2, amount: 1302, payment_method: "razorpay", pricing_snapshot: JSON.stringify({
      original_platform_fee: 120, discount_amount: 20 }) } });
  assert.equal(result.discountAmount, 20);
  assert.equal(result.totalAmount, 1302);
});

test("the technician amount excludes customer taxes and platform/payment fees", () => {
  const taxed = { ...snapshot(), customer_base_amount: 1320, customer_total_amount: 1454, platform_fee: 132,
    pricing_breakdown: { tax_percent: 0.1, tax_amount: 120 } };
  const row = accepted({ pricing_snapshot: taxed });
  const result = buildServiceRequestPaymentDetails({ requestRow: row });
  assert.equal(result.baseAmount, 1320);
  assert.equal(resolveServiceRequestTechnicianAmount(row), 1200);
});

for (const status of ["pending", "assigned"]) {
  test(`cash payment cannot bypass acceptance for ${status} requests`, async () => {
    state.request = accepted({ status, accepted_time: null });
    const res = response();
    await handler("/cash")({ body: { requestId: 501 }, user: { userId: 3 } }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /accept/i);
  });
}
