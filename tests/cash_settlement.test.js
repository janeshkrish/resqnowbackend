import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import Razorpay from 'razorpay';
import jwt from 'jsonwebtoken';
import * as db from '../db.js';
import { socketService } from '../services/socket.js';
import { getPlatformPricingConfig } from '../services/platformPricing.js';

const USER = '11111111-1111-4111-8111-111111111111';
const TECH = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const PAYMENT = '44444444-4444-4444-8444-444444444444';
const WALLET = '55555555-5555-4555-8555-555555555555';
const SECRET = 'cash-settlement-fixture-secret';
Object.assign(process.env, { NODE_ENV: 'test', DB_MIGRATION_MODE: 'off', DB_HOST: 'simulated.invalid',
  DB_NAME: 'fixture', DB_USER: 'fixture', DB_PASSWORD: 'fixture',
  RAZORPAY_KEY_ID: 'rzp_test_cash_fixture', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET, JWT_SECRET: SECRET });
const copy = value => structuredClone(value);
let state, tail, initialReads, releaseReads, readsReady;
let writeEntered, writeReady, resumeWrite, writePaused;

async function query(sql, args = [], tx = null) {
  if (sql === 'SELECT 1') return [[{ result: 1 }]];
  if (/^UPDATE technicians SET current_job_id/.test(sql)) { assert.ok(tx?.requestLocked); state.releases++; state.technician.current_job_id = null; return [{ affectedRows: 1 }]; }
  if (/^UPDATE technicians/.test(sql)) { assert.ok(tx?.requestLocked); state.technician.is_available = 1; return [{ affectedRows: 1 }]; }
  if (/FROM platform_pricing_config/.test(sql)) return [[{ id: USER, currency: state.pricingCurrency || 'INR', welcome_coupon_active: false }]];
  if (/COUNT\(\*\)/.test(sql)) return [[{ count: 0 }]];
  if (/SUM\(COALESCE\(p.platform_fee/.test(sql)) {
    if (state.failNotifications) throw new Error('Simulated post-commit read failure');
    return [[{ total: state.payments.filter(p => p.payment_method === 'cash' && p.status === 'completed' && !p.is_settled).reduce((sum,p) => sum + p.platform_fee, 0) }]];
  }
  if (/FROM service_requests/.test(sql)) {
    if (tx && /FROM service_requests sr/.test(sql)) assert.match(sql, /FOR UPDATE\s*$/, 'financial state must be re-read under its request lock');
    if (/FOR UPDATE/.test(sql) && tx) {
      if (/JOIN/.test(sql)) assert.ok(tx.requestLocked, 'lock the request alone before joining other accounts');
      tx.requestLocked = true;
    }
    if (/FOR UPDATE/.test(sql) && state.stageBeforeCashLock) { state.request.status = state.stageBeforeCashLock; state.stageBeforeCashLock = null; }
    let row = args[0] === JOB && (!/user_id = \?/.test(sql) || args[1] === state.request.user_id) &&
      (!/WHERE.*technician_id = \?/s.test(sql) || args[1] === state.request.technician_id) ? copy(state.request) : null;
    // Reproduce the original race: both outer reads see unpaid snapshots.
    if (!tx && /FROM service_requests sr/.test(sql) && state.raceReads) {
      if (++initialReads === state.raceReads) releaseReads();
      await readsReady;
    }
    return [row ? [row] : []];
  }
  if (/FROM account_payment_orders/.test(sql)) return [[]];
  if (/FROM payments/.test(sql)) {
    if (tx && /FOR UPDATE/.test(sql)) assert.ok(tx.requestLocked, 'payment locks follow the shared request lock');
    let rows = state.payments;
    if (/service_request_id = \? AND razorpay_order_id = \?/.test(sql)) rows = rows.filter(p => p.service_request_id === args[0] && p.razorpay_order_id === args[1]);
    else if (/razorpay_order_id = \?/.test(sql)) rows = rows.filter(p => p.razorpay_order_id === args[0]);
    else if (/service_request_id = \?/.test(sql)) rows = rows.filter(p => p.service_request_id === args[0]);
    if (/IN \('completed', 'paid'\)/.test(sql)) rows = rows.filter(p => ['completed','paid'].includes(p.status) || (/OR settlement_key IS NOT NULL/.test(sql) && p.settlement_key != null));
    if (/IN \('pending', 'processing'\)/.test(sql)) rows = rows.filter(p => ['pending','processing'].includes(p.status.toLowerCase()) && !p.razorpay_payment_id);
    return [copy(rows)];
  }
  if (/FROM invoices/.test(sql)) {
    let rows = state.invoices;
    if (/service_request_id = \?/.test(sql)) rows = rows.filter(row => row.service_request_id === args[0]);
    else if (/order_id = \?/.test(sql)) rows = rows.filter(row => row.order_id === args[0] || row.razorpay_payment_id === args[1]);
    return [copy(rows)];
  }
  if (/FROM technician_wallets/.test(sql)) return [[copy(state.wallet)]];
  if (/FROM wallet_transactions/.test(sql)) {
    if (/SUM\(/.test(sql)) return [[{ total_earned: state.wallet_transactions.reduce((sum,row) => sum + row.amount, 0), total_paid_out: 0 }]];
    return [copy(state.wallet_transactions.filter(row => row.payment_id === args[0]))];
  }
  if (/FROM withdrawal_requests/.test(sql)) return [[{ pending_withdrawals: 0 }]];
  throw new Error(`Unexpected SQL query: ${sql}`);
}

async function execute(sql, args = [], tx = null) {
  if (tx) assert.ok(tx.requestLocked, 'accounting mutations require the request lock');
  if (/^\s*INSERT INTO/.test(sql)) {
    const [,table,columns] = sql.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/s);
    if (state.failInsert === table) throw new Error(`Simulated ${table} insert failure`);
    const row = Object.fromEntries(columns.split(',').map((col,i) => [col.trim(), args[i]]));
    if (row.settlement_key && state.payments.some(p => p.settlement_key === row.settlement_key)) {
      throw Object.assign(new Error('Duplicate settlement'), { code: 'ER_DUP_ENTRY' });
    }
    state[table].push(row);
    return [{ affectedRows: 1, insertId: 0 }];
  }
  if (/UPDATE service_requests/.test(sql)) {
    if (/SET cash_payment_intent/.test(sql)) {
      Object.assign(state.request, { cash_payment_intent: args[0], payment_method: args[1], applied_coupon_code: args[2], applied_discount_percent: args[3], applied_discount_amount: args[4] });
      return [{ affectedRows: 1 }];
    }
    if (state.pauseRequestPaymentState && /SET payment_method/.test(sql)) {
      state.pauseRequestPaymentState = false; writeEntered(); await writePaused;
    }
    if (/NOT EXISTS/.test(sql) && (['paid','completed'].includes(state.request.payment_status) || state.payments.some(p => p.settlement_key || ['paid','completed'].includes(p.status)))) return [{ affectedRows: 0 }];
    if (/cancelled_at/.test(sql)) Object.assign(state.request, { status: 'cancelled', technician_id: null });
    else if (/SET payment_method/.test(sql)) { state.request.payment_method = args[0]; if (/payment_status = \?/.test(sql)) state.request.payment_status = args[1]; }
    else Object.assign(state.request, { payment_status: args[0], payment_method: args[1], status: args[2], amount: args[3], final_price: args[4] });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE payments/.test(sql)) {
    const row = state.payments.find(p => p.id === args.at(-1)); assert.ok(row);
    if (state.pausePaymentStatus && state.pausePaymentStatus === args[0]) { state.pausePaymentStatus = null; writeEntered(); await writePaused; }
    if (/settlement_key IS NULL/.test(sql) && (row.settlement_key != null || ['completed','paid'].includes(row.status.toLowerCase()))) return [{ affectedRows: 0 }];
    if (/COALESCE/.test(sql)) Object.assign(row, { ledger_status: args[7], wallet_transaction_id: args[8] });
    else if (/SET settlement_key/.test(sql)) {
      if (state.payments.some(p => p !== row && p.settlement_key === args[0])) throw Object.assign(new Error('Duplicate settlement'), { code: 'ER_DUP_ENTRY' });
      row.settlement_key = args[0];
    } else if (args[0] === 'PROCESSING') Object.assign(row, { status: args[0], razorpay_payment_id: args[1], currency: args[3], amount: args[4], base_amount: args[5], platform_fee: args[6], payment_fee: args[7], technician_amount: args[8] });
    else Object.assign(row, { status: args[0], currency: args[1], amount: args[2], base_amount: args[3], platform_fee: args[4], payment_fee: args[5], technician_amount: args[6], ...(args[0] === 'PENDING' ? {} : { razorpay_payment_id: args[7] }) });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE invoices/.test(sql)) return [{ affectedRows: 1 }];
  if (/UPDATE technician_wallets/.test(sql)) { Object.assign(state.wallet, { total_earned: args[0], withdrawable_balance: args[1] }); return [{ affectedRows: 1 }]; }
  if (/UPDATE technicians/.test(sql)) { state.technician.jobs_completed++; return [{ affectedRows: 1 }]; }
  throw new Error(`Unexpected SQL mutation: ${sql}`);
}
const pool = { query, execute, end: async () => {}, getConnection: async () => {
  let unlock, snapshot, committing = false; const tx = { requestLocked: false };
  return { query: (sql,args) => query(sql,args,tx), execute: (sql,args) => execute(sql,args,tx),
    beginTransaction: async () => { const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous; snapshot = copy(state); },
    commit: async () => {
      committing = true;
      try {
        if (state.delayCommit) await new Promise(resolve => setTimeout(resolve,10));
        if (state.failCommit) throw new Error('Simulated commit failure');
        snapshot = null; unlock?.(); unlock = null;
      } finally { committing = false; }
    },
    rollback: async () => { if (snapshot) state = snapshot; snapshot = null; unlock?.(); unlock = null; },
    release: () => { if (committing) state.releasedDuringCommit = true; unlock?.(); unlock = null; },
  };
} };
const driver = mock.method(mysql, 'createPool', () => pool);
const gateway = mock.method(Razorpay.prototype, 'addResources', function () {
  this.orders = { create: async options => ({ id: 'order_created', ...options }) };
  this.payments = { fetch: async id => ({ id, order_id: 'order_fixture', amount: 11200, currency: 'INR', status: 'captured', captured: true,
    notes: { requestId: JOB, userId: USER } }) };
});
const sockets = ['notifyUser','notifyTechnician','notifyAdmins','broadcast'].map(name => mock.method(socketService, name, () => {}));
const { default: router, razorpayWebhookHandler } = await import('../routes/payments.js');
const { handleCustomerCancel } = await import('../routes/service_requests.js');
beforeEach(async () => {
  state = { request: { id: JOB, user_id: USER, technician_id: TECH, service_type: 'battery', vehicle_type: 'car',
    status: 'awaiting_payment', payment_status: 'pending', payment_method: 'cash', amount: 100, technician_estimated_earning: 100,
    accepted_time: '2026-10-31T00:00:00Z', address: 'Fixture address',
    pricing_snapshot: JSON.stringify({ version: 1, request_id: JOB, technician_id: TECH, currency: 'INR',
      technician_earning: 100, customer_base_amount: 100, customer_total_amount: 112, payment_mode: 'upi',
      platform_fee: 10, payment_fee: 2, discount_amount: 0, pricing_breakdown: {}, earnings_source: 'technician_pricing', calculated_at: '2026-10-31T00:00:00Z' }) },
    payments: [], invoices: [], wallet_transactions: [], releases: 0,
    technician: { id: TECH, jobs_completed: 0, current_job_id: JOB, is_available: 0 },
    wallet: { id: WALLET, technician_id: TECH, total_earned: 0, withdrawable_balance: 0 } };
  tail = Promise.resolve(); initialReads = 0; readsReady = new Promise(resolve => { releaseReads = resolve; });
  writeReady = new Promise(resolve => { writeEntered = resolve; }); writePaused = new Promise(resolve => { resumeWrite = resolve; });
  await getPlatformPricingConfig({ forceRefresh: true });
});
after(async () => { await db.closePool(); driver.mock.restore(); gateway.mock.restore(); sockets.forEach(item => item.mock.restore()); });
const response = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } });
const cancel = async () => { const res = response(); await handleCustomerCancel({ params: { id: JOB }, user: { userId: USER }, body: {} },res); return res; };
const seedOnline = () => state.payments.push({ id: PAYMENT, user_id: USER, service_request_id: JOB, payment_method: 'razorpay', status: 'pending',
  currency: 'INR', amount: 112, base_amount: 100, platform_fee: 10, payment_fee: 2, technician_amount: 100, razorpay_order_id: 'order_fixture' });
