import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestWithReservation } from '../services/technicianStateService.js';
import { processNewDispatchJob } from '../services/dispatchQueueService.js';
import { jobDispatchService } from '../services/jobDispatchService.js';

const service = await import('../services/dispatchOfferService.js').catch(() => ({}));
const quote = { version: 1, request_id: 101, technician_id: 7, currency: 'INR', technician_earning: 1200,
  customer_base_amount: 1200, customer_total_amount: 1320, platform_fee: 120, payment_fee: 0, discount_amount: 0,
  payment_mode: 'cash', pricing_breakdown: { tax_amount: 0, tax_percent: 0 },
  earnings_source: 'technician_pricing', calculated_at: '2026-10-14T04:00:00.000Z' };
const job = { id: 101, status: 'pending', amount: 599, service_type: 'car-towing', vehicle_type: 'car' };
function storage(changes = {}) {
  const offers = [{ id: 1, technician_id: 7, status: 'pending', pricing_snapshot: 'original offer' }];
  const row = { ...job, ...changes };
  const pool = { query: async (sql, params = []) => {
    if (/SELECT[\s\S]*FROM service_requests/.test(sql)) return [[row]];
    if (/SELECT[\s\S]*FROM dispatch_offers/.test(sql)) {
      const attempted = /status IN/.test(sql);
      return [offers.filter(offer => (attempted ? ['accepted', 'rejected', 'expired'].includes(offer.status) : offer.status === 'pending') &&
        (!/pricing_snapshot IS NOT NULL/.test(sql) || offer.pricing_snapshot != null))];
    }
    if (/UPDATE dispatch_offers/.test(sql)) { for (const offer of offers) offer.status = 'expired'; return [{ affectedRows: 1 }]; }
    if (/INSERT INTO dispatch_offers/.test(sql)) {
      const stored = { id: offers.length + 1, service_request_id: params[0], technician_id: params[1], expires_at: params[2], pricing_snapshot: params[3], status: 'pending' };
      offers.push(stored); return [{ insertId: stored.id }];
    }
    throw new Error(`Unexpected dispatch SQL: ${sql}`);
  } };
  return { pool, row, offers };
}
test('a new offer saves earnings before building an alert and never uses the old booking amount', async () => {
  assert.equal(typeof service.createPricedDispatchOffer, 'function', 'priced offer delivery must exist');
  const db = storage();
  const offer = await service.createPricedDispatchOffer(db.pool, db.row, { id: 7 }, { pricingSnapshot: quote });
  const payload = service.dispatchOfferPricingFields(offer);
  assert.equal(JSON.parse(db.offers[1].pricing_snapshot).technician_earning, 1200);
  assert.equal(payload.amount, 1200);
  assert.equal(payload.priceAmount, 1200);
  assert.equal(payload.estimatedEarnings, 1200);
  assert.equal(payload.offerId, 2);
});

function simulatedSockets() {
  const alerts = [];
  return { alerts, io: { to: () => ({ emit: (event, data) => { if (event === 'JOB_ALERT') alerts.push(data); } }) },
    notifyTechnician: () => {} };
}

test('the actual queue worker advertises the persisted technician earnings and offer identity', async () => {
  const db = storage();
  db.offers.length = 0;
  const sockets = simulatedSockets();
  const result = await processNewDispatchJob({ jobId: 101 }, { pool: db.pool, sockets,
    findTechnicians: async () => [{ id: 7, etaText: '5 mins', distanceText: '2 km' }],
    estimateEarning: async () => ({ amount: 1200, source: 'technician_pricing' }),
    scheduleTimeout: async () => {}, requeue: async () => {} });
  assert.equal(result.technicianId, 7);
  assert.equal(sockets.alerts.length, 1);
  assert.equal(sockets.alerts[0].amount, 1200);
  assert.equal(sockets.alerts[0].offerId, db.offers[0].id);
  assert.equal(JSON.parse(db.offers[0].pricing_snapshot).technician_earning, 1200);
});

