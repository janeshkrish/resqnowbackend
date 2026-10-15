import assert from 'node:assert/strict';
import test from 'node:test';
import { markTechnicianReserved } from '../services/technicianStateService.js';
import { createPricedDispatchOffer } from '../services/dispatchOfferService.js';

const job = extra => ({ id: 501, status: 'pending', service_type: 'ev-flat-tire', vehicle_type: 'ev',
  vehicle_subtype: 'electric-scooter', technician_id: null, ...extra });
function database(request, vehicles = { bike: true }) {
  const technician = { id: 7, status: 'approved', is_active: 1, is_available: 1, current_job_id: null,
    service_type: 'flat-tire', vehicle_types: vehicles };
  const writes = [];
  return { technician, writes, query: async (sql, params = []) => {
    if (/SELECT \* FROM technicians/.test(sql)) return [[technician]];
    if (/FROM service_requests/.test(sql)) return [/WHERE id = \?/.test(sql) ? [request] : []];
    if (/UPDATE technicians/.test(sql)) { writes.push(sql); technician.current_job_id = params[0]; return [{ affectedRows: 1 }]; }
    if (/UPDATE dispatch_offers/.test(sql)) { writes.push(sql); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO dispatch_offers/.test(sql)) { writes.push(sql); return [{ insertId: 11 }]; }
    throw new Error(`Unexpected simulated assignment query: ${sql}`);
  } };
}
const snapshot = () => ({ version: 1, request_id: 501, technician_id: 7, currency: 'INR', technician_earning: 100,
  customer_base_amount: 100, customer_total_amount: 110, payment_mode: 'cash', platform_fee: 10,
  payment_fee: 0, discount_amount: 0, pricing_breakdown: { tax_percent: 0, tax_amount: 0 },
  earnings_source: 'technician_pricing', calculated_at: '2026-10-15T00:00:00Z' });

test('direct/admin reservation rejects an incompatible EV physical class before claiming capacity', async () => {
  const db = database(job({ vehicle_subtype: 'electric-car' }));
  await assert.rejects(markTechnicianReserved(db, 7, 501), { code: 'vehicle_mismatch' });
  assert.equal(db.writes.length, 0);
});
test('direct/admin reservation permits a compatible shared EV service', async () => {
  const db = database(job());
  assert.equal(await markTechnicianReserved(db, 7, 501), true);
  assert.equal(db.technician.current_job_id, 501);
});
test('first acceptance cannot bypass EV-specialist restrictions through direct assignment', async () => {
  const db = database(job({ service_type: 'ev-mechanical' }));
  await assert.rejects(markTechnicianReserved(db, 7, 501), { code: 'vehicle_mismatch' });
  assert.equal(db.writes.length, 0);
});
test('continuing a previously accepted EV agreement does not reclassify or abandon it', async () => {
  const db = database(job({ status: 'accepted', technician_id: 7, vehicle_subtype: 'electric-car' }));
  db.technician.current_job_id = 501;
  db.technician.is_available = 0;
  assert.equal(await markTechnicianReserved(db, 7, 501, { alreadyOwned: true }), true);
});
test('a prebuilt price cannot advertise an EV offer to an incompatible technician', async () => {
  const request = job({ vehicle_subtype: 'electric-car' });
  const db = database(request);
  await assert.rejects(createPricedDispatchOffer(db, request, db.technician, { pricingSnapshot: snapshot() }), { code: 'vehicle_mismatch' });
  assert.equal(db.writes.length, 0);
});