const capture = async (orderId = 'order_fixture', paymentId = 'pay_fixture') => {
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: {
    id: paymentId, order_id: orderId, amount: 11200, currency: 'INR', status: 'captured', captured: true,
    notes: { requestId: JOB, userId: USER } } } } }));
  const res = response();
  await razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': crypto.createHmac('sha256',SECRET).update(raw).digest('hex') } },res);
  return res;
};
const completed = () => state.payments.filter(p => p.status === 'completed');
const cashRoute = async (path, body, role = 'user', owner = USER) => {
  const res = response(); const route = router.stack.find(layer => layer.route?.path === path)?.route;
  assert.ok(route, 'cash receipt confirmation must be provided through an authenticated endpoint');
  const payload = role === 'technician' ? { role, id: owner } : { role, userId: owner, id: owner };
  const req = { body, headers: { authorization: `Bearer ${jwt.sign(payload,SECRET)}` } };
  for (const layer of route.stack.slice(0,-1)) {
    let proceeded = false; await layer.handle(req,res,() => { proceeded = true; }); if (!proceeded) return res;
  }
  await route.stack.at(-1).handle(req,res); return res;
};
const chooseCash = (extra = {}, owner = USER) => cashRoute('/cash', { requestId: JOB, ...extra }, 'user', owner);
const confirmCash = (intent, extra = {}, owner = TECH, role = 'technician') => {
  assert.ok(intent,'customer cash choice must save an intent before receipt confirmation');
  return cashRoute('/cash/confirm', {
  requestId: JOB, received: true, intentId: intent.intentId, amountPaise: intent.amountPaise, currency: intent.currency, ...extra,
},role,owner);
};
// QA-003 financial regressions now exercise the two authenticated participants.
const cash = async (owner = USER, extra = {}) => {
  const choice = await chooseCash(extra,owner);
  return choice.body?.pendingReceipt ? confirmCash(choice.body.cash_intent) : choice;
};
const onlineRequest = async path => {
  const res = response();
  await router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle({ user: { userId: USER }, body: {
    requestId: JOB, razorpay_order_id: 'order_fixture', razorpay_payment_id: 'pay_fixture',
    razorpay_signature: crypto.createHmac('sha256',SECRET).update('order_fixture|pay_fixture').digest('hex'),
  } },res);
  return res;
};

