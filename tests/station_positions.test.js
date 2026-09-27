import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EV_CATEGORY_CODE,
  PETROL_PUMP_CATEGORY_CODE,
  createEvChargingService,
  createFuelStationService,
  getEvChargingConfig,
  getFuelStationConfig,
} from '../services/evChargingService.js';
import { createStationPositioner, matchStations, venueQuery } from '../services/stationPositions.js';

const CENTER = { lat: 12.972, lng: 77.595 };
// A point `north` / `east` metres from the centre.
const offset = (north, east = 0) => ({
  lat: CENTER.lat + north / 111_320,
  lng: CENTER.lng + east / (111_320 * Math.cos((CENTER.lat * Math.PI) / 180)),
});
const osmNode = (id, meters, tags, east = 0) => {
  const point = offset(meters, east);
  return { type: 'node', id, lat: point.lat, lon: point.lng, tags };
};
const station = (overrides) => ({ name: 'Station', mapplsPlaceId: 'X', providerDistanceMeters: 500, ...overrides });

test('places a station on the OpenStreetMap feature with the same brand at the same distance', () => {
  const elements = [
    osmNode(1, 520, { amenity: 'fuel', brand: 'Shell' }),
    osmNode(2, 530, { amenity: 'fuel', brand: 'Indian Oil' }, 200),
  ].map((node) => ({ id: `node/${node.id}`, lat: node.lat, lng: node.lon, text: node.tags.brand }));
  const placed = matchStations([station({ mapplsPlaceId: 'SHL1', brand: 'shell' })], elements, CENTER);
  assert.deepEqual(placed.get('SHL1'), { lat: elements[0].lat, lng: elements[0].lng });
});

test('leaves a station unplaced when the distance disagrees or two features fit equally well', () => {
  const asElement = (node) => ({ id: `node/${node.id}`, lat: node.lat, lng: node.lon, text: node.tags.brand });
  const far = [osmNode(1, 900, { brand: 'Shell' })].map(asElement);
  assert.equal(matchStations([station({ brand: 'shell' })], far, CENTER).size, 0);

  // Two Indian Oil pumps 500 m away in different directions: no way to tell which.
  const twins = [osmNode(1, 500, { brand: 'Indian Oil' }), osmNode(2, -505, { brand: 'Indian Oil' })].map(asElement);
  assert.equal(matchStations([station({ brand: 'indianoil' })], twins, CENTER).size, 0);
});

test('matches an unbranded station on a distinctive word of its name and uses each feature once', () => {
  const elements = [osmNode(1, 300, { name: 'Charzer Charging Point' })].map((node) => ({ id: `node/${node.id}`, lat: node.lat, lng: node.lon, text: node.tags.name }));
  const placed = matchStations([
    station({ mapplsPlaceId: 'A', name: 'Charzer Electric Vehicle Charging Station', providerDistanceMeters: 290 }),
    station({ mapplsPlaceId: 'B', name: 'Charzer Electric Vehicle Charging Station', providerDistanceMeters: 330 }),
    station({ mapplsPlaceId: 'C', name: 'Electric Vehicle Charging Station', providerDistanceMeters: 300 }),
  ], elements, CENTER);
  assert.deepEqual([...placed.keys()], ['A']);
});

test('builds a venue search from the first part of the address and the city', () => {
  assert.equal(
    venueQuery({ address: 'JW Marriott Hotel UB City, 24/1, Vittal Mallya Road, KG Halli, Ashok Nagar, Bengaluru, Karnataka, 560001' }),
    'JW Marriott Hotel UB City, Bengaluru',
  );
  assert.equal(venueQuery({ address: '24/1, Vittal Mallya Road, Bengaluru, Karnataka, 560001' }), null);
  assert.equal(venueQuery({ address: '' }), null);
});

