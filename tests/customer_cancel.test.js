import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCustomerCancel, handleCustomerStatusUpdate } from '../routes/service_requests.js';
import { canCustomerCancelRequest } from '../services/requestStatusWorkflow.js';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

/** The customer's request row, the database around it, and everything the route tells other people. */
function setup({ status = 'pending', technicianId = null, owner = 41, statusAtLock = status, technicianAtLock = technicianId } = {}) {
  const row = { id: 5502, user_id: owner, status, technician_id: technicianId };
  const seen = { updates: [], released: [], toTechnician: [], toUser: [], transactions: [] };
  const find = (params) => (Number(params[0]) === row.id && Number(params[1]) === row.user_id ? [{ ...row }] : []);
  const conn = {
    beginTransaction: async () => { seen.transactions.push('begin'); },
    commit: async () => { seen.transactions.push('commit'); },
    rollback: async () => { seen.transactions.push('rollback'); },
    release: () => { seen.transactions.push('release'); },
    query: async (sql, params) => {
      assert.match(sql, /FOR UPDATE/);
      // Whatever changed between the customer tapping Cancel and the row being locked.
      row.status = statusAtLock;
      row.technician_id = technicianAtLock;
      return [find(params)];
    },
    execute: async (sql, params) => {
      seen.updates.push({ sql, params });
      row.status = params[0];
      row.technician_id = null;
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    query: async (sql, params) => {
      if (/SELECT \* FROM service_requests/.test(sql)) return [[{ ...row }]];
      if (/UPDATE service_requests/.test(sql)) { seen.updates.push({ sql, params }); row.status = params[0]; return [{ affectedRows: 1 }]; }
      if (/FROM technicians/.test(sql)) return [[]];
      return [find(params)];
    },
    execute: async (sql, params) => { seen.updates.push({ sql, params }); row.status = params[0]; return [{ affectedRows: 1 }]; },
    getConnection: async () => conn,
  };
  const deps = {
    getPool: async () => pool,
    release: async (_db, technician, request) => { seen.released.push({ technician, request }); },
    sockets: {
      notifyTechnician: (technician, event, data) => seen.toTechnician.push({ technician, event, data }),
      notifyUser: (user, event, data) => seen.toUser.push({ user, event, data }),
    },
  };
  return { row, seen, deps };
}

const cancel = async (world, { user = 41, reason = 'Taking too long' } = {}) => {
  const res = createResponse();
  await handleCustomerCancel({ user: { userId: user }, params: { id: '5502' }, body: { reason } }, res, world.deps);
  return res;
};

test('the rule: a customer can cancel only until the technician sets off', () => {
  for (const status of ['pending', 'requested', 'assigned', 'accepted', 'Accepted', ' PENDING ']) {
    assert.equal(canCustomerCancelRequest(status), true, status);
  }
  for (const status of [
    'on-the-way', 'on_the_way', 'en-route', 'en_route', 'en_route_pickup', 'arrived', 'arrived_pickup', 'processing', 'service_started',
    'in-progress', 'in_progress', 'vehicle_loaded', 'enroute_drop', 'tow_started', 'arrived_drop', 'service_completed',
    'awaiting_payment', 'payment_pending', 'completed', 'paid', 'closed', 'cancelled', 'rejected', '', null, undefined, 'something-new',
  ]) {
    assert.equal(canCustomerCancelRequest(status), false, String(status));
  }
});

test('cancels a request that is still looking for a technician', async () => {
  const world = setup({ status: 'pending' });
  const res = await cancel(world);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(world.row.status, 'cancelled');
  assert.deepEqual(world.seen.updates[0].params, ['cancelled', 'Taking too long', '5502']);
  assert.deepEqual(world.seen.transactions, ['begin', 'commit', 'release']);
  assert.equal(world.seen.released.length, 0);
  assert.deepEqual(world.seen.toUser.map((m) => m.data), [{ requestId: '5502', status: 'cancelled' }]);
});

test('cancels after a technician accepted, frees that technician and tells them', async () => {
  const world = setup({ status: 'accepted', technicianId: 7 });
  const res = await cancel(world, { reason: 'Found other help' });

  assert.equal(res.statusCode, 200);
  assert.equal(world.row.status, 'cancelled');
  assert.deepEqual(world.seen.released, [{ technician: 7, request: '5502' }]);
  assert.deepEqual(world.seen.toTechnician, [
    { technician: 7, event: 'job:status_update', data: { requestId: '5502', status: 'cancelled', reason: 'Found other help' } },
  ]);
});

for (const status of ['on-the-way', 'en-route', 'en_route_pickup', 'arrived', 'arrived_pickup', 'in-progress', 'vehicle_loaded', 'enroute_drop', 'arrived_drop', 'payment_pending', 'completed', 'paid', 'closed']) {
  test(`refuses to cancel once the request is ${status}`, async () => {
    const world = setup({ status, technicianId: 7 });
    const res = await cancel(world);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CANCEL_NOT_ALLOWED');
    assert.match(res.body.error, /can no longer be cancelled/);
    assert.equal(world.row.status, status);
    assert.equal(world.row.technician_id, 7);
    assert.equal(world.seen.updates.length, 0);
    assert.equal(world.seen.released.length, 0);
    assert.equal(world.seen.toTechnician.length, 0);
    assert.equal(world.seen.toUser.length, 0);
    assert.deepEqual(world.seen.transactions, ['begin', 'rollback', 'release']);
  });
}

test('refuses when the technician sets off in the moment the customer taps Cancel', async () => {
  const world = setup({ status: 'accepted', technicianId: 7, statusAtLock: 'en-route' });
  const res = await cancel(world);

  assert.equal(res.statusCode, 409);
  assert.equal(world.row.status, 'en-route');
  assert.equal(world.seen.updates.length, 0);
  assert.equal(world.seen.toTechnician.length, 0);
});

test('frees the technician who accepted in the moment the customer taps Cancel', async () => {
  const world = setup({ status: 'pending', technicianId: null, statusAtLock: 'accepted', technicianAtLock: 9 });
  const res = await cancel(world);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(world.seen.released, [{ technician: 9, request: '5502' }]);
  assert.equal(world.seen.toTechnician[0].technician, 9);
});

test('says so when the request is already cancelled', async () => {
  const world = setup({ status: 'cancelled' });
  const res = await cancel(world);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already cancelled/);
  assert.equal(world.seen.updates.length, 0);
});

test("does not find another customer's request", async () => {
  const world = setup({ status: 'pending', owner: 99 });
  const res = await cancel(world);

  assert.equal(res.statusCode, 404);
  assert.equal(world.row.status, 'pending');
});

test('the status route follows the same rule when it is asked to cancel', async () => {
  const refuse = setup({ status: 'en-route', technicianId: 7 });
  const refused = createResponse();
  await handleCustomerStatusUpdate({ user: { userId: 41 }, params: { id: '5502' }, body: { status: 'cancelled' } }, refused, refuse.deps);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.code, 'CANCEL_NOT_ALLOWED');
  assert.equal(refuse.row.status, 'en-route');
  assert.equal(refuse.seen.updates.length, 0);

  const allow = setup({ status: 'accepted', technicianId: 7 });
  const allowed = createResponse();
  await handleCustomerStatusUpdate({ user: { userId: 41 }, params: { id: '5502' }, body: { status: 'cancelled' } }, allowed, allow.deps);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allow.row.status, 'cancelled');
  assert.deepEqual(allow.seen.released, [{ technician: 7, request: '5502' }]);
});