test('concurrent cash calls produce one payment, invoice, job completion, release and cash fee', async () => {
  state.raceReads = 2;
  const results = await Promise.all([cash(),cash()]);
  assert.ok(results.every(res => res.body.success));
  assert.equal(state.payments.length, 1); assert.equal(state.invoices.length, 1);
  assert.equal(state.technician.jobs_completed, 1); assert.equal(state.releases, 1);
  assert.equal(state.payments.reduce((sum,p) => sum + p.platform_fee,0), 10);
  assert.equal(results[0].body.payment_id, results[1].body.payment_id);
  assert.equal(results[0].body.invoice_id, results[1].body.invoice_id);
});
test('cash replay returns the original payment/invoice without new accounting', async () => {
  const first = await cash(); const next = await cash();
  assert.ok(first.body.payment_id); assert.ok(first.body.invoice_id);
  assert.equal(next.body.payment_id, first.body.payment_id); assert.equal(next.body.invoice_id, first.body.invoice_id);
  assert.equal(next.body.alreadyPaid, true); assert.equal(state.technician.jobs_completed,1);
});
test('cash cannot claim an already-completed online payment', async () => {
  seedOnline(); state.payments[0].status = 'completed'; state.request.payment_status = 'paid';
  const res = await cash(); assert.equal(res.statusCode,409); assert.equal(state.payments.length,1); assert.equal(state.invoices.length,0);
});
test('cash winning rejects a later captured online order without a wallet credit', async () => {
  seedOnline(); assert.equal((await cash()).body.success,true);
  const res = await capture(); assert.equal(res.body.processed,false);
  assert.equal(completed().length,1); assert.equal(completed()[0].payment_method,'cash');
  assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,0); assert.equal(state.technician.jobs_completed,1);
});
test('capture winning rejects cash with one invoice, job completion and wallet credit', async () => {
  seedOnline(); assert.equal((await capture()).body.processed,true);
  assert.equal((await cash()).statusCode,409);
  assert.equal(completed().length,1); assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
  assert.equal(state.technician.jobs_completed,1);
});
test('cash and capture racing choose a single financial winner', async () => {
  seedOnline(); await Promise.all([cash(),capture()]);
  assert.equal(completed().length,1); assert.equal(state.invoices.length,1); assert.equal(state.technician.jobs_completed,1);
  const isCash = completed()[0].payment_method === 'cash';
  assert.equal(state.wallet_transactions.length,isCash ? 0 : 1);
  assert.equal(state.payments.filter(p => p.payment_method === 'cash' && p.status === 'completed').length,isCash ? 1 : 0);
});
test('cancellation winning cannot be resurrected by cash or capture', async () => {
  state.request.status = 'accepted'; seedOnline(); assert.equal((await cancel()).body.success,true);
  assert.equal((await cash()).statusCode,409); assert.equal((await capture()).body.processed,false);
  assert.equal(state.request.status,'cancelled'); assert.equal(completed().length,0); assert.equal(state.invoices.length,0);
});
test('cash and cancellation racing never leave a cancelled paid request', async () => {
  state.request.status = 'accepted';
  await Promise.all([cash(),cancel()]);
  if (state.request.status === 'cancelled') { assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0); }
  else { assert.equal(state.request.payment_status,'paid'); assert.equal(state.payments.length,1); assert.equal(state.invoices.length,1); }
});
for (const table of ['payments','invoices']) test(`${table} failure rolls back cash accounting and permits one retry`, async () => {
  state.failInsert = table; assert.equal((await cash()).statusCode,500);
  assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0); assert.equal(state.technician.jobs_completed,0);
  state.failInsert = null; assert.equal((await cash()).body.success,true);
  assert.equal(state.payments.length,1); assert.equal(state.invoices.length,1); assert.equal(state.technician.jobs_completed,1);
});
test('unknown owner is rejected without financial writes', async () => {
  assert.equal((await cash(TECH)).statusCode,404); assert.equal(state.payments.length,0);
});

