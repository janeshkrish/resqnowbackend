import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveTrackingPublisher } from '../services/liveTrackingPublisher.js';
import {
  TrafficEtaProviderError,
  buildEtaLocationFields,
  createMapplsEtaProvider,
  createOsrmEtaProvider,
  createTrafficEtaService,
  getTrafficEtaConfig,
  trafficEtaBackoffKey,
  trafficEtaCacheKey,
  trafficEtaLockKey,
} from '../services/trafficEtaService.js';

const SECRET = 'test-mappls-key-do-not-log';
const START = Date.parse('2026-09-26T10:00:00.000Z');
const ORIGIN = { lat: 11.0168, lng: 76.9558 };
const DESTINATION = { lat: 11.0300, lng: 76.9800 };

function createClock() {
  return { now: START };
}

function createFakeRedis(clock) {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= clock.now) {
      entries.delete(key);
      return null;
    }
    return entry;
  };
  return {
    entries,
    ttlOf: (key) => (live(key)?.expiresAt ?? null) - clock.now,
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ...args) {
      let px = null;
      let nx = false;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === 'PX') px = Number(args[++index]);
        else if (args[index] === 'NX') nx = true;
      }
      if (nx && live(key)) return null;
      entries.set(key, { value: String(value), expiresAt: px == null ? null : clock.now + px });
      return 'OK';
    },
    async del(key) {
      return entries.delete(key) ? 1 : 0;
    },
    async eval(_script, _keys, key, token) {
      if (live(key)?.value !== token) return 0;
      entries.delete(key);
      return 1;
    },
  };
}

function createHarness({ env = {}, mappls, osrm } = {}) {
  const clock = createClock();
  const redis = createFakeRedis(clock);
  const calls = { mappls: 0, osrm: 0 };
  const logs = [];
  const service = createTrafficEtaService({
    redis,
    config: getTrafficEtaConfig({ TRAFFIC_ETA_ENABLED: 'true', MAPPLS_REST_API_KEY: SECRET, ...env }),
    fetchMapplsEta: async (input) => {
      calls.mappls += 1;
      return (mappls ?? (async () => ({ etaSeconds: 900, distanceMeters: 4_200, trafficAware: true, provider: 'mappls' })))(input);
    },
    fetchOsrmEta: async (input) => {
      calls.osrm += 1;
      return (osrm ?? (async () => ({ etaSeconds: 600, distanceMeters: 4_000, trafficAware: false, provider: 'osrm' })))(input);
    },
    now: () => clock.now,
    log: (...entry) => logs.push(entry),
    warn: (...entry) => logs.push(entry),
  });
  return { clock, redis, calls, logs, service };
}

const resolveAt = (service, overrides = {}) => service.resolve({
  requestId: '44',
  origin: ORIGIN,
  destination: DESTINATION,
  vehicleMode: 'car',
  status: 'en-route',
  ...overrides,
});

const moveBy = (point, metersNorth) => ({ lat: point.lat + metersNorth / 111_320, lng: point.lng });

test('config is off by default and bounds the refresh and cache timings', () => {
  const defaults = getTrafficEtaConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.provider, 'mappls');
  assert.equal(defaults.refreshMs, 45_000);
  assert.equal(defaults.stationaryRefreshMs, 90_000);
  assert.equal(defaults.cacheTtlMs, 180_000);
  assert.equal(defaults.mapplsApiKey, '');

  const tuned = getTrafficEtaConfig({ TRAFFIC_ETA_REFRESH_MS: '1000', TRAFFIC_ETA_CACHE_TTL_MS: '5000', TRAFFIC_ETA_PROVIDER: 'OSRM' });
  assert.equal(tuned.refreshMs, 15_000);
  assert.equal(tuned.cacheTtlMs, 60_000, 'cache must outlive the stationary refresh');
  assert.equal(tuned.provider, 'osrm');

  assert.equal(createTrafficEtaService({ redis: createFakeRedis(createClock()), config: defaults }).enabled, false);
});

