import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EV_CATEGORY_CODE,
  EvChargingError,
  createEvChargingService,
  getEvChargingConfig,
  openStatusFromHours,
  parseEvInformation,
} from '../services/evChargingService.js';

const SECRET = 'test-mappls-key-do-not-log';
const USER = { lat: 11.01684, lng: 76.95583 };
const IST = (hhmm) => Date.parse(`2026-09-26T${hhmm}:00+05:30`);

const nearbyEntry = (overrides = {}) => ({
  distance: 1800,
  eLoc: 'EV1A2B',
  placeName: 'Tata Power Charging Station',
  placeAddress: 'Race Course Road, Coimbatore, Tamil Nadu',
  mobileNo: '',
  landlineNo: '',
  keywords: [EV_CATEGORY_CODE],
  type: 'POI',
  ...overrides,
});

const evRichInfo = {
  evInformation: {
    evses: [
      { powerType: 'DC', evseId: 'E1', connectors: [{ plugTyp: 'CCS2', power: '60', connectorId: 'C1' }] },
      { powerType: 'AC', evseId: 'E2', connectors: [{ plugTyp: 'Type2', power: '22 kW', connectorId: 'C2' }] },
      { powerType: 'DC', evseId: 'E3', connectors: [{ plugTyp: 'CHAdeMO', power: '50', connectorId: 'C3' }] },
      { powerType: 'DC', evseId: 'E4', connectors: [{ plugTyp: 'CCS 2', power: '60', connectorId: 'C4' }] },
    ],
  },
};

function createHarness({ nearby, details, config = {}, clock = { now: IST('10:00') } } = {}) {
  const calls = [];
  const warnings = [];
  const http = {
    get: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/nearby/')) return nearby ? nearby(options) : { status: 200, data: { suggestedLocations: [nearbyEntry()] } };
      return details ? details(url, options) : { status: 200, data: { latitude: 11.0301, longitude: 76.9712, richInfo: evRichInfo } };
    },
  };
  const service = createEvChargingService({
    config: { ...getEvChargingConfig({ MAPPLS_REST_API_KEY: SECRET }), ...config },
    http,
    now: () => clock.now,
    warn: (...entry) => warnings.push(entry),
  });
  const nearbyCalls = () => calls.filter((call) => call.url.includes('/nearby/'));
  const detailCalls = () => calls.filter((call) => call.url.includes('/place-details/'));
  return { service, calls, nearbyCalls, detailCalls, warnings, clock };
}

test('config defaults to a 5 km search and keeps the radius within Mappls limits', () => {
  assert.equal(getEvChargingConfig({}).defaultRadiusMeters, 5_000);
  assert.equal(getEvChargingConfig({ EV_SEARCH_RADIUS_METERS: '50' }).defaultRadiusMeters, 500);
  assert.equal(getEvChargingConfig({ EV_SEARCH_RADIUS_METERS: '99000' }).defaultRadiusMeters, 10_000);
});

test('searches Mappls Nearby server-side for the EV charging category', async () => {
  const { service, nearbyCalls } = createHarness();
  await service.findStations({ ...USER, radiusMeters: 2_000 });

  const [{ url, options }] = nearbyCalls();
  assert.equal(url, 'https://search.mappls.com/search/places/nearby/json');
  assert.deepEqual(options.params, {
    keywords: 'TRNECS',
    refLocation: '11.017,76.956',
    radius: 2_000,
    sortBy: 'dist:asc',
    region: 'IND',
    access_token: SECRET,
  });
});

test('normalizes a station with coordinates and EV details from Mappls', async () => {
  const { service } = createHarness();
  const result = await service.findStations(USER);

  assert.equal(result.source, 'mappls');
  assert.equal(result.radiusMeters, 5_000);
  assert.equal(result.total, 1);
  assert.equal(result.located, 1);
  const [station] = result.stations;
  assert.deepEqual(station, {
    id: 'EV1A2B',
    mapplsPlaceId: 'EV1A2B',
    name: 'Tata Power Charging Station',
    brand: 'tatapower',
    address: 'Race Course Road, Coimbatore, Tamil Nadu',
    latitude: 11.0301,
    longitude: 76.9712,
    chargingTypes: ['AC', 'DC'],
    connectorTypes: ['CCS2', 'Type 2', 'CHAdeMO'],
    chargingPower: 60,
    chargingSlots: 4,
    distance: station.distance,
    availability: { status: 'unknown' },
  });
  // Distance is measured from the customer, not the rounded search point.
  assert.ok(station.distance > 2_000 && station.distance < 2_300, String(station.distance));
});

test('never invents fields Mappls did not return', async () => {
  const { service } = createHarness({ details: () => ({ status: 200, data: { name: 'Station', eloc: 'EV1A2B' } }) });
  const [station] = (await service.findStations(USER)).stations;

  assert.equal(station.latitude, null);
  assert.equal(station.longitude, null);
  assert.equal(station.distance, 1800, 'falls back to the distance Mappls reported');
  for (const field of ['connectorTypes', 'chargingTypes', 'chargingPower', 'chargingSlots', 'phone', 'openingHours', 'isOpen', 'provider']) {
    assert.equal(field in station, false, field);
  }
  assert.deepEqual(station.availability, { status: 'unknown' });
});

