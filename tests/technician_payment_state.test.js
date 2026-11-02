import assert from 'node:assert/strict';
import test from 'node:test';
import { handleTechnicianStatusUpdate } from '../routes/service_requests.js';
import { mapRequestedTechnicianStatus, validateTechnicianStatusTransition } from '../services/requestStatusWorkflow.js';

const requestId = '10000000-0000-4000-8000-000000000001';
const technicianId = '20000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';
const payment = { id: '40000000-0000-4000-8000-000000000004', service_request_id: requestId,
  user_id: userId, status: 'completed', settlement_key: `service-request:${requestId}`, payment_method: 'cash' };
const invoice = { id: '50000000-0000-4000-8000-000000000005', service_request_id: requestId,
  user_id: userId, technician_id: technicianId, order_id: `cash_${requestId}`, razorpay_payment_id: null };

// Production handler and reservation/settlement SQL run against a stateful boundary double.
// This verifies ordering and effects, not actual MySQL isolation.
async function update({ serviceType = 'battery', current = 'awaiting_payment', paymentStatus = 'pending',
  next = 'paid', settlements = [], invoices = [invoice], assigned = technicianId, onLock } = {}) {
  const job = { id: requestId, technician_id: assigned, user_id: userId, service_type: serviceType,
    status: current, payment_status: paymentStatus, payment_method: 'cash' };
  const tech = { id: technicianId, current_job_id: requestId, is_available: 0, is_active: 1, status: 'approved', total_jobs: 3 };
  const original = structuredClone({ job, tech, settlements });
  const statements = [];
  let locked = false, committed = false, rolledBack = false;
  const conn = {
    beginTransaction: async () => {},
    commit: async () => { committed = true; },
    rollback: async () => { rolledBack = true; Object.assign(job, original.job); Object.assign(tech, original.tech); },
    release: () => {},
    query: async (sql, params = []) => {
      statements.push(sql);
      if (/SELECT \* FROM service_requests WHERE id = \? AND technician_id = \? FOR UPDATE/.test(sql)) {
        assert.deepEqual(params, [requestId, technicianId]);
        locked = true; onLock?.(job);
        return [job.technician_id === technicianId ? [{ ...job }] : []];
      }
      if (/SELECT \* FROM payments/.test(sql)) {
        assert.equal(locked, true); assert.match(sql, /FOR UPDATE/); assert.deepEqual(params, [requestId]);
        return [structuredClone(settlements)];
      }
      if (/FROM invoices/.test(sql)) {
        assert.equal(locked, true); assert.match(sql, /FOR UPDATE/); assert.equal(params[0], requestId);
        return [structuredClone(invoices.filter(row => row.service_request_id === params[0] &&
          (/LEFT\(order_id/.test(sql) ? row.order_id.startsWith('cash_') && row.razorpay_payment_id == null
            : row.order_id === params[1] || row.razorpay_payment_id === params[2])))];
      }
      if (/SELECT email, full_name FROM users/.test(sql)) return [[]];
      if (/SELECT name FROM technicians/.test(sql)) return [[{ name: 'Tech' }]];
      if (/SELECT \* FROM technicians/.test(sql)) return [[{ ...tech }]];
      if (/SELECT id FROM service_requests/.test(sql)) return [[]];
      if (/SELECT \* FROM service_requests WHERE id = \? LIMIT 1/.test(sql)) return [[{ ...job }]];
      if (/UPDATE technicians SET current_job_id = NULL/.test(sql)) { tech.current_job_id = null; return [{ affectedRows: 1 }]; }
      if (/UPDATE technicians/.test(sql) && /SET is_available = FALSE/.test(sql)) { tech.current_job_id = params[0]; tech.is_available = 0; return [{ affectedRows: 1 }]; }
      if (/UPDATE technicians/.test(sql)) { tech.is_available = tech.current_job_id == null ? 1 : 0; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    execute: async (sql, params) => {
      statements.push(sql);
      assert.match(sql, /UPDATE service_requests SET status = \?/);
      job.status = params[0]; job.technician_id = params[1];
      return [{ affectedRows: 1 }];
    },
  };
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handleTechnicianStatusUpdate({ technicianId, params: { id: requestId }, body: { status: next, payment_status: 'paid' } }, res,
    { getPool: async () => ({ getConnection: async () => conn }) });
  return { res, job, tech, original, statements, committed, rolledBack, settlements };
}

function unchanged(result, code = 409) {
  assert.equal(result.res.statusCode, code, JSON.stringify(result.res.body));
  assert.deepEqual(result.job, result.original.job);
  assert.deepEqual(result.tech, result.original.tech);
  assert.deepEqual(result.settlements, result.original.settlements);
  assert.equal(result.committed, false); assert.equal(result.rolledBack, true);
  assert.equal(result.statements.some(sql => /^UPDATE|^INSERT/.test(sql)), false);
}

for (const current of ['awaiting_payment', 'payment_pending', 'paid']) {
  test(`non-towing policy reserves paid for settlement services from ${current}`, () => {
    assert.equal(validateTechnicianStatusTransition({ currentStatus: current, nextStatus: 'paid', serviceType: 'battery', paymentStatus: 'pending' }).ok, false);
  });
  test(`technician cannot mark unpaid non-towing ${current} job paid`, async () => {
    unchanged(await update({ current }));
  });
}

test('a paid flag does not give the non-towing status endpoint authority to establish paid', async () => {
  unchanged(await update({ paymentStatus: 'paid', settlements: [payment] }));
});

for (const [serviceType, current, next] of [
  ['battery', 'awaiting_payment', 'completed'], ['battery', 'completed', 'completed'],
  ['battery', 'closed', 'closed'],
  ['towing', 'payment_pending', 'closed'], ['towing', 'closed', 'closed'],
]) {
  test(`policy denies unpaid terminal transition ${serviceType} ${current} -> ${next}`, () => {
    assert.equal(validateTechnicianStatusTransition({ currentStatus: current, nextStatus: next, serviceType, paymentStatus: 'pending' }).ok, false);
  });
}

test('non-towing closed retry cannot release an unpaid historical job', async () => {
  unchanged(await update({ current: 'closed', next: 'closed' }));
});

for (const next of ['closed', 'paid', 'job-closed']) {
  test(`unpaid towing ${next} attempt retains the reservation`, async () => {
    unchanged(await update({ serviceType: 'towing', current: 'payment_pending', next }));
  });
}

for (const [label, overrides] of [
  ['missing settlement', {}],
  ['payment record without paid request', { paymentStatus: 'pending', settlements: [payment] }],
  ['duplicate settlements', { settlements: [payment, { ...payment, id: 'another' }] }],
  ['regressed keyed settlement', { settlements: [{ ...payment, status: 'processing' }] }],
  ['wrong settlement key', { settlements: [{ ...payment, settlement_key: 'service-request:other' }] }],
  ['wrong customer', { settlements: [{ ...payment, user_id: technicianId }] }],
  ['wrong invoice technician', { settlements: [payment], invoices: [{ ...invoice, technician_id: userId }] }],
  ['wrong invoice customer', { settlements: [payment], invoices: [{ ...invoice, user_id: technicianId }] }],
  ['missing invoice', { settlements: [payment], invoices: [] }],
  ['ambiguous invoices', { settlements: [payment], invoices: [invoice, { ...invoice, id: 'another' }] }],
]) {
  test(`towing closure rejects ${label} without mutation`, async () => {
    unchanged(await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'paid', next: 'closed', ...overrides }));
  });
}

test('unpaid closed towing retry is not treated as successful payment confirmation', async () => {
  unchanged(await update({ serviceType: 'towing', current: 'closed', next: 'closed' }));
});

test('paid closed towing retry still requires the original settlement', async () => {
  unchanged(await update({ serviceType: 'towing', current: 'closed', paymentStatus: 'paid', next: 'closed' }));
});

test('verified closed towing retry is read-only', async () => {
  const result = await update({ serviceType: 'towing', current: 'closed', paymentStatus: 'paid', next: 'closed', settlements: [payment] });
  assert.equal(result.res.statusCode, 200); assert.equal(result.res.body.idempotent, true);
  assert.deepEqual(result.job, result.original.job); assert.deepEqual(result.tech, result.original.tech);
  assert.equal(result.statements.some(sql => /^UPDATE|^INSERT/.test(sql)), false); assert.equal(result.committed, true);
});

test('legacy completed payment without a settlement key still permits verified towing closure', async () => {
  const result = await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'completed', next: 'paid',
    settlements: [{ ...payment, settlement_key: null }], invoices: [{ ...invoice, order_id: 'cash_legacy_timestamp' }] });
  assert.equal(result.res.statusCode, 200); assert.equal(result.job.status, 'closed'); assert.equal(result.tech.current_job_id, null);
});