test('the fallback dispatcher advertises the same persisted technician earnings as the queue', async () => {
  const db = storage();
  db.offers.length = 0;
  const sockets = simulatedSockets();
  await jobDispatchService.dispatchJob(db.row, [{ id: 7 }], { pool: db.pool, sockets,
    estimateEarning: async () => ({ amount: 1200, source: 'technician_pricing' }) });
  assert.equal(sockets.alerts.length, 1);
  assert.equal(sockets.alerts[0].amount, 1200);
  assert.equal(sockets.alerts[0].offerId, db.offers[0].id);
  assert.equal(JSON.parse(db.offers[0].pricing_snapshot).technician_earning, 1200);
});

test('an old unpriced offer does not permanently exclude the only eligible technician', async () => {
  const db = storage();
  db.offers[0].pricing_snapshot = null;
  const sockets = simulatedSockets();
  const result = await processNewDispatchJob({ jobId: 101 }, { pool: db.pool, sockets,
    findTechnicians: async () => [{ id: 7 }], estimateEarning: async () => ({ amount: 1200, source: 'technician_pricing' }),
    scheduleTimeout: async () => {}, requeue: async () => {} });
  assert.equal(result.technicianId, 7);
  assert.equal(sockets.alerts.length, 1);
  assert.equal(sockets.alerts[0].offerId, 2);
  assert.equal(db.offers[0].status, 'expired');
  assert.equal(db.offers[0].pricing_snapshot, null);
});
test('reissuing an offer expires its predecessor without overwriting the promised price', async () => {
  assert.equal(typeof service.createPricedDispatchOffer, 'function', 'priced offer delivery must exist');
  const db = storage();
  await service.createPricedDispatchOffer(db.pool, db.row, { id: 7 }, { pricingSnapshot: quote });
  assert.equal(db.offers[0].status, 'expired');
  assert.equal(db.offers[0].pricing_snapshot, 'original offer');
  assert.notEqual(db.offers[0].id, db.offers[1].id);
});
test('a resolved request cannot receive a new priced offer', async () => {
  assert.equal(typeof service.createPricedDispatchOffer, 'function', 'priced offer delivery must exist');
  const db = storage({ status: 'accepted', technician_id: 9 });
  await assert.rejects(service.createPricedDispatchOffer(db.pool, db.row, { id: 7 }, { pricingSnapshot: quote }), { code: 'offer_unavailable' });
  assert.equal(db.offers.length, 1);
});
test('invalid funding cannot be persisted or replace an existing valid offer', async () => {
  assert.equal(typeof service.createPricedDispatchOffer, 'function', 'priced offer delivery must exist');
  const db = storage();
  await assert.rejects(service.createPricedDispatchOffer(db.pool, db.row, { id: 7 }, { pricingSnapshot: { ...quote, customer_base_amount: 599 } }), { code: 'pricing_unavailable' });
  assert.equal(db.offers.length, 1);
  assert.equal(db.offers[0].status, 'pending');
});

test('direct booking rolls back the request and reservation when saving its price fails', async () => {
  let commits = 0;
  let rollbacks = 0;
  const conn = { beginTransaction: async () => {}, release: () => {},
    commit: async () => { commits++; }, rollback: async () => { rollbacks++; },
    execute: async () => [{ insertId: 101 }], query: async (sql) => {
      if (/FROM technicians/.test(sql)) return [[{ id: 7, status: 'approved', is_active: 1, is_available: 1, current_job_id: null }]];
      if (/SELECT \* FROM service_requests/.test(sql)) return [[{ id: 101, technician_id: 7, status: 'assigned' }]];
      if (/FROM service_requests/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    } };
  await assert.rejects(createRequestWithReservation({ getConnection: async () => conn }, 'INSERT request', [], 7,
    { afterReserve: async () => { throw Object.assign(new Error('Price unavailable'), { code: 'pricing_unavailable' }); } }),
    { code: 'pricing_unavailable' });
  assert.equal(commits, 0);
  assert.equal(rollbacks, 1);
});
