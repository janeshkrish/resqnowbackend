import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeVehicleFamily, normalizeVehicleTypes } from '../services/serviceNormalization.js';
import { jobDispatchService } from '../services/jobDispatchService.js';
import { requiredTowTruckType } from '../services/towTruckCapability.js';

const details = (values) => ({ answers: Object.entries(values).map(([id, value]) => ({ id, question: id, value, label: String(value) })) });
const request = (service = 'flat-tire', overrides = {}) => ({ id: 501, service_type: `ev-${service}`, vehicle_type: 'ev',
  vehicle_subtype: 'electric-scooter', location_lat: 11.0168, location_lng: 76.9558, status: 'pending', ...overrides });
const tech = (vehicle = 'bike', service = 'flat-tire', overrides = {}) => ({ id: 7, status: 'approved', is_active: 1,
  is_available: 1, current_job_id: null, service_type: service, specialties: [service], service_costs: {},
  vehicle_types: { [vehicle]: true }, latitude: 11.0168, longitude: 76.9558, service_area_range: 25, ...overrides });
const evaluate = (job, provider) => jobDispatchService.analyzeTechnicians(job, [provider]).analysis[0];

for (const label of ['Electric Bike', 'Electric Scooter', 'electric-bike', 'Electric Cars', 'EV scooter', 'Electric SUV', 'ev']) {
  test(`${label} retains its EV identity`, () => assert.equal(canonicalizeVehicleFamily(label), 'ev'));
}
test('technician EV labels do not register ordinary bike support', () => {
  assert.deepEqual(normalizeVehicleTypes(['Electric Bike', 'Electric Scooter']), { ev: true });
});
test('ordinary vehicle names and unrelated EV substrings retain their classes', () => {
  assert.equal(canonicalizeVehicleFamily('Scooter'), 'bike');
  assert.equal(canonicalizeVehicleFamily('Car'), 'car');
  assert.notEqual(canonicalizeVehicleFamily('Chevrolet'), 'ev');
});

