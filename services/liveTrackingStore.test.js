import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTrackingStore } from './liveTrackingStore.js';

function location(overrides = {}) {
  return {
    version: 1,
    technicianId: '7',
    jobId: '44',
    lat: 12.9716,
    lng: 77.5946,
    speed: 7,
    heading: 90,
    accuracy: 10,
    recordedAt: '2026-09-17T10:00:00.000Z',
    recordedAtMs: Date.parse('2026-09-17T10:00:00.000Z'),
    sequenceId: 1001,
    requestId: '44',
    receivedAt: '2026-09-17T10:00:00.100Z',
    locationUpdatedAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

class InMemoryRedisEvalBoundary {
  constructor() {
    this.values = new Map();
  }

  async eval(_script, _keyCount, key, serializedLocation, ttlSeconds) {
    const next = JSON.parse(serializedLocation);
    if (_script.includes('history-sample')) {
      const existing = this.values.get(key)?.value;
      if (existing) {
        const elapsedMs = next.recordedAtMs - existing.recordedAtMs;
        const approximateDistanceMeters = Math.hypot(
          next.lat - existing.lat,
          next.lng - existing.lng,
        ) * 111_000;
        if (elapsedMs < 15_000 && approximateDistanceMeters < 50) return ['not_due'];
      }
      this.values.set(key, { value: next, ttlSeconds: Number(ttlSeconds) });
      return ['claimed'];
    }

    const existing = this.values.get(key)?.value;
    if (existing) {
      const isOlder = next.recordedAtMs < existing.recordedAtMs ||
        (next.recordedAtMs === existing.recordedAtMs && next.sequenceId < existing.sequenceId);
      if (next.sequenceId === existing.sequenceId) return ['duplicate', JSON.stringify(existing)];
      if (isOlder) return ['out_of_order', JSON.stringify(existing)];
    }

    this.values.set(key, { value: next, ttlSeconds: Number(ttlSeconds) });
    return ['accepted', serializedLocation];
  }

  async get(key) {
    const entry = this.values.get(key);
    return entry ? JSON.stringify(entry.value) : null;
  }

  async ttl(key) {
    return this.values.get(key)?.ttlSeconds ?? -2;
  }

  async set(key, value, _expiryMode, ttlMilliseconds, condition) {
    if (condition === 'NX' && this.values.has(key)) return null;
    this.values.set(key, { value, ttlSeconds: Number(ttlMilliseconds) / 1000 });
    return 'OK';
  }
}

test('stores the latest accepted point with a thirty-second TTL', async () => {
  const redis = new InMemoryRedisEvalBoundary();
  const store = createLiveTrackingStore(redis);
  const first = location();
  const next = location({ sequenceId: 1002, recordedAtMs: first.recordedAtMs + 1000, recordedAt: '2026-09-17T10:00:01.000Z' });

  assert.equal((await store.putIfNewer(first)).accepted, true);
  assert.equal((await store.putIfNewer(next)).accepted, true);
  assert.equal(await redis.ttl('live-tracking:technician:7'), 30);
  assert.equal((await store.getForTechnician('7')).sequenceId, 1002);
});

test('does not replace a newer current location with a stale or duplicate point', async () => {
  const redis = new InMemoryRedisEvalBoundary();
  const store = createLiveTrackingStore(redis);
  const current = location({ sequenceId: 1002 });

  await store.putIfNewer(current);

  assert.equal((await store.putIfNewer(location({ sequenceId: 1001 }))).code, 'OUT_OF_ORDER');
  assert.equal((await store.putIfNewer(location({ sequenceId: 1002 }))).code, 'DUPLICATE_LOCATION');
  assert.equal((await store.getForTechnician('7')).sequenceId, 1002);
});

test('returns a current location only to the matching request', async () => {
  const store = createLiveTrackingStore(new InMemoryRedisEvalBoundary());
  await store.putIfNewer(location({ jobId: '44', requestId: '44' }));

  assert.equal((await store.getForRequest('7', '44')).jobId, '44');
  assert.equal(await store.getForRequest('7', '45'), null);
});

test('claims a MySQL history sample only after enough time or travel', async () => {
  const store = createLiveTrackingStore(new InMemoryRedisEvalBoundary());
  const first = location();

  assert.equal(await store.claimHistorySample(first), true);
  assert.equal(await store.claimHistorySample(location({ sequenceId: 1002, recordedAtMs: first.recordedAtMs + 1_000 })), false);
  assert.equal(await store.claimHistorySample(location({ sequenceId: 1003, recordedAtMs: first.recordedAtMs + 16_000 })), true);
});

test('claims one route-metric refresh per request within the throttle interval', async () => {
  const store = createLiveTrackingStore(new InMemoryRedisEvalBoundary());

  assert.equal(await store.claimRouteMetricRefresh('44'), true);
  assert.equal(await store.claimRouteMetricRefresh('44'), false);
});
