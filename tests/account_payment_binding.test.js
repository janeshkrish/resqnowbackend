import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import Razorpay from 'razorpay';
import * as db from '../db.js';
import { isUuid } from '../models/identifiers.js';
import { getPlatformPricingConfig } from '../services/platformPricing.js';

// Keep the real router, UUID persistence and payment logic; replace only SQL and
// the remote gateway. Fixtures never load .env or start the application server.
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const TECH = '33333333-3333-4333-8333-333333333333';
const OTHER_TECH = '44444444-4444-4444-8444-444444444444';
const SECRET = 'account-payment-test-secret';
Object.assign(process.env, { NODE_ENV: 'test', DB_MIGRATION_MODE: 'off', DB_HOST: 'simulated.invalid',
  DB_USER: 'fixture', DB_PASSWORD: 'fixture', DB_NAME: 'fixture',
  RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: SECRET });

let state;
let transactionTail = Promise.resolve();
const copy = value => structuredClone(value);
const execute = async (sql, args = []) => {
  if (/INSERT INTO account_payment_orders/.test(sql)) {
    if (state.failInsert) throw new Error('Simulated ledger write failure');
    const columns = sql.match(/account_payment_orders\s*\(([^)]+)\)/s)[1].split(',').map(s => s.trim());
    const row = Object.fromEntries(columns.map((column, i) => [column, args[i]]));
    if (state.bindings.some(item => item.razorpay_order_id === row.razorpay_order_id)) {
      throw Object.assign(new Error('Duplicate order'), { code: 'ER_DUP_ENTRY' });
    }
    state.bindings.push(row);
    return [{ affectedRows: 1, insertId: 0 }];
  }
  if (/UPDATE account_payment_orders/.test(sql)) {
    const row = state.bindings.find(item => item.id === args.at(-1));
    assert.ok(row, 'the consumed checkout must exist');
    if (state.bindings.some(item => item !== row && item.razorpay_payment_id === args[0])) {
      throw Object.assign(new Error('Duplicate payment'), { code: 'ER_DUP_ENTRY' });
    }
    Object.assign(row, { razorpay_payment_id: args[0], status: 'completed' });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE users SET subscription/.test(sql)) {
    if (state.failEntitlement) throw new Error('Simulated account write failure');
    state.users[args[1]].subscription = args[0];
    state.entitlementWrites++;
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE technicians SET registration_order_id/.test(sql)) {
    if (state.failRegistrationCheckout) throw new Error('Simulated registration checkout write failure');
    Object.assign(state.technicians[args[1]], { registration_order_id: args[0], registration_payment_status: 'processing' });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE technicians SET registration_payment_status/.test(sql)) {
    assert.match(sql, /WHERE id = \? AND registration_payment_status IN \('pending', 'processing'\)/,
      'registration completion must constrain the unpaid-to-completed SQL transition');
    if (state.failRegistrationCompletion) throw new Error('Simulated registration completion write failure');
    if (state.rejectRegistrationTransition) return [{ affectedRows: 0 }];
    const technician = state.technicians[args.at(-1)];
    Object.assign(technician, { registration_payment_status: 'completed', registration_payment_id: args[0] });
    if (/status = 'pending'/.test(sql)) Object.assign(technician, { status: 'pending', is_active: 0, is_available: 0, current_job_id: null });
    state.entitlementWrites++;
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected mutation: ${sql}`);
};
const query = async (sql, args = [], { inTransaction = false } = {}) => {
  if (sql === 'SELECT 1') return [[{ result: 1 }]];
  if (/FROM platform_pricing_config/.test(sql)) return [[{ id: USER, currency: 'INR', registration_fee: 500,
    subscription_plans: JSON.stringify([{ id: 'basic', name: 'Basic', amount: 100, active: true },
      { id: 'premium', name: 'Premium', amount: 500, active: true }]), ...state.pricing }]];
  if (/FROM account_payment_orders/.test(sql)) {
    assert.match(sql, /razorpay_order_id = \?/);
    if (inTransaction) assert.match(sql, /FOR UPDATE\s*$/, 'settlement locks its payment order');
    return [state.bindings.filter(row => row.razorpay_order_id === args[0]).map(copy)];
  }
  const ownerTable = /FROM (users|technicians)\b/.exec(sql)?.[1];
  if (ownerTable) {
    if (inTransaction) assert.match(sql, /FOR UPDATE\s*$/, 'checkout and settlement lock their account');
    const row = state[ownerTable][args[0]];
    const projection = sql.match(/^SELECT\s+(.+?)\s+FROM\b/is)[1].trim();
    if (!row) return [[]];
    return [[projection === '*' ? copy(row) : Object.fromEntries(
      projection.split(',').map(column => column.trim()).map(column => [column, copy(row[column])]))]];
  }
  if (/FROM payments/.test(sql)) return [[]]; // Not a service-request payment.
  throw new Error(`Unexpected query: ${sql}`);
};
const pool = { query, execute, end: async () => {}, getConnection: async () => {
  let unlock;
  let snapshot;
  return { query: (sql, args) => query(sql, args, { inTransaction: snapshot != null }),
    execute, release() { unlock?.(); unlock = null; },
    beginTransaction: async () => {
      const previous = transactionTail;
      transactionTail = new Promise(resolve => { unlock = resolve; });
      await previous;
      snapshot = copy(state);
    },
    commit: async () => { snapshot = null; unlock?.(); unlock = null; },
    rollback: async () => { if (snapshot) state = snapshot; snapshot = null; unlock?.(); unlock = null; },
  };
} };
const driver = mock.method(mysql, 'createPool', () => pool);
const gateway = mock.method(Razorpay.prototype, 'addResources', function () {
  this.orders = {
    create: async options => {
      state.gatewayCreates++;
      if (state.registrationStateDuringGatewayCreate) {
        state.technicians[TECH].registration_payment_status = state.registrationStateDuringGatewayCreate;
      }
      const order = { id: `order_fixture${state.gatewayCreates}`, ...copy(options), status: 'created', amount_paid: 0, amount_due: options.amount };
      state.orders[order.id] = order;
      return { ...copy(order), ...state.gatewayOrderOverride };
    },
    fetch: async id => {
      if (state.gatewayDown) throw new Error('Simulated gateway outage');
      return copy(state.orders[id]);
    },
  };
  this.payments = { fetch: async id => {
    if (state.gatewayDown) throw new Error('Simulated gateway outage');
    return copy(state.payments[id]);
  } };
});
const { default: router, razorpayWebhookHandler } = await import('../routes/payments.js');
beforeEach(async () => {
  state = { bindings: [], orders: {}, payments: {}, gatewayCreates: 0, entitlementWrites: 0,
    users: { [USER]: { id: USER, subscription: 'free' }, [OTHER_USER]: { id: OTHER_USER, subscription: 'free' } },
    technicians: Object.fromEntries([TECH, OTHER_TECH].map(id => [id, { id, registration_payment_status: 'pending',
      status: 'approved', is_active: 1, is_available: 0, current_job_id: '55555555-5555-4555-8555-555555555555' }])) };
  transactionTail = Promise.resolve();
  await getPlatformPricingConfig({ forceRefresh: true });
});
after(async () => { await db.closePool(); driver.mock.restore(); gateway.mock.restore(); });
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const request = async (path, body = {}, owner = USER) => {
  const res = response();
  const handler = router.stack.find(layer => layer.route?.path === path).route.stack.at(-1).handle;
  await handler({ body, user: { userId: owner }, technicianId: owner }, res);
  return res;
};
const create = async (purpose = 'subscription', owner = purpose === 'registration' ? TECH : USER, planId = 'basic') => {
  const res = await request(`/create-${purpose}-order`, { planId }, owner);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.order_id;
};
const capture = orderId => {
  const order = state.orders[orderId];
  Object.assign(order, { status: 'paid', amount_paid: order.amount, amount_due: 0 });
  const paymentId = `pay_${orderId}`;
  state.payments[paymentId] = { id: paymentId, order_id: orderId, amount: order.amount, currency: order.currency,
    status: 'captured', captured: true, amount_refunded: 0, refund_status: null, notes: {} };
  return { razorpay_order_id: orderId, razorpay_payment_id: paymentId,
    razorpay_signature: crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex') };
};
const reject = res => { assert.ok(res.statusCode >= 400, `Expected rejection, got ${res.statusCode}: ${JSON.stringify(res.body)}`); assert.equal(state.entitlementWrites, 0); };

for (const purpose of ['subscription', 'registration']) {
  test(`${purpose} checkout persists owner, purpose and frozen price before returning it`, async () => {
    const id = await create(purpose);
    assert.equal(state.bindings.length, 1);
    const row = state.bindings[0];
    assert.ok(isUuid(row.id), 'checkout uses the real UUID persistence adapter');
    assert.equal(row.razorpay_order_id, id);
    assert.equal(row.purpose, purpose);
    assert.equal(row.user_id, purpose === 'subscription' ? USER : null);
    assert.equal(row.technician_id, purpose === 'registration' ? TECH : null);
    assert.equal(row.plan_code, purpose === 'subscription' ? 'basic' : null);
    assert.equal(row.amount_paise, purpose === 'subscription' ? 10000 : 50000);
    assert.equal(row.currency, 'INR');
  });
  test(`${purpose} rejects a valid signed payment belonging to another account`, async () => {
    const id = await create(purpose);
    reject(await request(`/verify-${purpose}-payment`, { ...capture(id), planId: 'basic' }, purpose === 'subscription' ? OTHER_USER : OTHER_TECH));
  });
  test(`${purpose} grants captured matching payment exactly once`, async () => {
    const id = await create(purpose);
    const body = { ...capture(id), planId: 'basic' };
    const owner = purpose === 'subscription' ? USER : TECH;
    assert.equal((await request(`/verify-${purpose}-payment`, body, owner)).body.success, true);
    assert.equal((await request(`/verify-${purpose}-payment`, body, owner)).body.success, true);
    assert.equal(state.entitlementWrites, 1);
    assert.equal(state.bindings[0].status, 'completed');
  });
}
test('a basic signed payment cannot activate premium', async () => {
  const id = await create();
  reject(await request('/verify-subscription-payment', { ...capture(id), planId: 'premium' }));
});

test('existing case/whitespace plan normalization remains compatible at confirmation', async () => {
  const id = await create('subscription', USER, ' BASIC ');
  const res = await request('/verify-subscription-payment', { ...capture(id), planId: ' BASIC ' });
  assert.equal(res.body.success, true);
  assert.equal(state.users[USER].subscription, 'basic');
});

test('registration checkout retains the pending-order fields used by existing clients', async () => {
  const id = await create('registration');
  assert.equal(state.technicians[TECH].registration_order_id, id);
  assert.equal(state.technicians[TECH].registration_payment_status, 'processing');
});

test('registration checkout failure rolls back its binding and account fields', async () => {
  state.failRegistrationCheckout = true;
  const res = await request('/create-registration-order', {}, TECH);
  assert.ok(res.statusCode >= 500);
  assert.equal(state.bindings.length, 0);
  assert.equal(state.technicians[TECH].registration_payment_status, 'pending');
});
test('a subscription payment cannot fulfill technician registration', async () => {
  const id = await create();
  reject(await request('/verify-registration-payment', capture(id), TECH));
});

test('a registration payment cannot buy a subscription', async () => {
  const id = await create('registration');
  reject(await request('/verify-subscription-payment', { ...capture(id), planId: 'basic' }));
});

test('confirmation honors the purchased plan/price after the catalog changes', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  state.pricing = { subscription_plans: JSON.stringify([{ id: 'basic', name: 'Basic', amount: 999, active: false }]) };
  await getPlatformPricingConfig({ forceRefresh: true });
  assert.equal((await request('/verify-subscription-payment', body)).body.success, true);
  assert.equal(state.users[USER].subscription, 'basic');
  assert.equal(state.bindings[0].amount_paise, 10000);
});
test('a legacy/unbound payment never grants an entitlement', async () => {
  const id = await create();
  state.bindings = [];
  reject(await request('/verify-subscription-payment', { ...capture(id), planId: 'basic' }));
});
for (const [name, change] of [
  ['wrong order', { order_id: 'order_unrelated' }], ['wrong payment ID', { id: 'pay_unrelated' }],
  ['underpaid', { amount: 9900 }], ['overpaid', { amount: 10100 }], ['wrong currency', { currency: 'USD' }],
  ['authorized but not captured', { status: 'authorized', captured: false }],
  ['inconsistent captured flag', { captured: false }], ['refunded', { amount_refunded: 10000, refund_status: 'full' }],
  ['partially refunded', { amount_refunded: 1, refund_status: 'partial' }],
]) test(`subscription rejects ${name} gateway payment`, async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  Object.assign(state.payments[body.razorpay_payment_id], change);
  reject(await request('/verify-subscription-payment', body));
});
test('gateway order purpose/owner/amount must agree with the frozen binding', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  state.orders[id].notes = { type: 'registration', technicianId: TECH };
  reject(await request('/verify-subscription-payment', body));
});

for (const [name, change] of [
  ['wrong ID', { id: 'order_unrelated' }], ['wrong amount', { amount: 9999 }], ['wrong currency', { currency: 'USD' }],
  ['unpaid', { status: 'attempted', amount_paid: 0, amount_due: 10000 }],
  ['wrong owner', { notes: { type: 'subscription', userId: OTHER_USER, planId: 'basic' } }],
  ['wrong plan', { notes: { type: 'subscription', userId: USER, planId: 'premium' } }],
]) test(`confirmation rejects a gateway order with ${name}`, async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  Object.assign(state.orders[id], change);
  reject(await request('/verify-subscription-payment', body));
});

for (const change of [{ amount: 9999 }, { currency: 'USD' }, { captured: false }]) {
  test(`registration also rejects mismatched provider payment ${JSON.stringify(change)}`, async () => {
    const id = await create('registration'); const body = capture(id);
    Object.assign(state.payments[body.razorpay_payment_id], change);
    reject(await request('/verify-registration-payment', body, TECH));
  });
}

for (const change of [{ id: '' }, { amount: 1 }, { currency: 'USD' }]) {
  test(`invalid gateway checkout response is not exposed ${JSON.stringify(change)}`, async () => {
    state.gatewayOrderOverride = change;
    const res = await request('/create-subscription-order', { planId: 'basic' });
    assert.equal(res.statusCode, 503); assert.equal(state.bindings.length, 0);
  });
}
test('malformed signatures fail without writing an entitlement', async () => {
  const id = await create();
  const res = await request('/verify-subscription-payment', { ...capture(id), planId: 'basic', razorpay_signature: 'not-hex' });
  assert.equal(res.statusCode, 400); assert.equal(state.entitlementWrites, 0);
});

test('a well-formed but incorrect HMAC never grants entitlement', async () => {
  const id = await create();
  reject(await request('/verify-subscription-payment', { ...capture(id), planId: 'basic', razorpay_signature: '0'.repeat(64) }));
});
test('provider outage fails closed and a subsequent confirmation can recover', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  state.gatewayDown = true;
  const failed = await request('/verify-subscription-payment', body);
  reject(failed); assert.equal(failed.statusCode, 503);
  state.gatewayDown = false;
  assert.equal((await request('/verify-subscription-payment', body)).body.success, true);
});
test('checkout is not returned as successful if its durable binding cannot be saved', async () => {
  state.failInsert = true;
  const res = await request('/create-subscription-order', { planId: 'basic' });
  assert.ok(res.statusCode >= 500); assert.equal(res.body.success, undefined);
});
test('account update failure rolls back consumption and permits retry', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  state.failEntitlement = true;
  reject(await request('/verify-subscription-payment', body));
  assert.ok(state.bindings[0], 'checkout binding exists before confirmation');
  assert.notEqual(state.bindings[0].status, 'completed');
  state.failEntitlement = false;
  assert.equal((await request('/verify-subscription-payment', body)).body.success, true);
});
test('simultaneous callbacks apply the entitlement only once', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  const results = await Promise.all([request('/verify-subscription-payment', body), request('/verify-subscription-payment', body)]);
  assert.ok(results.every(res => res.body.success)); assert.equal(state.entitlementWrites, 1);
});
test('replaying an old completed subscription does not downgrade a newer entitlement', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  await request('/verify-subscription-payment', body);
  state.users[USER].subscription = 'premium';
  await request('/verify-subscription-payment', body);
  assert.equal(state.users[USER].subscription, 'premium'); assert.equal(state.entitlementWrites, 1);
});
test('registration confirmation and replay preserve approval and the active job', async () => {
  const id = await create('registration'); const body = capture(id);
  await request('/verify-registration-payment', body, TECH);
  await request('/verify-registration-payment', body, TECH);
  assert.equal(state.technicians[TECH].status, 'approved');
  assert.equal(state.technicians[TECH].is_active, 1);
  assert.equal(state.technicians[TECH].current_job_id, '55555555-5555-4555-8555-555555555555');
});

// QA-002: removing the per-technician completed-state guard must fail these
// cases even when each individual order has its own idempotency record.
test('a second captured registration order cannot replace an already-completed registration receipt', async () => {
  const first = capture(await create('registration'));
  const second = capture(await create('registration'));
  assert.equal((await request('/verify-registration-payment', first, TECH)).body.success, true);
  const paidTechnician = copy(state.technicians[TECH]);
  const res = await request('/verify-registration-payment', second, TECH);
  assert.equal(res.body.success, true);
  assert.equal(res.body.duplicate, true);
  assert.deepEqual(state.technicians[TECH], paidTechnician);
  assert.equal(state.entitlementWrites, 1);
  assert.ok(state.bindings.every(row => row.status === 'completed'), 'both real captures remain recorded');
});

test('concurrent captures for different registration orders complete the account only once', async () => {
  const first = capture(await create('registration'));
  const second = capture(await create('registration'));
  const results = await Promise.all([
    request('/verify-registration-payment', first, TECH), request('/verify-registration-payment', second, TECH),
  ]);
  assert.ok(results.every(res => res.body.success));
  assert.equal(results.filter(res => res.body.duplicate).length, 1);
  assert.equal(state.entitlementWrites, 1);
  assert.equal(state.technicians[TECH].status, 'approved');
  assert.equal(state.technicians[TECH].current_job_id, '55555555-5555-4555-8555-555555555555');
});

test('a registration with an unknown payment state is not silently completed', async () => {
  const body = capture(await create('registration'));
  state.technicians[TECH].registration_payment_status = 'under_review';
  const before = copy(state.technicians[TECH]);
  const res = await request('/verify-registration-payment', body, TECH);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.bindings[0].status, 'created');
  assert.equal(state.entitlementWrites, 0);
});

test('new registration checkout cannot replace an unknown payment state', async () => {
  state.technicians[TECH].registration_payment_status = 'under_review';
  const before = copy(state.technicians[TECH]);
  const res = await request('/create-registration-order', {}, TECH);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.gatewayCreates, 0);
});

test('registration checkout rechecks payment state under the account lock', async () => {
  state.registrationStateDuringGatewayCreate = 'under_review';
  const res = await request('/create-registration-order', {}, TECH);
  assert.equal(res.statusCode, 409);
  assert.equal(state.technicians[TECH].registration_payment_status, 'under_review');
  assert.equal(state.bindings.length, 0);
});

test('a refused registration transition never consumes its payment', async () => {
  const body = capture(await create('registration'));
  const before = copy(state.technicians[TECH]);
  state.rejectRegistrationTransition = true;
  const res = await request('/verify-registration-payment', body, TECH);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.bindings[0].status, 'created');
  assert.equal(state.entitlementWrites, 0);
});

for (const [name, technicianState] of [
  ['awaiting approval', { status: 'pending', is_active: 0, is_available: 0, current_job_id: null }],
  ['approved and available', { status: 'approved', is_active: 1, is_available: 1, current_job_id: null }],
  ['approved with an active job', { status: 'approved', is_active: 1, is_available: 0, current_job_id: '55555555-5555-4555-8555-555555555555' }],
  ['rejected after payment', { status: 'rejected', is_active: 0, is_available: 0, current_job_id: null }],
]) test(`registration replay preserves all technician fields when ${name}`, async () => {
  const body = capture(await create('registration'));
  assert.equal((await request('/verify-registration-payment', body, TECH)).body.success, true);
  Object.assign(state.technicians[TECH], technicianState);
  const before = copy(state.technicians[TECH]);
  // A processed callback must remain harmless even if the gateway is unavailable.
  state.gatewayDown = true;
  const res = await request('/verify-registration-payment', body, TECH);
  assert.equal(res.body.success, true); assert.equal(res.body.duplicate, true);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.entitlementWrites, 1);
});

test('registration account-write failure rolls back its receipt and allows safe retry', async () => {
  const body = capture(await create('registration'));
  const before = copy(state.technicians[TECH]);
  state.failRegistrationCompletion = true;
  const res = await request('/verify-registration-payment', body, TECH);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.bindings[0].status, 'created');
  state.failRegistrationCompletion = false;
  assert.equal((await request('/verify-registration-payment', body, TECH)).body.success, true);
  assert.equal(state.entitlementWrites, 1);
});

test('client and signed webhook racing the same registration preserve the account once', async () => {
  const body = capture(await create('registration'));
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: state.payments[body.razorpay_payment_id] } } }));
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const webhookRes = response();
  const [clientRes] = await Promise.all([
    request('/verify-registration-payment', body, TECH),
    razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': signature } }, webhookRes),
  ]);
  assert.equal(clientRes.body.success, true); assert.equal(webhookRes.body.processed, true);
  assert.equal(state.entitlementWrites, 1);
  assert.equal(state.technicians[TECH].status, 'approved');
  assert.equal(state.technicians[TECH].is_active, 1);
  assert.equal(state.technicians[TECH].is_available, 0);
  assert.equal(state.technicians[TECH].current_job_id, '55555555-5555-4555-8555-555555555555');
});

test('a later registration webhook cannot overwrite a receipt or admin state after approval', async () => {
  const first = capture(await create('registration'));
  const second = capture(await create('registration'));
  await request('/verify-registration-payment', first, TECH);
  Object.assign(state.technicians[TECH], { status: 'approved', is_active: 1, is_available: 1, current_job_id: null });
  const before = copy(state.technicians[TECH]);
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: state.payments[second.razorpay_payment_id] } } }));
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = response();
  await razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': signature } }, res);
  assert.equal(res.body.processed, true); assert.equal(res.body.duplicate, true);
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.entitlementWrites, 1);
  assert.ok(state.bindings.every(row => row.status === 'completed'));
});

test('registration checkout cannot reopen a paid registration', async () => {
  const body = capture(await create('registration'));
  await request('/verify-registration-payment', body, TECH);
  const before = copy(state.technicians[TECH]);
  const res = await request('/create-registration-order', {}, TECH);
  assert.equal(res.statusCode, 409); assert.equal(res.body.code, 'REGISTRATION_ALREADY_PAID');
  assert.deepEqual(state.technicians[TECH], before);
  assert.equal(state.gatewayCreates, 1);
});
test('a signed capture webhook fulfills a bound subscription and client replay is harmless', async () => {
  const id = await create(); const body = { ...capture(id), planId: 'basic' };
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: state.payments[body.razorpay_payment_id] } } }));
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const res = response();
  await razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': signature } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.processed, true);
  assert.equal(state.users[USER].subscription, 'basic');
  await request('/verify-subscription-payment', body);
  assert.equal(state.entitlementWrites, 1);
});

test('authorized registration waits for capture and the signed webhook then completes it once', async () => {
  const id = await create('registration'); const body = capture(id);
  state.payments[body.razorpay_payment_id].captured = false;
  reject(await request('/verify-registration-payment', body, TECH));
  state.payments[body.razorpay_payment_id].captured = true;
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: state.payments[body.razorpay_payment_id] } } }));
  const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  for (let i = 0; i < 2; i++) {
    const res = response();
    await razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': signature } }, res);
    assert.equal(res.body.processed, true);
  }
  assert.equal(state.entitlementWrites, 1);
  assert.equal(state.technicians[TECH].registration_payment_status, 'completed');
  assert.equal(state.technicians[TECH].status, 'approved');
});

test('an invalid webhook signature cannot consume a bound checkout', async () => {
  const id = await create(); const body = capture(id);
  const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: state.payments[body.razorpay_payment_id] } } }));
  const res = response();
  await razorpayWebhookHandler({ body: raw, headers: { 'x-razorpay-signature': '0'.repeat(64) } }, res);
  assert.equal(res.statusCode, 401); assert.equal(state.entitlementWrites, 0);
});