for (const service of ['flat-tire', 'lockout', 'towing']) {
  test(`an electric scooter can use a registered ordinary bike ${service} provider`, () => {
    const job = request(service, service === 'towing' ? { tow_truck_type: 'flatbed' } : {});
    const provider = tech('bike', service, { fleet_vehicles: [{ vehicle_type: 'flatbed', status: 'available' }] });
    assert.equal(evaluate(job, provider).eligible, true);
    assert.equal(job.vehicle_type, 'ev');
    assert.equal(job.vehicle_subtype, 'electric-scooter');
  });
}
test('an electric car can use a compatible car puncture provider', () => {
  assert.equal(evaluate(request('flat-tire', { vehicle_subtype: 'electric-car' }), tech('car')).eligible, true);
});
test('an EV car is never opened to a bike-only puncture provider', () => {
  assert.equal(evaluate(request('flat-tire', { vehicle_subtype: 'electric-car' }), tech()).eligible, false);
});
test('an unknown EV subtype cannot select the ordinary bike pool', () => {
  assert.equal(evaluate(request('flat-tire', { vehicle_subtype: null }), tech()).eligible, false);
  assert.equal(evaluate(request('flat-tire', { vehicle_subtype: null }), tech('ev')).eligible, true);
});
test('an EV scooter label without a separate subtype still derives the correct shared pool', () => {
  assert.equal(evaluate(request('flat-tire', { vehicle_type: 'Electric Scooter', vehicle_subtype: null }), tech()).eligible, true);
});
test('an EV-prefixed scooter label also derives the compatible physical pool', () => {
  assert.equal(evaluate(request('flat-tire', { vehicle_type: 'EV Scooter', vehicle_subtype: null }), tech()).eligible, true);
});
test('an explicit electric subtype preserves the flatbed default even with a legacy car family', () => {
  assert.equal(requiredTowTruckType(request('towing', { vehicle_type: 'car', vehicle_subtype: 'electric-car',
    request_details_json: details({ roll: 'yes' }) })), 'flatbed');
});
test('EV towing sharing retains the flatbed equipment guard', () => {
  const outcome = evaluate(request('towing', { tow_truck_type: 'flatbed' }), tech('bike', 'towing',
    { fleet_vehicles: [{ vehicle_type: 'wheel-lift', status: 'available' }] }));
  assert.equal(outcome.eligible, false);
  assert.ok(outcome.reasons.includes('tow_truck_mismatch'));
});
test('explicit chassis inspection can use a compatible ordinary mechanic', () => {
  assert.equal(evaluate(request('mechanical', { request_details_json: details({ mechanical_scope: 'chassis', issue: ['brakes'] }) }), tech('bike', 'mechanical')).eligible, true);
});
for (const scope of [null, 'unknown', 'ev-system']) {
  test(`mechanical scope ${scope} keeps the EV specialist requirement`, () => {
    const job = request('mechanical', { request_details_json: details({ mechanical_scope: scope || 'unknown' }) });
    assert.equal(evaluate(job, tech('bike', 'mechanical')).eligible, false);
    assert.equal(evaluate(job, tech('ev', 'mechanical')).eligible, true);
  });
}
test('an electrical symptom cannot be disguised as chassis work', () => {
  const job = request('mechanical', { request_details_json: details({ mechanical_scope: 'chassis', issue: ['brakes', 'nostart'] }) });
  assert.equal(evaluate(job, tech('bike', 'mechanical')).eligible, false);
});
test('EV auxiliary battery assistance remains with EV-capable battery providers', () => {
  const job = request('battery', { request_details_json: details({ battery_scope: 'auxiliary' }) });
  assert.equal(evaluate(job, tech('bike', 'battery')).eligible, false);
  assert.equal(evaluate(job, tech('ev', 'battery')).eligible, true);
});
test('pure EV fuel delivery is rejected even for a technician advertising fuel and EV support', () => {
  const result = evaluate(request('fuel'), tech('ev', 'fuel'));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('ev_fuel_not_supported'));
});
test('a petrol vehicle cannot select the EV charging pool', () => {
  assert.equal(evaluate(request('ev-charging', { service_type: 'ev-charging', vehicle_type: 'car', vehicle_subtype: 'sedan' }), tech('car', 'ev-charging')).eligible, false);
});
test('ordinary vehicles do not inherit EV-only support through the shared-service rule', () => {
  assert.equal(evaluate(request('flat-tire', { service_type: 'bike-flat-tire', vehicle_type: 'bike', vehicle_subtype: 'scooter' }), tech('ev')).eligible, false);
});
test('charging eligibility checks the declared connector before offering work', () => {
  const job = request('ev-charging', { request_details_json: details({ port: 'home' }) });
  const provider = tech('ev', 'ev-charging', { service_costs: [{ service_domain: 'ev-charging', vehicle_type: 'ev',
    service_charge: 200, supported_connectors: 'ccs2' }] });
  assert.equal(evaluate(job, provider).eligible, false);
  provider.service_costs[0].supported_connectors = 'home';
  assert.equal(evaluate(job, provider).eligible, true);
});
test('a compatible charging provider is not hidden behind a nearer incompatible shortlist', async () => {
  const providers = Array.from({ length: 7 }, (_, index) => tech('ev', 'ev-charging', { id: index + 1 }));
  const prices = providers.map(provider => ({ technician_id: provider.id, service_domain: 'ev-charging', vehicle_type: 'ev',
    service_charge: 200, metadata: { supported_connectors: provider.id === 7 ? 'home' : 'ccs2' } }));
  const pool = { query: async sql => /FROM technician_services/.test(sql) ? [prices] : [providers] };
  const routes = [];
  const result = await jobDispatchService.findTopTechnicians(request('ev-charging', { request_details_json: details({ port: 'home' }) }), 25,
    { pool, routeProvider: async input => { routes.push(input); return { durationMinutes: 5, distanceKm: 1 }; } });
  assert.deepEqual(result.map(provider => provider.id), [7]);
  assert.equal(routes.length, 1);
});