test('Mappls route_eta is called server-side with the key and mapped vehicle profile', async () => {
  const requests = [];
  const http = {
    get: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, data: { code: 'Ok', routes: [{ distance: 4210.4, duration: 912.6 }] } };
    },
  };
  const fetchEta = createMapplsEtaProvider({ apiKey: SECRET, http, timeoutMs: 4_000 });

  assert.deepEqual(await fetchEta({ origin: ORIGIN, destination: DESTINATION, vehicleMode: 'car' }), {
    etaSeconds: 913,
    distanceMeters: 4210,
    trafficAware: true,
    provider: 'mappls',
  });
  await fetchEta({ origin: ORIGIN, destination: DESTINATION, vehicleMode: 'two-wheeler' });
  await fetchEta({ origin: ORIGIN, destination: DESTINATION, vehicleMode: 'commercial-tow' });

  assert.equal(
    requests[0].url,
    'https://route.mappls.com/route/direction/route_eta/driving/76.9558,11.0168;76.98,11.03',
  );
  assert.equal(requests[0].options.params.access_token, SECRET);
  assert.equal(requests[0].options.timeout, 4_000);
  assert.match(requests[1].url, /\/route_eta\/biking\//);
  assert.match(requests[2].url, /\/route_eta\/trucking\//);
});

test('Mappls failures become provider errors that never carry the key or URL', async () => {
  const cases = [
    [{ get: async () => ({ status: 403, data: {} }) }, { status: 403, code: 'http_error' }],
    [{ get: async () => ({ status: 200, data: { code: 'NoRoute', routes: [] } }) }, { status: 200, code: 'no_route' }],
    [{ get: async () => { throw Object.assign(new Error(`timeout for https://x?access_token=${SECRET}`), { code: 'ECONNABORTED' }); } }, { status: null, code: 'timeout' }],
  ];
  for (const [http, expected] of cases) {
    const fetchEta = createMapplsEtaProvider({ apiKey: SECRET, http });
    await assert.rejects(fetchEta({ origin: ORIGIN, destination: DESTINATION, vehicleMode: 'car' }), (error) => {
      assert.ok(error instanceof TrafficEtaProviderError);
      assert.equal(error.status, expected.status);
      assert.equal(error.code, expected.code);
      assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(SECRET));
      assert.ok(!error.message.includes('route.mappls.com'));
      return true;
    });
  }
});

test('OSRM ETAs are always reported as not traffic-aware', async () => {
  const fetchEta = createOsrmEtaProvider({
    resolveRoute: async () => ({ distanceKm: 4.25, durationMinutes: 11, trafficAware: true, provider: 'osrm' }),
  });
  assert.deepEqual(await fetchEta({ origin: ORIGIN, destination: DESTINATION, vehicleMode: 'car' }), {
    etaSeconds: 660,
    distanceMeters: 4250,
    trafficAware: false,
    provider: 'osrm',
  });
});

test('a valid traffic ETA is cached in Redis with the data contract fields', async () => {
  const { service, redis, calls } = createHarness();

  const { eta, refreshed } = await resolveAt(service);

  assert.equal(refreshed, true);
  assert.equal(calls.mappls, 1);
  assert.deepEqual(eta, {
    requestId: '44',
    technicianLat: ORIGIN.lat,
    technicianLng: ORIGIN.lng,
    destinationLat: DESTINATION.lat,
    destinationLng: DESTINATION.lng,
    etaSeconds: 900,
    distanceMeters: 4_200,
    trafficAware: true,
    provider: 'mappls',
    calculatedAt: new Date(START).toISOString(),
  });
  assert.deepEqual(JSON.parse(await redis.get(trafficEtaCacheKey('44'))), eta);
  assert.equal(redis.ttlOf(trafficEtaCacheKey('44')), 180_000);
  assert.equal(await redis.get(trafficEtaLockKey('44')), null, 'lock released after a successful refresh');
});