test('online settlement uses matching invoice technician rather than a nonexistent payment column', async () => {
  const result = await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'completed', next: 'closed',
    settlements: [{ ...payment, payment_method: 'razorpay', razorpay_order_id: 'order_test', razorpay_payment_id: 'pay_test' }],
    invoices: [{ ...invoice, order_id: 'order_test', razorpay_payment_id: 'pay_test' }] });
  assert.equal(result.res.statusCode, 200); assert.equal(result.job.status, 'closed'); assert.equal(result.tech.current_job_id, null);
});

test('online settlement rejects mismatched invoice payment reference', async () => {
  unchanged(await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'completed', next: 'closed',
    settlements: [{ ...payment, payment_method: 'razorpay', razorpay_order_id: 'order_test', razorpay_payment_id: 'pay_test' }],
    invoices: [{ ...invoice, order_id: 'order_test', razorpay_payment_id: 'pay_other' }] }));
});

for (const paymentStatus of ['paid', 'completed']) {
  test(`verified towing closure preserves ${paymentStatus} evidence and releases reservation`, async () => {
    const result = await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus, next: 'closed', settlements: [payment] });
    assert.equal(result.res.statusCode, 200); assert.equal(result.job.status, 'closed');
    assert.equal(result.job.payment_status, paymentStatus);
    assert.equal(result.tech.current_job_id, null); assert.equal(result.tech.is_available, 1); assert.equal(result.tech.total_jobs, 3);
    assert.deepEqual(result.settlements, [payment]); assert.equal(result.committed, true);
  });
}