test('cash retries reuse a legacy receipt even when the old payment has no settlement key', async () => {
  const first = await cash(); delete state.payments[0].settlement_key;
  state.invoices[0].order_id = `cash_${JOB}_legacy_timestamp`;
  const res = await cash();
  assert.equal(res.body.payment_id,first.body.payment_id); assert.equal(res.body.invoice_id,first.body.invoice_id);
  assert.equal(state.payments.length,1); assert.equal(state.invoices.length,1); assert.equal(state.technician.jobs_completed,1);
});
test('cash retries preserve the original price and ignore a newly supplied coupon', async () => {
  const first = await cash(); state.request.amount = 500;
  const res = await cash(USER,{ couponCode: 'CHANGED' });
  assert.equal(res.body.payment_id,first.body.payment_id); assert.equal(state.payments[0].amount,110);
  assert.equal(state.invoices[0].total_amount,110); assert.equal(state.invoices.length,1);
});
test('ambiguous legacy cash payments require reconciliation without deleting or duplicating history', async () => {
  await cash(); delete state.payments[0].settlement_key;
  state.payments.push({ ...copy(state.payments[0]), id: PAYMENT });
  const res = await cash(); assert.equal(res.statusCode,409); assert.equal(res.body.code,'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(state.payments.length,2); assert.equal(state.invoices.length,1); assert.equal(state.technician.jobs_completed,1);
});
test('ambiguous legacy cash invoices require reconciliation', async () => {
  await cash(); state.invoices.push({ ...copy(state.invoices[0]), id: PAYMENT });
  assert.equal((await cash()).statusCode,409); assert.equal(state.payments.length,1); assert.equal(state.invoices.length,2);
});
test('an orphan legacy cash invoice cannot trigger another financial finalization', async () => {
  state.invoices.push({ id: PAYMENT, service_request_id: JOB, user_id: USER, order_id: `cash_${JOB}_old`, razorpay_payment_id: null });
  assert.equal((await cash()).statusCode,409); assert.equal(state.payments.length,0); assert.equal(state.technician.jobs_completed,0);
});
test('paid flags without an accounting record fail closed instead of claiming successful cash payment', async () => {
  state.request.payment_status = 'paid'; assert.equal((await cash()).statusCode,409);
  assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0);
});
test('a post-commit notification failure cannot cause duplicate accounting on retry', async () => {
  state.failNotifications = true; assert.equal((await cash()).statusCode,500);
  assert.equal(state.payments.length,1); assert.equal(state.invoices.length,1);
  const paymentId = state.payments[0].id, invoiceId = state.invoices[0].id;
  state.failNotifications = false; const res = await cash();
  assert.equal(res.body.payment_id,paymentId); assert.equal(res.body.invoice_id,invoiceId);
  assert.equal(state.technician.jobs_completed,1); assert.equal(state.releases,1);
});
test('online capture replay reuses its receipt and does not release or credit again', async () => {
  seedOnline(); assert.equal((await capture()).body.processed,true);
  state.request.status = 'closed'; const res = await capture();
  assert.equal(res.body.processed,true); assert.equal(res.body.duplicate,true);
  assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
  assert.equal(state.technician.jobs_completed,1); assert.equal(state.releases,1); assert.equal(state.request.status,'closed');
});
test('a second online order cannot settle the same request again', async () => {
  seedOnline(); state.payments.push({ ...copy(state.payments[0]), id: WALLET, razorpay_order_id: 'order_other' });
  assert.equal((await capture()).body.processed,true);
  assert.equal((await capture('order_other','pay_other')).body.processed,false);
  assert.equal(completed().length,1); assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
});
test('wallet credit failure rolls back capture and its settlement key before retry', async () => {
  seedOnline(); state.failInsert = 'wallet_transactions'; assert.equal((await capture()).statusCode,500);
  assert.equal(state.payments[0].status,'pending'); assert.equal(state.payments[0].settlement_key,undefined);
  assert.equal(state.invoices.length,0); assert.equal(state.wallet_transactions.length,0); assert.equal(state.technician.jobs_completed,0);
  state.failInsert = null; assert.equal((await capture()).body.processed,true);
  assert.equal(completed().length,1); assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
});