test('falls back to OSRM, marked not traffic-aware, when Mappls fails or has no key', async () => {
  const failing = createHarness({ mappls: async () => { throw new TrafficEtaProviderError('mappls', { status: 500, code: 'http_error' }); } });
  const { eta } = await resolveAt(failing.service);
  assert.equal(failing.calls.mappls, 1);
  assert.equal(failing.calls.osrm, 1);
  assert.equal(eta.trafficAware, false);
  assert.equal(eta.provider, 'osrm');

  const clock = createClock();
  const logs = [];
  const unconfigured = createTrafficEtaService({
    redis: createFakeRedis(clock),
    config: getTrafficEtaConfig({ TRAFFIC_ETA_ENABLED: 'true' }),
    fetchOsrmEta: async () => ({ etaSeconds: 600, distanceMeters: 4_000, trafficAware: false, provider: 'osrm' }),
    now: () => clock.now,
    log: () => {},
    warn: (...entry) => logs.push(entry),
  });
  const fallback = await resolveAt(unconfigured);
  assert.equal(fallback.eta.provider, 'osrm');
  assert.equal(fallback.eta.trafficAware, false);
  assert.match(String(logs[0]), /MAPPLS_REST_API_KEY is not set/);
});

test('a rejected or rate-limited Mappls key backs off to OSRM without retrying each refresh', async () => {
  const { service, redis, calls, clock } = createHarness({
    mappls: async () => { throw new TrafficEtaProviderError('mappls', { status: 403, code: 'http_error' }); },
  });

  await resolveAt(service);
  assert.equal(await redis.get(trafficEtaBackoffKey('mappls')), '403');

  clock.now += 45_000;
  await resolveAt(service, { origin: moveBy(ORIGIN, 200) });
  assert.equal(calls.mappls, 1, 'Mappls is not retried during the backoff');
  assert.equal(calls.osrm, 2);
});

test('a cache hit avoids the provider and many GPS fixes do not each refresh', async () => {
  const { service, calls, clock } = createHarness();

  await resolveAt(service);
  for (let fix = 1; fix <= 10; fix += 1) {
    clock.now += 4_000;
    const { refreshed } = await resolveAt(service, { origin: moveBy(ORIGIN, fix * 30) });
    assert.equal(refreshed, false);
  }
  assert.equal(calls.mappls, 1);
});

test('the cache refreshes on its interval, sooner after a big move, and slower when stationary', async () => {
  const moving = createHarness();
  await resolveAt(moving.service);
  moving.clock.now += 44_000;
  assert.equal((await resolveAt(moving.service, { origin: moveBy(ORIGIN, 100) })).refreshed, false);
  moving.clock.now += 1_000;
  assert.equal((await resolveAt(moving.service, { origin: moveBy(ORIGIN, 120) })).refreshed, true);
  assert.equal(moving.calls.mappls, 2);

  const jump = createHarness();
  await resolveAt(jump.service);
  jump.clock.now += 16_000;
  assert.equal((await resolveAt(jump.service, { origin: moveBy(ORIGIN, 600) })).refreshed, true);

  const parked = createHarness();
  await resolveAt(parked.service);
  parked.clock.now += 60_000;
  assert.equal((await resolveAt(parked.service)).refreshed, false);
  parked.clock.now += 30_000;
  assert.equal((await resolveAt(parked.service)).refreshed, true);
});

test('an expired cache entry triggers a fresh provider call', async () => {
  const { service, calls, clock, redis } = createHarness();
  await resolveAt(service);
  clock.now += 180_001;
  assert.equal(await redis.get(trafficEtaCacheKey('44')), null);
  assert.equal(service.peek('44', DESTINATION), null);
  const { refreshed } = await resolveAt(service);
  assert.equal(refreshed, true);
  assert.equal(calls.mappls, 2);
});

