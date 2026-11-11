import { randomUUID } from "node:crypto";
import Redis from "ioredis";

// Expiring leases let a replica disappear without permanently occupying a provider slot.
const ACQUIRE = `
local now = redis.call('TIME')
local ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ms)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ms + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

export function createVoiceCapacity({ name, maxConcurrent, redisUrl, timeoutMs }) {
  let active = 0;
  let redis;
  const key = `resqnow:voice:capacity:${name}`;
  const requestedLimit = Number(maxConcurrent);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 1;
  const busy = () => Object.assign(new Error("Voice provider capacity is temporarily unavailable."), { status: 503 });
  return async function run(work) {
    if (active >= limit) throw busy();
    active++;
    let lease;
    try {
      if (redisUrl) {
        if (!redis) {
          redis = new Redis(redisUrl, { maxRetriesPerRequest: 0, commandTimeout: 1000, connectTimeout: 1500, enableOfflineQueue: false });
          // Individual commands report failures to the caller; speech falls back locally.
          redis.on("error", () => {});
        }
        const token = randomUUID();
        let acquired;
        try { acquired = await redis.eval(ACQUIRE, 1, key, limit, timeoutMs + 5000, token); }
        catch { throw busy(); }
        if (acquired !== 1) throw busy();
        lease = token;
      }
      return await work();
    } finally {
      active--;
      if (lease) void redis.zrem(key, lease).catch(() => {});
    }
  };
}