for (const [path, status] of [['/create-order','PENDING'],['/confirm','PROCESSING']]) {
  test(`a delayed ${path} cannot reopen a towing settlement after capture wins`, async () => {
    state.request.service_type = 'towing'; seedOnline(); state.pausePaymentStatus = status;
    const pending = onlineRequest(path);
    await Promise.race([writeReady, pending.then(res => assert.fail(`Expected the pending write to pause, got ${res.statusCode}: ${JSON.stringify(res.body)}`))]);
    assert.equal((await capture()).body.processed,true);
    resumeWrite(); await pending;
    assert.equal(state.payments[0].status,'completed'); assert.equal(state.request.payment_status,'paid');
    const replay = await capture(); assert.equal(replay.body.processed,true); assert.equal(replay.body.duplicate,true);
    assert.equal(state.technician.jobs_completed,1); assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
  });
}
test('a durable settlement key prevents repeating accounting even if legacy status flags were regressed', async () => {
  state.request.service_type = 'towing'; seedOnline(); await capture();
  state.payments[0].status = 'PROCESSING'; state.request.payment_status = 'pending';
  const res = await capture();
  assert.equal(res.body.processed,false); assert.equal(res.body.reason,'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(state.technician.jobs_completed,1); assert.equal(state.invoices.length,1); assert.equal(state.wallet_transactions.length,1);
});

for (const reused of [false,true]) test(`delayed ${reused ? 'reused' : 'fresh'} checkout cannot replace cash-paid request flags`, async () => {
  if (reused) seedOnline();
  state.pauseRequestPaymentState = true;
  const pending = onlineRequest('/create-order');
  await Promise.race([writeReady,pending.then(res => assert.fail(`Checkout did not reach its guarded write: ${res.statusCode}`))]);
  assert.equal((await cash()).body.success,true);
  resumeWrite(); const res = await pending;
  assert.equal(res.statusCode,409); assert.equal(state.request.payment_status,'paid'); assert.equal(state.request.payment_method,'cash');
  assert.equal(completed().length,1); assert.equal(state.invoices.length,1); assert.equal(state.technician.jobs_completed,1);
});

test('delayed confirmation cannot replace the winning cash payment method', async () => {
  seedOnline(); state.pauseRequestPaymentState = true;
  const pending = onlineRequest('/confirm');
  await Promise.race([writeReady,pending.then(res => assert.fail(`Confirmation did not reach its method write: ${res.statusCode}`))]);
  assert.equal((await cash()).body.success,true); resumeWrite();
  assert.equal((await pending).statusCode,409); assert.equal(state.request.payment_method,'cash');
  assert.equal(state.request.payment_status,'paid'); assert.equal(completed().length,1); assert.equal(state.wallet_transactions.length,0);
});

for (const [serviceType,status] of [
  ['battery','accepted'],['battery','en-route'],['battery','service_started'],
  ['towing','accepted'],['towing','en_route_pickup'],['towing','vehicle_loaded'],['towing','enroute_drop'],['towing','arrived_drop'],
]) test(`QA-004 rejects customer cash at ${serviceType}/${status} without operational or financial effects`, async () => {
  state.request.service_type = serviceType; state.request.status = status;
  const before = copy(state.request); const res = await chooseCash({ received: true, technicianId: TECH });
  assert.equal(res.statusCode,409); assert.equal(res.body.code,'CASH_STAGE_NOT_PAYABLE');
  assert.deepEqual(state.request,before); assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0);
  assert.equal(state.technician.jobs_completed,0); assert.equal(state.releases,0);
});