function createPositionerHarness({ elements = [], overpassStatus = 200, venues = {} } = {}) {
  const overpassCalls = [];
  const searches = [];
  const timers = [];
  const clock = { now: 1_000 };
  const positioner = createStationPositioner({
    http: {
      post: async (url, body, options) => {
        overpassCalls.push({ url, body, options });
        return { status: overpassStatus, data: overpassStatus === 200 ? { elements } : null };
      },
    },
    search: async (input) => {
      searches.push(input);
      return { results: venues[input.query] || [] };
    },
    now: () => clock.now,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    warn: () => {},
  });
  const runTimers = async () => {
    while (timers.length) {
      timers.shift().fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { positioner, overpassCalls, searches, timers, runTimers, clock };
}

test('places fuel pumps from one OpenStreetMap request per area and caches the result', async () => {
  const shell = osmNode(10, 234, { amenity: 'fuel', brand: 'Shell' });
  const { positioner, overpassCalls } = createPositionerHarness({ elements: [shell] });
  const stations = [
    { name: 'Shell Petrol Pump, VM Road', brand: 'shell', mapplsPlaceId: 'E4337C', providerDistanceMeters: 240 },
    { name: 'Exact', mapplsPlaceId: 'MAP1', providerDistanceMeters: 100, latitude: 12.97, longitude: 77.59 },
  ];

  // The first answer never waits for OpenStreetMap.
  const first = await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(first.pending, true);
  assert.equal(first.stations[0].latitude, undefined);
  assert.equal(overpassCalls.length, 1);
  // One lookup covers the ~1 km cell around the customer plus the search radius.
  assert.match(decodeURIComponent(overpassCalls[0].body), /"amenity"="fuel"\]\(around:6500,12\.97,77\.59\)/);
  assert.match(overpassCalls[0].options.headers['User-Agent'], /ResQNow/);
  await new Promise((resolve) => setImmediate(resolve));

  const second = await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(second.pending, false);
  assert.deepEqual(second.stations[0], { ...stations[0], latitude: shell.lat, longitude: shell.lon, positionSource: 'osm' });
  assert.equal(second.stations[1], stations[1], 'stations Mappls already placed are left alone');

  await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(overpassCalls.length, 1, 'the area and known positions are served from cache');
});

test('looks chargers up by venue in the background, one at a time, and accepts only a matching distance', async () => {
  const hotel = offset(40);
  const { positioner, searches, timers, runTimers } = createPositionerHarness({
    venues: {
      'JW Marriott Hotel UB City, Bengaluru': [{ lat: hotel.lat, lng: hotel.lng }],
      'Peepal, Bengaluru': [{ ...offset(2_000) }],
    },
  });
  const stations = [
    { name: 'Tata Power EV Charging Station', brand: 'tatapower', mapplsPlaceId: 'VEEQ3T', providerDistanceMeters: 32,
      address: 'JW Marriott Hotel UB City, 24/1, Vittal Mallya Road, Bengaluru, Karnataka, 560001' },
    { name: 'Tata Power EV Charging Station', brand: 'tatapower', mapplsPlaceId: 'X7CIHM', providerDistanceMeters: 62,
      address: 'Peepal, 15/11, KG Halli, Bengaluru, Karnataka, 560001' },
  ];

  const first = await positioner.place({ kind: 'ev', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(first.pending, true);
  assert.equal(first.stations.every((item) => item.latitude === undefined), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(searches.length, 0, 'lookups wait for the queue, not the request');

  await runTimers();
  assert.deepEqual(searches.map((search) => search.query), ['JW Marriott Hotel UB City, Bengaluru', 'Peepal, Bengaluru']);
  assert.equal(searches[0].provider, 'nominatim');
  assert.equal(searches[0].bounded, 1);
  assert.equal(timers.length, 0);

  const second = await positioner.place({ kind: 'ev', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(second.pending, false);
  assert.deepEqual([second.stations[0].latitude, second.stations[0].longitude], [hotel.lat, hotel.lng]);
  assert.equal(second.stations[0].positionSource, 'osm');
  assert.equal(second.stations[1].latitude, undefined, 'a venue 2 km away is not the charger 62 m away');
});

test('tries the next Overpass server when one is busy, and retries soon when all fail', async () => {
  const { positioner, overpassCalls, clock } = createPositionerHarness({ overpassStatus: 504 });
  const stations = [{ name: 'Indian Oil Petrol Pump', brand: 'indianoil', mapplsPlaceId: 'IOC1', providerDistanceMeters: 600 }];
  await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overpassCalls.length, 3, 'every server was tried');
  assert.deepEqual(new Set(overpassCalls.map((call) => call.url)).size, 3);

  const result = await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  assert.equal(result.stations[0].latitude, undefined);
  assert.equal(overpassCalls.length, 3, 'no new attempt straight away');

  clock.now += 11 * 60_000;
  await positioner.place({ kind: 'fuel', center: CENTER, radiusMeters: 5_000, stations });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overpassCalls.length, 6, 'tried again after ten minutes');
});

test('the radar response carries OpenStreetMap pins, their credit and whether more are coming', async () => {
  const shell = osmNode(10, 240, { amenity: 'fuel', brand: 'Shell' });
  const { positioner } = createPositionerHarness({ elements: [shell] });
  const service = createFuelStationService({
    config: { ...getFuelStationConfig({ MAPPLS_REST_API_KEY: 'k' }), detailsLimit: 0 },
    http: {
      get: async () => ({
        status: 200,
        data: {
          suggestedLocations: [
            { eLoc: 'E4337C', placeName: 'Shell Petrol Pump, VM Road', placeAddress: 'Next to UB City, VM Road, Bengaluru', distance: 240, keywords: [PETROL_PUMP_CATEGORY_CODE] },
            { eLoc: 'IOC1', placeName: 'Indian Oil Petrol Pump', placeAddress: 'Trinity Circle, MG Road, Bengaluru, Karnataka, 560001', distance: 900, keywords: [PETROL_PUMP_CATEGORY_CODE] },
          ],
        },
      }),
    },
    positions: positioner,
    warn: () => {},
  });

  const first = await service.findStations({ lat: CENTER.lat, lng: CENTER.lng, radiusMeters: 5_000 });
  assert.equal(first.located, 0);
  assert.equal(first.positionsPending, true);
  await new Promise((resolve) => setImmediate(resolve));

  const result = await service.findStations({ lat: CENTER.lat, lng: CENTER.lng, radiusMeters: 5_000 });
  const shellStation = result.stations.find((item) => item.id === 'E4337C');
  assert.equal(shellStation.positionSource, 'osm');
  assert.equal(shellStation.distance, 240, 'approximate positions keep the Mappls distance');
  assert.equal(result.located, 1);
  assert.equal(result.positionsAttribution, '© OpenStreetMap contributors');
  assert.equal(result.positionsPending, true, 'the Indian Oil pump is being looked up by venue');
});

test('without a positioner the response is unchanged', async () => {
  const service = createEvChargingService({
    config: { ...getEvChargingConfig({ MAPPLS_REST_API_KEY: 'k' }), detailsLimit: 0 },
    http: { get: async () => ({ status: 200, data: { suggestedLocations: [{ eLoc: 'EV1', placeName: 'Charger', distance: 100, keywords: [EV_CATEGORY_CODE] }] } }) },
    warn: () => {},
  });
  const result = await service.findStations({ lat: CENTER.lat, lng: CENTER.lng });
  assert.equal(result.located, 0);
  assert.equal('positionsPending' in result, false);
  assert.equal('positionsAttribution' in result, false);
});