test('concurrent refreshes for one request share a single provider call', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, redis, calls, clock } = createHarness({
    mappls: async () => {
      await gate;
      return { etaSeconds: 700, distanceMeters: 3_000, trafficAware: true, provider: 'mappls' };
    },
  });

  const first = resolveAt(service);
  const second = resolveAt(service, { origin: moveBy(ORIGIN, 20) });
  // Another backend instance sharing Redis sees the lock and does not call the provider.
  const otherInstance = createTrafficEtaService({
    redis,
    config: getTrafficEtaConfig({ TRAFFIC_ETA_ENABLED: 'true', MAPPLS_REST_API_KEY: SECRET }),
    fetchMapplsEta: async () => { throw new Error('must not be called while locked'); },
    fetchOsrmEta: async () => { throw new Error('must not be called while locked'); },
    now: () => clock.now,
    log: () => {},
    warn: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await resolveAt(otherInstance), { eta: null, refreshed: false });

  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.mappls, 1);
  assert.equal(a.refreshed, true);
  assert.equal(b.refreshed, false);
  assert.equal(b.eta.etaSeconds, 700);
});

test('a destination change or another request gets its own ETA, never the old one', async () => {
  const { service, calls } = createHarness();
  await resolveAt(service);

  const dropLeg = { lat: 11.1, lng: 77.05 };
  assert.equal(service.peek('44', dropLeg), null);
  const { eta, refreshed } = await resolveAt(service, { destination: dropLeg, status: 'vehicle_loaded' });
  assert.equal(refreshed, true);
  assert.equal(eta.destinationLat, dropLeg.lat);

  assert.equal(service.peek('45', DESTINATION), null);
  const other = await resolveAt(service, { requestId: '45' });
  assert.equal(other.eta.requestId, '45');
  assert.equal(calls.mappls, 3);
});

test('completed, cancelled or arrived requests stop refreshing and drop the cached ETA', async () => {
  for (const status of ['completed', 'cancelled', 'arrived', 'in_progress']) {
    const { service, calls, redis } = createHarness();
    await resolveAt(service);
    const result = await resolveAt(service, { status });
    assert.deepEqual(result, { eta: null, refreshed: false });
    assert.equal(await redis.get(trafficEtaCacheKey('44')), null, status);
    assert.equal(service.peek('44', DESTINATION), null);
    assert.equal(calls.mappls, 1, status);
  }
});