for (const [serviceType,status] of [
  ['battery','awaiting_payment'],['battery','payment_pending'],['towing','service_completed'],['towing','payment_pending'],
]) test(`QA-004 cash choice at ${serviceType}/${status} waits for technician receipt without advancing the job`, async () => {
  state.request.service_type = serviceType; state.request.status = status;
  const res = await chooseCash();
  assert.equal(res.statusCode,200); assert.equal(res.body.pendingReceipt,true);
  assert.ok(res.body.cash_intent.intentId); assert.equal(res.body.cash_intent.amountPaise,11000);
  assert.equal(state.request.status,status); assert.equal(state.request.payment_status,'pending');
  assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0);
  assert.equal(state.technician.jobs_completed,0); assert.equal(state.releases,0); assert.equal(state.technician.current_job_id,JOB);
});

test('QA-004 only the assigned technician can acknowledge a selected cash receipt', async () => {
  const intent = (await chooseCash()).body.cash_intent;
  assert.equal((await confirmCash(intent,{},USER,'user')).statusCode,403);
  assert.equal((await confirmCash(intent,{},WALLET)).statusCode,404);
  assert.equal(state.payments.length,0); assert.equal(state.technician.jobs_completed,0);
});
for (const [name,extra,want] of [
  ['no acknowledgement',{ received: false },400],['wrong intent',{ intentId: PAYMENT },409],
  ['wrong amount',{ amountPaise: 1 },409],['wrong currency',{ currency: 'USD' },409],
]) test(`QA-004 rejects ${name} before financial writes`, async () => {
  const intent = (await chooseCash()).body.cash_intent;
  assert.equal((await confirmCash(intent,extra)).statusCode,want);
  assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0); assert.equal(state.releases,0);
});
test('QA-004 receipt completion records the trusted actor, intent and amount exactly once', async () => {
  const intent = (await chooseCash()).body.cash_intent;
  const results = await Promise.all([confirmCash(intent),confirmCash(intent)]);
  assert.ok(results.every(res => res.body.success)); assert.equal(state.payments.length,1); assert.equal(state.invoices.length,1);
  assert.equal(state.technician.jobs_completed,1); assert.equal(state.releases,1);
  const proof = JSON.parse(state.payments[0].pricing_snapshot).cashReceipt;
  assert.equal(proof.technicianId,TECH); assert.equal(proof.intentId,intent.intentId); assert.equal(proof.amountPaise,11000);
  assert.equal(proof.currency,'INR'); assert.ok(Number.isFinite(Date.parse(proof.receivedAt)));
});
test('QA-004 towing receipt does not skip its service-completed stage or release the technician', async () => {
  state.request.service_type = 'towing'; state.request.status = 'service_completed';
  const intent = (await chooseCash()).body.cash_intent;
  assert.equal((await confirmCash(intent)).body.success,true);
  assert.equal(state.request.status,'service_completed'); assert.equal(state.request.payment_status,'paid');
  assert.equal(state.releases,0); assert.equal(state.technician.current_job_id,JOB);
});
test('QA-004 a changed current stage under the lock prevents receipt settlement', async () => {
  const intent = (await chooseCash()).body.cash_intent; state.stageBeforeCashLock = 'accepted';
  assert.equal((await confirmCash(intent)).statusCode,409); assert.equal(state.payments.length,0);
});
test('QA-004 reassignment invalidates the original technician receipt intent', async () => {
  const intent = (await chooseCash()).body.cash_intent; state.request.technician_id = WALLET;
  assert.equal((await confirmCash(intent)).statusCode,404);
  assert.equal((await confirmCash(intent,{},WALLET)).statusCode,409); assert.equal(state.payments.length,0);
});
test('QA-004 switching back to online invalidates a stale cash confirmation', async () => {
  const intent = (await chooseCash()).body.cash_intent; state.request.payment_method = 'razorpay';
  assert.equal((await confirmCash(intent)).statusCode,409); assert.equal(state.payments.length,0);
});