test('values from the nearby result are kept over place details', async () => {
  const { service, detailCalls } = createHarness({
    nearby: () => ({
      status: 200,
      data: { suggestedLocations: [nearbyEntry({ latitude: 11.02, longitude: 76.96, mobileNo: '9876543210', richInfo: evRichInfo })] },
    }),
  });
  const [station] = (await service.findStations(USER)).stations;
  assert.equal(station.latitude, 11.02);
  assert.equal(station.phone, '9876543210');
  assert.equal(detailCalls().length, 0, 'a complete nearby result needs no details call');
});

test('a key without Place Details access falls back to search results and stops asking', async () => {
  const { service, detailCalls, warnings, clock } = createHarness({ details: () => ({ status: 403, data: {} }) });
  const first = await service.findStations(USER);
  assert.equal(first.stations[0].latitude, null);
  assert.equal(detailCalls().length, 1);

  clock.now += 16 * 60_000; // search cache expired, details backoff (10 min) too
  await service.findStations(USER);
  assert.equal(detailCalls().length, 2);

  await service.findStations({ lat: 12.97, lng: 77.59 });
  assert.equal(detailCalls().length, 2, 'no details calls during the backoff');
  assert.ok(!JSON.stringify(warnings).includes(SECRET));
});

test('the same area is cached and simultaneous searches share one Mappls call', async () => {
  const { service, nearbyCalls, clock } = createHarness();
  await Promise.all([service.findStations(USER), service.findStations({ lat: 11.0169, lng: 76.9559 })]);
  assert.equal(nearbyCalls().length, 1);

  await service.findStations(USER);
  assert.equal(nearbyCalls().length, 1, 'cache hit');

  await service.findStations({ lat: 11.05, lng: 76.99 });
  assert.equal(nearbyCalls().length, 2, 'a different area searches again');

  clock.now += 15 * 60_000 + 1;
  await service.findStations(USER);
  assert.equal(nearbyCalls().length, 3, 'expired cache searches again');
});

test('no results is an empty list, and failures are errors without the key', async () => {
  const empty = createHarness({ nearby: () => ({ status: 204, data: null }) });
  assert.deepEqual((await empty.service.findStations(USER)).stations, []);

  const failing = createHarness({ nearby: () => ({ status: 500, data: {} }) });
  await assert.rejects(failing.service.findStations(USER), (error) => {
    assert.ok(error instanceof EvChargingError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'ev_search_failed');
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  assert.ok(!JSON.stringify(failing.warnings).includes(SECRET));

  const offline = createHarness({ nearby: () => { throw Object.assign(new Error(`GET https://x?access_token=${SECRET}`), { code: 'ECONNABORTED' }); } });
  await assert.rejects(offline.service.findStations(USER), (error) => !String(error.message).includes(SECRET));
});

test('refuses to search without a key or a valid location', async () => {
  const unconfigured = createEvChargingService({ config: getEvChargingConfig({}), http: { get: async () => { throw new Error('must not call'); } } });
  await assert.rejects(unconfigured.findStations(USER), { statusCode: 503, code: 'ev_search_unavailable' });

  const { service } = createHarness();
  await assert.rejects(service.findStations({ lat: 'x', lng: 76 }), { statusCode: 400 });
  await assert.rejects(service.findStations({ lat: 0, lng: 0 }), { statusCode: 400 });
});

test('open or closed is only reported for unambiguous hours', () => {
  assert.equal(openStatusFromHours('Open 24 Hours', IST('03:00')), true);
  assert.equal(openStatusFromHours('24x7', IST('03:00')), true);
  assert.equal(openStatusFromHours('09:00-18:00', IST('10:00')), true);
  assert.equal(openStatusFromHours('09:00 - 18:00', IST('20:00')), false);
  assert.equal(openStatusFromHours('Mon-Sun 22:00-06:00', IST('23:30')), true);
  assert.equal(openStatusFromHours('Mon-Fri 09:00-18:00', IST('10:00')), undefined);
  assert.equal(openStatusFromHours('09:00-13:00, 14:00-18:00', IST('10:00')), undefined);
  assert.equal(openStatusFromHours('', IST('10:00')), undefined);
});

test('station hours flow through to the open status', async () => {
  const { service } = createHarness({
    nearby: () => ({ status: 200, data: { suggestedLocations: [nearbyEntry({ hourOfOperation: '06:00-22:00', latitude: 11.02, longitude: 76.96, richInfo: evRichInfo })] } }),
  });
  const [station] = (await service.findStations(USER)).stations;
  assert.deepEqual(station.openingHours, ['06:00-22:00']);
  assert.equal(station.isOpen, true);
});

test('EV details parse plug names, charging type, top power and charge points', () => {
  assert.deepEqual(parseEvInformation(evRichInfo), {
    chargingTypes: ['AC', 'DC'],
    connectorTypes: ['CCS2', 'Type 2', 'CHAdeMO'],
    chargingPower: 60,
    chargingSlots: 4,
  });
  assert.deepEqual(parseEvInformation(undefined), {
    chargingTypes: undefined,
    connectorTypes: undefined,
    chargingPower: undefined,
    chargingSlots: undefined,
  });
});
