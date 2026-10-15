import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTechnicianEarningForRequest } from '../services/technicianEarningsService.js';
import { buildDispatchPricingSnapshot } from '../services/dispatchPricingService.js';
import { readRequestDetails } from '../services/requestDetails.js';

const answers = values => ({ answers: Object.entries(values).map(([id, value]) => ({ id, question: id, value, label: String(value) })) });
const request = (service = 'flat-tire', extra = {}) => ({ id: 501, technician_id: null, service_type: `ev-${service}`,
  vehicle_type: 'ev', vehicle_subtype: 'electric-scooter', vehicle_brand: 'Ather', payment_method: 'cash',
  request_details_json: answers({ tyretype: 'tubeless' }), ...extra });
const row = (extra = {}) => ({ id: 11, technician_id: 7, service_domain: 'flat-tire', vehicle_type: 'bike',
  visit_charge: 100, service_charge: 50, metadata: { subcategories: { scooter: { tubeless_price: 50, tube_tyre_price: 30 } } }, ...extra });
const connectionFor = rows => ({ query: async (sql, params = []) => {
  if (/FROM technician_services/.test(sql)) return [rows.filter(item => item.service_domain === params[1] && (item.vehicle_type === params[2] || item.vehicle_type === ''))
    .sort((a,b) => Number(b.vehicle_type === params[2]) - Number(a.vehicle_type === params[2])).slice(0,1)];
  if (/SELECT service_costs FROM technicians/.test(sql)) return [[]];
  throw new Error(`Unexpected simulated pricing query: ${sql}`);
} });
const earning = (job, rows) => estimateTechnicianEarningForRequest({ request: job, technicianId: 7,
  technician: { id: 7 }, connection: connectionFor(rows), requireRegisteredPricing: true });