test('QA-004 retrying the same customer cash choice reuses its intent without financial writes', async () => {
  const first = await chooseCash(); const next = await chooseCash();
  assert.equal(first.body.cash_intent.intentId,next.body.cash_intent.intentId); assert.equal(next.body.pendingReceipt,true);
  assert.equal(state.payments.length,0); assert.equal(state.technician.jobs_completed,0);
});
test('QA-004 a changed accepted quote invalidates the old amount and receipt identity', async () => {
  const previous = (await chooseCash()).body.cash_intent;
  const snapshot = JSON.parse(state.request.pricing_snapshot);
  Object.assign(snapshot,{ technician_earning: 200, customer_base_amount: 200, customer_total_amount: 222, platform_fee: 20 });
  Object.assign(state.request,{ pricing_snapshot: JSON.stringify(snapshot), amount: 200, technician_estimated_earning: 200 });
  assert.equal((await confirmCash(previous)).statusCode,409); assert.equal(state.payments.length,0);
  const current = (await chooseCash()).body.cash_intent;
  assert.notEqual(current.intentId,previous.intentId); assert.equal(current.amountPaise,22000);
  assert.equal((await confirmCash(previous)).statusCode,409);
  assert.equal((await confirmCash(current)).body.success,true); assert.equal(state.payments[0].amount,220);
});

