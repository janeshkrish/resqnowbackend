import assert from 'node:assert/strict';
import test from 'node:test';
import { jobDispatchService } from '../services/jobDispatchService.js';

const quoted = (changes = {}) => ({
  version: 1, request_id: 101, technician_id: 7, currency: 'INR',
  technician_earning: 1200, customer_base_amount: 1200, customer_total_amount: 1320,
  payment_mode: 'cash', platform_fee: 120, payment_fee: 0, discount_amount: 0,
  pricing_breakdown: { subtotal: 1200, tax_amount: 0, tax_percent: 0 },
  earnings_source: 'technician_pricing', calculated_at: '2026-10-14T04:00:00.000Z', ...changes,
});

// Translate the real transaction's SQL at its database boundary; no database is opened.
function scenario({ snapshot = quoted(), offerId = 21, jobChanges = {}, offers = null } = {}) {
  const job = { id: 101, user_id: 41, technician_id: null, status: 'pending',
    service_type: 'car-towing', vehicle_type: 'car', tow_truck_type: 'flatbed',
    amount: 599, final_price: 660.9, route_distance_km: 12, ...jobChanges };
  const technician = { id: 7, name: 'Tow technician', status: 'approved', is_active: 1,
    is_available: 1, current_job_id: null };
  const offerRows = offers ?? [{ id: offerId, service_request_id: 101, technician_id: 7,
    status: 'pending', expired: 0, pricing_snapshot: snapshot == null ? null : JSON.stringify(snapshot) }];
  let commits = 0;
  let estimates = 0;
  let backup;
  const events = [];
  const update = (row, sql, params) => {
    const assignments = sql.split(/\bSET\b/i)[1]?.split(/\bWHERE\b/i)[0] || '';
    let index = 0;
    for (const match of assignments.matchAll(/([a-z_]+)\s*=\s*(\?|COALESCE\([^)]*\)|'[^']*'|NOW\(\))/gi)) {
      const [, column, value] = match;
      if (value === '?') row[column] = params[index++];
      else if (value.includes('?')) { row[column] ??= params[index]; index++; }
      else if (value.startsWith("'")) row[column] = value.slice(1, -1);
      else if (value.includes('NOW')) row[column] = new Date().toISOString();
    }
    return [{ affectedRows: 1 }];
  };
  const conn = {
    beginTransaction: async () => { backup = structuredClone({ job, technician, offerRows }); },
    commit: async () => { commits++; },
    rollback: async () => { if (backup) { Object.assign(job, backup.job); Object.assign(technician, backup.technician); offerRows.splice(0, offerRows.length, ...backup.offerRows); } },
    release: () => {},
    query: async (sql, params = []) => {
      if (/SELECT \* FROM service_requests/.test(sql)) return [[{ ...job }]];
      if (/SELECT .*FROM technicians/s.test(sql)) return [[{ ...technician }]];
      if (/FROM technician_fleet_vehicles/.test(sql)) return [[{ vehicle_type: 'flatbed', status: 'available' }]];
      if (/SELECT .*FROM service_requests/s.test(sql)) return [[]];
      if (/SELECT .*FROM dispatch_offers/s.test(sql)) return [[...offerRows].sort((a, b) => b.id - a.id)];
      if (/UPDATE service_requests/.test(sql)) return update(job, sql, params);
      if (/UPDATE technicians/.test(sql)) { technician.current_job_id = 101; technician.is_available = 0; return [{ affectedRows: 1 }]; }
      if (/UPDATE dispatch_offers/.test(sql)) {
        const idMatch = /WHERE id = \?/.test(sql);
        for (const offer of offerRows) {
          if (idMatch && offer.id !== Number(params.at(-1))) continue;
          if (/id != \?/.test(sql) && offer.id === Number(params[1])) continue;
          if (/technician_id !=/.test(sql) && offer.technician_id === 7) continue;
          update(offer, sql, params);
        }
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected acceptance SQL: ${sql}`);
    },
  };
  const pool = { getConnection: async () => conn, query: async () => [[]] };
  const sockets = { io: { emit: (...args) => events.push(['global', ...args]), to: (room) => ({ emit: (...args) => events.push(['room', room, ...args]) }) },
    notifyUser: (...args) => events.push(args), notifyTechnician: (...args) => events.push(args) };
  return { job, technician, offerRows, events, commits: () => commits, estimates: () => estimates,
    accept: (options = {}) => jobDispatchService.acceptJob(7, 101, { pool, sockets,
      estimateEarning: async () => { estimates++; return { amount: 9000, source: 'technician_pricing' }; }, ...options }) };
}

test('towing acceptance funds the offered earnings instead of preserving the old platform fare', async () => {
  const db = scenario();
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.success, true);
  assert.equal(result.job.amount, 1200);
  assert.equal(result.job.technician_estimated_earning, 1200);
  assert.equal(db.job.final_price, 1320);
  assert.equal(JSON.parse(db.job.pricing_snapshot).offer_id, 21);
  assert.equal(db.offerRows[0].status, 'accepted');
});

test('acceptance does not recalculate an existing offer after registered prices change', async () => {
  const db = scenario({ jobChanges: { service_type: 'car-flat-tire' } });
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.job.technician_estimated_earning, 1200);
  assert.equal(db.estimates(), 0);
});

test('an old accept tap cannot accept a newer differently priced offer', async () => {
  const db = scenario({ offerId: 22 });
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_unavailable');
  assert.equal(db.job.status, 'pending');
  assert.equal(db.technician.current_job_id, null);
});

test('acceptance without an offer identity cannot silently agree to a replacement price', async () => {
  const db = scenario();
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_required');
  assert.equal(db.job.status, 'pending');
});

test('a legacy pending offer without a saved price cannot silently reprice on acceptance', async () => {
  const db = scenario({ snapshot: null });
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_price_unavailable');
  assert.equal(db.job.status, 'pending');
  assert.equal(db.events.length, 0);
});

test('a corrupt or underfunded offer is rejected before job ownership changes', async () => {
  const db = scenario({ snapshot: quoted({ customer_base_amount: 599, customer_total_amount: 658.9 }) });
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_price_unavailable');
  assert.equal(db.technician.current_job_id, null);
  assert.equal(db.commits(), 0);
});

test('direct assignment remains unpriced to the customer until the saved offer is accepted', async () => {
  const db = scenario({ jobChanges: { status: 'assigned', technician_id: 7 } });
  const result = await db.accept({ offerId: 21 });
  assert.equal(result.success, true);
  assert.equal(db.job.status, 'accepted');
  assert.equal(db.job.amount, 1200);
  assert.equal(db.estimates(), 0);
});

test('lost acceptance response recovers the exact committed price without new pricing or notifications', async () => {
  const db = scenario();
  const first = await db.accept({ offerId: 21 });
  const count = db.events.length;
  const second = await db.accept({ offerId: 21 });
  assert.equal(first.success, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.job.technician_estimated_earning, 1200);
  assert.equal(second.job.final_price, 1320);
  assert.equal(db.estimates(), 0);
  assert.equal(db.events.length, count);
});

test('acceptance never broadcasts customer contact details or pricing to unrelated sockets', async () => {
  const db = scenario({ jobChanges: { contact_email: 'customer@example.test', contact_phone: '9000000000' } });
  assert.equal((await db.accept({ offerId: 21 })).success, true);
  assert.equal(db.events.some(event => event[0] === 'global' && event[2]?.contact_email), false);
  const update = db.events.find(event => event[0] === 'room' && event[1] === 'request_101' && event[2] === 'job_update_101');
  assert.equal(update?.[3]?.amount, 1200);
});
