import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { getPool as databaseGetPool } from '../db.js';
import { createLiveTrackingIngestion } from './liveTrackingIngestion.js';
import { createLiveTrackingStore } from './liveTrackingStore.js';

function createRedisClient(redisUrl, createRedis) {
  const client = createRedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  client.on?.('error', (error) => {
    console.error('[LiveTracking] Redis client error:', error?.message || error);
  });
  return client;
}

export function createLiveTrackingRuntime({
  redisUrl = process.env.REDIS_URL,
  createRedis = (url, options) => new Redis(url, options),
  getPool = databaseGetPool,
} = {}) {
  const normalizedRedisUrl = String(redisUrl || '').trim();
  if (!normalizedRedisUrl) throw new Error('REDIS_URL is required for live tracking.');

  const stateClient = createRedisClient(normalizedRedisUrl, createRedis);
  const publisherClient = stateClient.duplicate();
  const subscriberClient = stateClient.duplicate();
  const store = createLiveTrackingStore(stateClient);
  const ingestion = createLiveTrackingIngestion({ getPool, store });

  return {
    ingestion,
    store,
    socketAdapter: createAdapter(publisherClient, subscriberClient),
    async close() {
      await Promise.allSettled([
        stateClient.quit?.(),
        publisherClient.quit?.(),
        subscriberClient.quit?.(),
      ]);
    },
  };
}

let runtime = null;

export function getLiveTrackingRuntime() {
  if (!runtime) runtime = createLiveTrackingRuntime();
  return runtime;
}

export async function closeLiveTrackingRuntime() {
  const current = runtime;
  runtime = null;
  if (current) await current.close();
}