test('shared EV scooter puncture uses the applicable registered scooter tyre rate', async () => {
  const job = request();
  const result = await earning(job, [row()]);
  assert.equal(result?.amount, 150);
  assert.equal(result.breakdown.pricing_vehicle_type, 'bike');
  assert.equal(job.vehicle_type, 'ev');
});
test('pricing retains EV identity inferred from an electric subtype in legacy requests', async () => {
  const result = await earning(request('flat-tire', { vehicle_type: 'bike' }), [row()]);
  assert.equal(result?.breakdown.vehicle_type, 'ev');
  assert.equal(result?.amount, 150);
});
test('a registered EV rate takes priority over the shared ordinary rate', async () => {
  const result = await earning(request(), [row(), row({ id: 12, vehicle_type: 'ev', service_charge: 90,
    metadata: { subcategories: { 'electric-scooter': { tubeless_price: 90 } } } })]);
  assert.equal(result?.amount, 190);
});
test('an invalid explicit EV rate never silently becomes a cheaper ordinary rate', async () => {
  assert.equal(await earning(request(), [row(), row({ vehicle_type: 'ev', visit_charge: -100,
    metadata: { subcategories: { 'electric-scooter': { tubeless_price: 90 } } } })]), null);
});
test('the wrong physical vehicle price cannot fund an EV car offer', async () => {
  assert.equal(await earning(request('flat-tire', { vehicle_subtype: 'electric-car' }), [row()]), null);
});
test('a missing compatible scooter subtype price cannot be replaced with a bike minimum', async () => {
  assert.equal(await earning(request(), [row({ metadata: { subcategories: { 'sports-bike': { tubeless_price: 20 } } } })]), null);
});
for (const service of ['flat-tire', 'mechanical', 'battery', 'ev-charging']) {
  test(`an incomplete EV ${service} tier cannot borrow another subtype's parent tariff`, async () => {
    const job = request(service, { request_details_json: answers({ port: 'ccs2', tyretype: 'tubeless' }) });
    const price = row({ service_domain: service, vehicle_type: 'ev', service_charge: 20,
      metadata: { subcategories: { 'electric-scooter': service === 'ev-charging' ? { supported_connectors: 'ccs2' } : {},
        'electric-car': { service_charge: 20, tubeless_price: 20 } } } });
    assert.equal(await earning(job, [price]), null);
  });
}
test('legacy EV body labels preserve their known registered physical tier', async () => {
  const job = request('flat-tire', { vehicle_subtype: 'Hatchback' });
  assert.equal((await earning(job, [row({ vehicle_type: 'car', metadata: { subcategories: { hatchback: { tubeless_price: 60 } } } })]))?.amount, 160);
});
test('a chassis inspection can use the registered ordinary mechanic rate', async () => {
  const job = request('mechanical', { request_details_json: answers({ mechanical_scope: 'chassis', issue: ['brakes'] }) });
  assert.equal((await earning(job, [row({ service_domain: 'mechanical', service_charge: 400, metadata: {} })]))?.amount, 500);
});
test('EV electrical faults cannot reuse an ordinary mechanical price', async () => {
  const job = request('mechanical', { request_details_json: answers({ mechanical_scope: 'ev-system' }) });
  assert.equal(await earning(job, [row({ service_domain: 'mechanical', metadata: {} })]), null);
});
test('shared EV towing uses the required registered flatbed rate', async () => {
  const job = request('towing', { route_distance_km: 10, tow_truck_type: 'flatbed' });
  const price = row({ service_domain: 'towing', base_price: 900, free_km: 5, per_km_price: 30,
    metadata: { fleet_pricing: { flatbed: { base_charge: 900, free_distance: 5, per_km_charge: 30 } } } });
  assert.equal((await earning(job, [price]))?.amount, 1050);
});
for (const vehicle of ['bike', 'ev']) {
  test(`EV towing uses the selected ${vehicle} subtype rate instead of a parent minimum`, async () => {
    const job = request('towing', { route_distance_km: 10, tow_truck_type: 'flatbed' });
    const price = row({ service_domain: 'towing', vehicle_type: vehicle, base_price: 100, free_km: 0, per_km_price: 1,
      metadata: { subcategories: { scooter: { base_charge: 900, free_distance: 0, per_km_charge: 30 } } } });
    assert.equal((await earning(job, [price]))?.amount, 1200);
    price.metadata.subcategories.scooter.fleet_pricing = { flatbed: { base_charge: 1100, free_distance: 5, per_km_charge: 40 } };
    assert.equal((await earning(job, [price]))?.amount, 1300);
  });
}
test('an incomplete towing subtype cannot inherit monetary minimums hidden in legacy metadata', async () => {
  const price = row({ service_domain: 'towing', vehicle_type: 'ev', base_price: 100, free_km: 0, per_km_price: 1,
    metadata: { base_price: 100, free_km: 0, per_km_price: 1, subcategories: { scooter: {} } } });
  assert.equal(await earning(request('towing', { route_distance_km: 10, tow_truck_type: 'flatbed' }), [price]), null);
});
test('an unknown EV subtype cannot inherit a generic ordinary car rate', async () => {
  assert.equal(await earning(request('lockout', { vehicle_subtype: null }), [row({ service_domain: 'lockout', vehicle_type: 'car', metadata: {} })]), null);
});
test('generic wildcard pricing cannot replace an explicitly required EV battery capability', async () => {
  assert.equal(await earning(request('battery'), [row({ service_domain: 'battery', vehicle_type: '', metadata: {} })]), null);
});
test('charging requires the actual selected connector in the selected subtype rate', async () => {
  const job = request('ev-charging', { vehicle_subtype: 'electric-car', request_details_json: answers({ port: 'ccs2' }) });
  const price = row({ service_domain: 'ev-charging', vehicle_type: 'ev', metadata: { subcategories: {
    'electric-car': { service_charge: 500, supported_connectors: 'ccs2' },
    'electric-scooter': { service_charge: 200, supported_connectors: 'home' } } } });
  assert.equal((await earning(job, [price]))?.amount, 600);
  job.request_details_json = answers({ port: 'home' });
  assert.equal(await earning(job, [price]), null);
});
test('charging cannot use missing connector declarations or an unknown customer port', async () => {
  const price = row({ service_domain: 'ev-charging', vehicle_type: 'ev', metadata: {} });
  assert.equal(await earning(request('ev-charging', { request_details_json: answers({ port: 'ccs2' }) }), [price]), null);
  assert.equal(await earning(request('ev-charging', { request_details_json: answers({ port: 'dk' }) }), [price]), null);
});
test('proprietary charging support is bound to the registered brand', async () => {
  const job = request('ev-charging', { request_details_json: answers({ port: 'brand' }) });
  const price = row({ service_domain: 'ev-charging', vehicle_type: 'ev', metadata: { supported_connectors: 'brand', supported_ev_brands: 'Ather Energy' } });
  assert.equal((await earning(job, [price]))?.amount, 150);
  job.vehicle_brand = 'Ola Electric';
  assert.equal(await earning(job, [price]), null);
});
test('the saved customer and technician amounts are funded by the selected shared rate', async () => {
  const snapshot = await buildDispatchPricingSnapshot({ request: request(), technicianId: 7, connection: connectionFor([row()]) });
  assert.equal(snapshot.technician_earning, 150);
  assert.equal(snapshot.customer_base_amount, 150);
  assert.equal(snapshot.customer_total_amount, 165);
});
test('an EV rate in a legacy profile still takes priority over an ordinary SQL rate', async () => {
  const result = await estimateTechnicianEarningForRequest({ request: request(), technicianId: 7,
    technician: { id: 7, service_costs: [{ service_domain: 'flat-tire', vehicle_type: 'ev', visit_charge: 100,
      service_charge: 90, subcategories: { 'electric-scooter': { tubeless_price: 90 } } }] },
    connection: connectionFor([row()]), requireRegisteredPricing: true });
  assert.equal(result?.amount, 190);
});
for (const badRates of [{ visit_charge: 'broken', service_charge: 100 }, { visit_charge: 100, service_charge: 'broken' },
  { service_charge: 'broken' }]) {
  test(`malformed applicable legacy EV rates cannot become a partial or shared charge: ${JSON.stringify(badRates)}`, async () => {
    const result = await estimateTechnicianEarningForRequest({ request: request('lockout'), technicianId: 7,
      technician: { id: 7, service_costs: [
        { service_domain: 'lockout', vehicle_type: 'ev', ...badRates },
        { service_domain: 'lockout', vehicle_type: 'bike', service_charge: 80 } ] },
      connection: connectionFor([]), requireRegisteredPricing: true });
    assert.equal(result, null);
  });
}
test('an EV rate for another subtype does not hide a compatible registered ordinary rate', async () => {
  const result = await earning(request(), [row(), row({ vehicle_type: 'ev', metadata: {
    subcategories: { 'electric-car': { tubeless_price: 90 } } } })]);
  assert.equal(result?.amount, 150);
});
test('ordinary luxury tyre pricing still uses its registered big-SUV tier', async () => {
  const job = request('flat-tire', { service_type: 'car-flat-tire', vehicle_type: 'car', vehicle_subtype: 'luxury' });
  const price = row({ vehicle_type: 'car', metadata: { subcategories: { 'big-suv': { tubeless_price: 90 } } } });
  assert.equal((await earning(job, [price]))?.amount, 190);
});
test('known EV hatchback shape selects the registered ordinary hatchback tier', async () => {
  const job = request('flat-tire', { vehicle_subtype: 'electric-car', request_details_json: {
    ...answers({ tyretype: 'tubeless' }), vehicle_base_subtype: 'hatchback' } });
  const price = row({ vehicle_type: 'car', metadata: { subcategories: { hatchback: { tubeless_price: 60 } } } });
  assert.equal(readRequestDetails(job.request_details_json).vehicle_base_subtype, 'hatchback');
  assert.equal((await earning(job, [price]))?.amount, 160);
});
test('known EV hatchback shape can use its registered EV hatchback tier', async () => {
  const job = request('flat-tire', { vehicle_subtype: 'electric-car', request_details_json: {
    ...answers({ tyretype: 'tubeless' }), vehicle_base_subtype: 'hatchback' } });
  const price = row({ vehicle_type: 'ev', metadata: { subcategories: { hatchback: { tubeless_price: 80 } } } });
  assert.equal((await earning(job, [price]))?.amount, 180);
});
test('an inconsistent body hint cannot turn an EV car into a bike or use a scooter rate', async () => {
  const job = request('flat-tire', { vehicle_subtype: 'electric-car', request_details_json: {
    ...answers({ tyretype: 'tubeless' }), vehicle_base_subtype: 'scooter' } });
  assert.equal(await earning(job, [row()]), null);
});
