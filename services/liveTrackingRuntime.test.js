import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTrackingRuntime } from './liveTrackingRuntime.js';

test('requires a backend Redis URL for live tracking runtime state', () => {
  assert.throws(
    () => createLiveTrackingRuntime({ redisUrl: '' }),
    /REDIS_URL is required/,
  );
});

test('creates separate current-state and Socket.IO pub/sub Redis clients', async () => {
  const clients = [];
  const createRedis = () => {
    const client = {
      duplicate: () => createRedis(),
      on: () => client,
      quit: async () => {},
      eval: async () => ['accepted', '{}'],
      get: async () => null,
    };
    clients.push(client);
    return client;
  };

  const runtime = createLiveTrackingRuntime({
    redisUrl: 'redis://tracking-test.invalid:6379',
    createRedis,
    getPool: async () => ({ execute: async () => [[], []] }),
  });

  assert.equal(clients.length, 3);
  assert.equal(typeof runtime.ingestion.ingest, 'function');
  assert.equal(typeof runtime.socketAdapter, 'function');
  await runtime.close();
});
