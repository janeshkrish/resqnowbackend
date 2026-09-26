import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EvChargingError,
  createFuelStationService,
  detectBrand,
  getFuelStationConfig,
} from '../services/evChargingService.js';

const SECRET = 'test-mappls-key-do-not-log';
const USER = { lat: 11.01684, lng: 76.95583 };

function harness(nearby) {
  const calls = [];
  const warnings = [];
  const service = createFuelStationService({
    config: getFuelStationConfig({ MAPPLS_REST_API_KEY: SECRET }),
    http: {
      get: async (url, options) => {
        calls.push({ url, options });
        if (url.includes('/nearby/')) return nearby();
        return { status: 200, data: { latitude: 11.021, longitude: 76.961 } };
      },
    },
    now: () => Date.parse('2026-09-27T10:00:00+05:30'),
    warn: (...entry) => warnings.push(entry),
  });
  return { service, calls, warnings };
}

const entry = (overrides) => ({ distance: 900, eLoc: 'FUEL01', placeName: 'IndianOil COCO Race Course', placeAddress: 'Race Course Road, Coimbatore', keywords: ['TRNPMP'], ...overrides });

test('searches Mappls for petrol pumps and CNG stations together', async () => {
  const { service, calls } = harness(() => ({ status: 200, data: { suggestedLocations: [entry()] } }));
  await service.findStations(USER);
  const [{ options }] = calls.filter((call) => call.url.includes('/nearby/'));
  assert.equal(options.params.keywords, 'TRNPMP;TRNCNG');
  assert.equal(options.params.access_token, SECRET);
  assert.equal(options.params.radius, 5_000);
});

test('returns brand, station type and coordinates without EV-only fields', async () => {
  const { service } = harness(() => ({
    status: 200,
    data: {
      suggestedLocations: [
        entry(),
        entry({ eLoc: 'FUEL02', placeName: 'Sri Murugan CNG', keywords: ['TRNCNG'], distance: 1500 }),
      ],
    },
  }));
  const result = await service.findStations(USER);
  const [indianOil, cng] = result.stations;
  assert.equal(indianOil.brand, 'indianoil');
  assert.deepEqual(indianOil.stationTypes, ['petrol']);
  assert.equal(indianOil.latitude, 11.021);
  assert.equal('availability' in indianOil, false);
  assert.equal('connectorTypes' in indianOil, false);
  assert.equal(cng.brand, undefined);
  assert.deepEqual(cng.stationTypes, ['cng']);
});

test('fuel search failures use fuel error codes and never carry the key', async () => {
  const failing = harness(() => ({ status: 500, data: {} }));
  await assert.rejects(failing.service.findStations(USER), (error) => {
    assert.ok(error instanceof EvChargingError);
    assert.equal(error.code, 'fuel_search_failed');
    assert.equal(error.message, 'Fuel stations are temporarily unavailable.');
    return true;
  });
  assert.ok(!JSON.stringify(failing.warnings).includes(SECRET));

  const unconfigured = createFuelStationService({ config: getFuelStationConfig({}), http: { get: async () => { throw new Error('must not call'); } } });
  await assert.rejects(unconfigured.findStations(USER), { statusCode: 503, code: 'fuel_search_unavailable' });
});

test('brands are recognised from the names Mappls returns', () => {
  const fuel = {
    'IndianOil COCO Race Course': 'indianoil',
    'IOCL Retail Outlet': 'indianoil',
    'Bharat Petroleum - Sri Ram Fuels': 'bpcl',
    'HP Petrol Pump Gandhipuram': 'hpcl',
    'Nayara Energy Outlet': 'nayara',
    'Shell Petrol Bunk': 'shell',
    'Jio-bp Mobility Station': 'jiobp',
    'Sri Murugan Fuels': undefined,
  };
  for (const [name, brand] of Object.entries(fuel)) assert.equal(detectBrand(name, 'fuel'), brand, name);
  assert.equal(detectBrand('Tata Power EZ Charge', 'ev'), 'tatapower');
  assert.equal(detectBrand('Statiq Charging Station', 'ev'), 'statiq');
  assert.equal(detectBrand('Jio-bp pulse', 'ev'), 'jiobp');
  assert.equal(detectBrand('Shell Recharge', 'ev'), undefined, 'EV brands are matched separately from fuel');
});
