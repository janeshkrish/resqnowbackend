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

    async getForRequest(technicianId, requestId) {
      const location = await this.getForTechnician(technicianId);
      if (!location || String(location.jobId) !== String(requestId)) return null;
      return location;
    },
  };
}

export { WRITE_IF_NEWER_SCRIPT };
