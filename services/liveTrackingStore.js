import { TRACKING_TTL_SECONDS } from './liveTrackingContract.js';

const WRITE_IF_NEWER_SCRIPT = `
local existingJson = redis.call('GET', KEYS[1])
local next = cjson.decode(ARGV[1])

if existingJson then
  local existing = cjson.decode(existingJson)
  if next.sequenceId == existing.sequenceId then
    return { 'duplicate', existingJson }
  end
  if next.recordedAtMs < existing.recordedAtMs or
    (next.recordedAtMs == existing.recordedAtMs and next.sequenceId < existing.sequenceId) then
    return { 'out_of_order', existingJson }
  end
end

redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return { 'accepted', ARGV[1] }
`;

const CLAIM_HISTORY_SAMPLE_SCRIPT = `
-- history-sample
local existingJson = redis.call('GET', KEYS[1])
local next = cjson.decode(ARGV[1])

local function radians(value)
  return value * math.pi / 180
end

local function distanceMeters(left, right)
  local earthRadius = 6371000
  local latDelta = radians(right.lat - left.lat)
  local lngDelta = radians(right.lng - left.lng)
  local x = lngDelta * math.cos(radians((left.lat + right.lat) / 2))
  return earthRadius * math.sqrt(latDelta ^ 2 + x ^ 2)
end

if existingJson then
  local existing = cjson.decode(existingJson)
  local elapsed = next.recordedAtMs - existing.recordedAtMs
  if elapsed < tonumber(ARGV[3]) and distanceMeters(existing, next) < tonumber(ARGV[4]) then
    return { 'not_due' }
  end
end

redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return { 'claimed' }
`;

const HISTORY_SAMPLE_TTL_SECONDS = 6 * 60 * 60;
const HISTORY_SAMPLE_MIN_INTERVAL_MS = 15_000;
const HISTORY_SAMPLE_MIN_DISTANCE_METERS = 50;
const ROUTE_METRIC_REFRESH_INTERVAL_MS = 5_000;

export class TrackingStoreError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'TrackingStoreError';
    this.code = 'STORE_UNAVAILABLE';
  }
}

export function liveTrackingKey(technicianId) {
  return `live-tracking:technician:${String(technicianId)}`;
}

export function liveTrackingHistorySampleKey(technicianId, jobId) {
  return `live-tracking:history-sample:${String(technicianId)}:${String(jobId)}`;
}

export function liveTrackingRouteMetricKey(requestId) {
  return `live-tracking:route-metric:${String(requestId)}`;
}

function parseStoredLocation(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function responseLocation(result) {
  if (!Array.isArray(result)) return null;
  return parseStoredLocation(result[1]);
}

export function createLiveTrackingStore(redis) {
  if (!redis || typeof redis.eval !== 'function' || typeof redis.get !== 'function') {
    throw new TypeError('A Redis client with eval and get methods is required.');
  }

  return {
    async putIfNewer(location) {
      const key = liveTrackingKey(location.technicianId);
      try {
        const result = await redis.eval(
          WRITE_IF_NEWER_SCRIPT,
          1,
          key,
          JSON.stringify(location),
          String(TRACKING_TTL_SECONDS),
        );
        const status = Array.isArray(result) ? String(result[0]) : 'store_error';
        const storedLocation = responseLocation(result);

        if (status === 'accepted') {
          return { accepted: true, code: null, location: storedLocation ?? location };
        }
        if (status === 'duplicate') {
          return { accepted: false, code: 'DUPLICATE_LOCATION', location: storedLocation };
        }
        if (status === 'out_of_order') {
          return { accepted: false, code: 'OUT_OF_ORDER', location: storedLocation };
        }
        throw new Error(`Unexpected Redis write response: ${status}`);
      } catch (error) {
        if (error instanceof TrackingStoreError) throw error;
        throw new TrackingStoreError('Live tracking Redis storage is unavailable.', error);
      }
    },

    async getForTechnician(technicianId) {
      try {
        return parseStoredLocation(await redis.get(liveTrackingKey(technicianId)));
      } catch (error) {
        throw new TrackingStoreError('Live tracking Redis storage is unavailable.', error);
      }
    },

    async getTtlForTechnician(technicianId) {
      if (typeof redis.ttl !== 'function') return null;
      try {
        return await redis.ttl(liveTrackingKey(technicianId));
      } catch (error) {
        throw new TrackingStoreError('Live tracking Redis storage is unavailable.', error);
      }
    },

    async getForRequest(technicianId, requestId) {
      const location = await this.getForTechnician(technicianId);
      if (!location || String(location.jobId) !== String(requestId)) return null;
      return location;
    },

    async claimHistorySample(location) {
      try {
        const result = await redis.eval(
          CLAIM_HISTORY_SAMPLE_SCRIPT,
          1,
          liveTrackingHistorySampleKey(location.technicianId, location.jobId),
          JSON.stringify(location),
          String(HISTORY_SAMPLE_TTL_SECONDS),
          String(HISTORY_SAMPLE_MIN_INTERVAL_MS),
          String(HISTORY_SAMPLE_MIN_DISTANCE_METERS),
        );
        return Array.isArray(result) && String(result[0]) === 'claimed';
      } catch (error) {
        throw new TrackingStoreError('Live tracking Redis storage is unavailable.', error);
      }
    },

    async claimRouteMetricRefresh(requestId) {
      try {
        const result = await redis.set(
          liveTrackingRouteMetricKey(requestId),
          '1',
          'PX',
          ROUTE_METRIC_REFRESH_INTERVAL_MS,
          'NX',
        );
        return result === 'OK';
      } catch (error) {
        throw new TrackingStoreError('Live tracking Redis storage is unavailable.', error);
      }
    },
  };
}

export {
  CLAIM_HISTORY_SAMPLE_SCRIPT,
  HISTORY_SAMPLE_MIN_DISTANCE_METERS,
  HISTORY_SAMPLE_MIN_INTERVAL_MS,
  ROUTE_METRIC_REFRESH_INTERVAL_MS,
  WRITE_IF_NEWER_SCRIPT,
};