test('ETA logs and warnings never contain the provider key', async () => {
  const { service, logs } = createHarness({
    mappls: async () => { throw new TrafficEtaProviderError('mappls', { status: 401, code: 'http_error' }); },
  });
  await resolveAt(service);
  assert.ok(logs.length > 0);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

const location = {
  version: 1,
  technicianId: '7',
  requestId: '44',
  jobId: '44',
  lat: ORIGIN.lat,
  lng: ORIGIN.lng,
  recordedAt: '2026-09-26T10:00:00.000Z',
  sequenceId: 1001,
  receivedAt: '2026-09-26T10:00:00.010Z',
  locationUpdatedAt: '2026-09-26T10:00:00.000Z',
};
const request = {
  id: 44,
  status: 'en-route',
  service_type: 'car_repair',
  vehicle_type: 'car',
  location_lat: DESTINATION.lat,
  location_lng: DESTINATION.lng,
};

function createFlaggedPublisher(harness) {
  const events = [];
  const publisher = createLiveTrackingPublisher({
    store: {
      claimRouteMetricRefresh: async () => {
        throw new Error('the legacy 5-second route throttle is not used behind the flag');
      },
    },
    publishLocation: (event) => events.push(event),
    getRoute: async () => {
      throw new Error('the legacy route lookup is not used behind the flag');
    },
    trafficEta: harness.service,
  });
  return { events, publisher };
}

test('behind the flag, the fix is published at once and the fresh ETA follows with the latest fix', async () => {
  const harness = createHarness();
  const { events, publisher } = createFlaggedPublisher(harness);

  const { routeMetricsPromise } = await publisher.publishAccepted({ location, request });
  assert.deepEqual(events, [location], 'location goes out before any ETA work');
  await routeMetricsPromise;

  assert.equal(events.length, 2);
  assert.deepEqual(events[1].eta, {
    requestId: '44',
    technicianLat: ORIGIN.lat,
    technicianLng: ORIGIN.lng,
    destinationLat: DESTINATION.lat,
    destinationLng: DESTINATION.lng,
    etaSeconds: 900,
    distanceMeters: 4_200,
    trafficAware: true,
    provider: 'mappls',
    calculatedAt: new Date(START).toISOString(),
  });
  assert.equal(events[1].sequenceId, 1001);
  assert.equal(events[1].durationMinutes, 15);
  assert.equal(events[1].distanceKm, 4.2);
  assert.equal(events[1].etaText, '15 min');

  // Later fixes carry the shared cached ETA immediately and are not re-sent.
  harness.clock.now += 4_000;
  const next = { ...location, lat: moveBy(ORIGIN, 40).lat, sequenceId: 1002 };
  await (await publisher.publishAccepted({ location: next, request })).routeMetricsPromise;
  assert.equal(events.length, 3);
  assert.equal(events[2].sequenceId, 1002);
  assert.equal(events[2].eta.etaSeconds, 900);
  assert.equal(harness.calls.mappls, 1);
});

test('a provider outage never blocks or breaks location publishing', async () => {
  const harness = createHarness({
    mappls: async () => { throw new TrafficEtaProviderError('mappls', { status: 503, code: 'http_error' }); },
    osrm: async () => { throw new TrafficEtaProviderError('osrm', { code: 'route_failed' }); },
  });
  const { events, publisher } = createFlaggedPublisher(harness);

  const { routeMetricsPromise } = await publisher.publishAccepted({ location, request });
  await routeMetricsPromise;
  assert.deepEqual(events, [location]);

  const brokenRedis = { enabled: true, peek: () => null, resolve: async () => { throw new Error('redis down'); } };
  const fallback = createLiveTrackingPublisher({
    store: { claimRouteMetricRefresh: async () => true },
    publishLocation: (event) => events.push(event),
    trafficEta: brokenRedis,
  });
  await (await fallback.publishAccepted({ location, request })).routeMetricsPromise;
  assert.deepEqual(events.at(-1), location);
});

test('with the flag off the existing 5-second route publisher is unchanged', async () => {
  const events = [];
  const publisher = createLiveTrackingPublisher({
    store: { claimRouteMetricRefresh: async () => true },
    publishLocation: (event) => events.push(event),
    getRoute: async () => ({ distanceKm: 4.2, durationMinutes: 9.4, source: 'road_route' }),
    trafficEta: createTrafficEtaService({ redis: createFakeRedis(createClock()), config: getTrafficEtaConfig({}) }),
  });
  await (await publisher.publishAccepted({ location, request })).routeMetricsPromise;
  assert.deepEqual(events[1], { ...location, distanceKm: 4.2, durationMinutes: 9.4, etaText: '10 min', etaSource: 'road_route' });
  assert.equal(events[1].eta, undefined);
});

test('ETA payload fields keep older app builds working', () => {
  assert.deepEqual(buildEtaLocationFields(null), {});
  const fields = buildEtaLocationFields({
    requestId: 44, technicianLat: 1, technicianLng: 2, destinationLat: 3, destinationLng: 4,
    etaSeconds: 61, distanceMeters: 1_500, trafficAware: false, provider: 'osrm', calculatedAt: '2026-09-26T10:00:00.000Z',
  });
  assert.equal(fields.etaText, '2 min');
  assert.equal(fields.etaSource, 'osrm');
  assert.equal(fields.trafficAware, false);
  assert.equal(fields.eta.requestId, '44');
});
