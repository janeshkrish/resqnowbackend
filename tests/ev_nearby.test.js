import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import mysql from 'mysql2/promise';
process.env.DB_HOST = 'simulated.invalid';
process.env.DB_MIGRATION_MODE = 'off';
process.env.DB_USER = 'simulated';
process.env.DB_PASSWORD = 'simulated';
process.env.DB_NAME = 'simulated';
let state;
const provider = (id, family, domain) => ({ id, name: `Provider ${id}`, status: 'approved', is_active: 1, is_available: 1,
  service_type: domain, specialties: JSON.stringify([domain]), vehicle_types: JSON.stringify({ [family]: true }),
  latitude: 11.0168, longitude: 76.9558, service_area_range: 25, rating: 4.5, jobs_completed: 10, service_costs: '[]' });
const pool = { query: async sql => {
  if (sql === 'SELECT 1') return [[{ ok: 1 }]];
  if (/FROM platform_pricing_config/.test(sql)) return [[{ id: 1, currency: 'INR' }]];
  if (/FROM technician_services/.test(sql)) return [state.prices];
  if (/FROM technicians/.test(sql)) return [state.providers];
  throw new Error(`Unexpected simulated nearby query: ${sql}`);
}, end: async () => {} };
pool.execute = pool.query;
mock.method(mysql, 'createPool', () => pool);
const db = await import('../db.js');
const { default: router } = await import('../routes/technicians.js');
beforeEach(() => { state = { providers: [provider(7, 'bike', 'flat-tire')], prices: [{ technician_id: 7,
  service_domain: 'flat-tire', vehicle_type: 'bike', visit_charge: 100, service_charge: 50,
  metadata: { subcategories: { scooter: { tubeless_price: 50 } } } }] }; });
after(async () => { await db.closePool(); mock.restoreAll(); });
async function nearby(extra = {}) {
  const handler = router.stack.find(layer => layer.route?.path === '/nearby').route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ query: { lat: '11.0168', lng: '76.9558', service_type: 'flat-tire', vehicle_type: 'ev',
    vehicle_subtype: 'electric-scooter', ...extra }, ip: 'simulated' }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}
test('nearby EV puncture discovery includes a compatible ordinary scooter provider and its applicable starting rate', async () => {
  const result = await nearby();
  assert.deepEqual(result.map(item => item.id), ['7']);
  assert.equal(result[0].price, 150);
});
test('nearby discovery retains the subtype inferred from a legacy electric vehicle label', async () => {
  assert.equal((await nearby({ vehicle_type: 'Electric Scooter', vehicle_subtype: undefined }))[0]?.price, 150);
});
test('nearby EV puncture starting price uses the selected scooter tier instead of another tier minimum', async () => {
  state.prices[0].metadata.subcategories.scooter = { tubeless_price: 90, tube_tyre_price: 70 };
  assert.equal((await nearby())[0].price, 170);
  const details = { answers: [{ id: 'tyretype', question: 'Tyre', value: 'tubeless', label: 'Tubeless' }] };
  assert.equal((await nearby({ details: JSON.stringify(details) }))[0].price, 190);
});
test('nearby EV towing displays the selected subtype base instead of a parent minimum', async () => {
  state.providers = [provider(7, 'bike', 'towing')];
  state.prices = [{ technician_id: 7, service_domain: 'towing', vehicle_type: 'bike', base_price: 100,
    metadata: { subcategories: { scooter: { base_charge: 900, free_distance: 0, per_km_charge: 30 } } } }];
  assert.equal((await nearby({ service_type: 'towing' }))[0].price, 900);
});
test('nearby EV car discovery excludes a bike-only provider', async () => {
  assert.deepEqual(await nearby({ vehicle_subtype: 'electric-car' }), []);
});
test('nearby mechanical discovery uses the supplied EV scope', async () => {
  state.providers = [provider(7, 'bike', 'mechanical')];
  state.prices = [{ technician_id: 7, service_domain: 'mechanical', vehicle_type: 'bike', service_charge: 400, visit_charge: 100, metadata: {} }];
  const details = { answers: [{ id: 'mechanical_scope', question: 'Work', value: 'chassis', label: 'Chassis' }] };
  assert.equal((await nearby({ service_type: 'mechanical', details: JSON.stringify(details) })).length, 1);
  details.answers[0].value = 'ev-system';
  assert.deepEqual(await nearby({ service_type: 'mechanical', details: JSON.stringify(details) }), []);
});
test('nearby charging discovery excludes unsupported connectors', async () => {
  state.providers = [provider(7, 'ev', 'ev-charging')];
  state.prices = [{ technician_id: 7, service_domain: 'ev-charging', vehicle_type: 'ev', service_charge: 200, metadata: { supported_connectors: 'ccs2' } }];
  const details = { answers: [{ id: 'port', question: 'Connector', value: 'home', label: 'Home' }] };
  assert.deepEqual(await nearby({ service_type: 'ev-charging', details: JSON.stringify(details) }), []);
  details.answers[0].value = 'ccs2';
  assert.equal((await nearby({ service_type: 'ev-charging', details: JSON.stringify(details) })).length, 1);
});
test('nearby EV mechanical price uses its subtype labour tariff', async () => {
  state.providers = [provider(7, 'ev', 'mechanical')];
  state.prices = [{ technician_id: 7, service_domain: 'mechanical', vehicle_type: 'ev', visit_charge: 100, service_charge: 20,
    metadata: { subcategories: { 'electric-scooter': { labour_min: 500 } } } }];
  assert.equal((await nearby({ service_type: 'mechanical' }))[0]?.price, 600);
});
test('nearby legacy pricing does not drop an invalid EV tariff and advertise an ordinary fallback', async () => {
  state.providers = [provider(7, 'bike', 'lockout')];
  state.providers[0].service_costs = JSON.stringify([
    { service_domain: 'lockout', vehicle_type: 'ev', service_charge: 'broken' },
    { service_domain: 'lockout', vehicle_type: 'bike', service_charge: 80 },
  ]);
  state.prices = [];
  assert.deepEqual(await nearby({ service_type: 'lockout' }), []);
});