test('QA-004 a platform currency change cannot create a differently denominated cash receipt', async () => {
  state.pricingCurrency = 'USD'; await getPlatformPricingConfig({ forceRefresh: true });
  const res = await chooseCash();
  assert.equal(res.statusCode,409); assert.equal(state.request.cash_payment_intent,undefined);
  assert.equal(state.payments.length,0); assert.equal(state.invoices.length,0);
});
test('QA-004 a saved intent retains its agreed currency after platform configuration changes', async () => {
  const intent = (await chooseCash()).body.cash_intent;
  state.pricingCurrency = 'USD'; await getPlatformPricingConfig({ forceRefresh: true });
  assert.equal((await confirmCash(intent)).body.success,true); assert.equal(state.payments[0].currency,'INR');
});

test('QA-004 declaration waits for commit before releasing its connection', async () => {
  state.delayCommit = true; assert.equal((await chooseCash()).body.pendingReceipt,true);
  assert.notEqual(state.releasedDuringCommit,true);
});
test('QA-004 declaration commit failure rolls back and returns a server error', async () => {
  state.failCommit = true;
  const res = await chooseCash().catch(() => ({ statusCode: 0 }));
  assert.equal(res.statusCode,500); assert.equal(state.request.cash_payment_intent,undefined);
  assert.equal(state.payments.length,0);
});