test('another technician cannot close the paid job', async () => {
  unchanged(await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'paid', next: 'closed', assigned: userId, settlements: [payment] }), 404);
});

test('closure reads the current payment status after acquiring the request lock', async () => {
  const result = await update({ serviceType: 'towing', current: 'payment_pending', paymentStatus: 'paid', next: 'closed', settlements: [payment],
    onLock: job => { job.payment_status = 'pending'; } });
  assert.equal(result.res.statusCode, 409); assert.equal(result.tech.current_job_id, requestId); assert.equal(result.committed, false);
});

for (const [serviceType, current, want] of [['battery', 'service_started', 'awaiting_payment'], ['towing', 'arrived_drop', 'service_completed']]) {
  test(`${serviceType} work completion remains unpaid and reserved`, async () => {
    assert.equal(mapRequestedTechnicianStatus({ requestedStatus: 'completed', currentStatus: current, serviceType }), want);
    const result = await update({ serviceType, current, next: 'completed' });
    assert.equal(result.res.statusCode, 200, JSON.stringify(result.res.body)); assert.equal(result.job.status, want);
    assert.equal(result.job.payment_status, 'pending'); assert.equal(result.tech.current_job_id, requestId); assert.equal(result.tech.is_available, 0);
    assert.deepEqual(result.settlements, []); assert.equal(result.tech.total_jobs, 3);
  });
}
