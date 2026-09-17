import {
  TrackingError,
  compareTrackingOrder,
  distanceMeters,
  parseTrackingLocation,
} from './liveTrackingContract.js';
import { liveTrackingKey, TrackingStoreError } from './liveTrackingStore.js';
import { isLiveTrackingDiagnosticsEnabled, logLiveTrackingDiagnostic } from './liveTrackingDiagnostics.js';

const LIVE_TRACKING_STATUSES = new Set([
  'assigned',
  'technician_assigned',
  'accepted',
  'processing',
  'en_route_pickup',
  'arrived_pickup',
  'vehicle_loaded',
  'enroute_drop',
  'arrived_drop',
  'service_started',
  'en-route',
  'on-the-way',
  'arrived',
  'in_progress',
  'in-progress',
]);

const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 60;
const MAX_PREVIOUS_LOCATION_AGE_MS = 30_000;
const DUPLICATE_DISTANCE_METERS = 3;
const DUPLICATE_INTERVAL_MS = 1_000;

function toNowMs(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function isLiveTrackingStatus(status) {
  return LIVE_TRACKING_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

function isSameJob(previous, next) {
  return previous && String(previous.jobId) === String(next.jobId);
}

function locationDecision(previous, next) {
  if (!isSameJob(previous, next)) return null;
  if (compareTrackingOrder(next, previous) <= 0) return 'OUT_OF_ORDER';

  const elapsedMs = next.recordedAtMs - Number(previous.recordedAtMs);
  const travelMeters = distanceMeters(previous, next);
  if (elapsedMs > 0 && elapsedMs < DUPLICATE_INTERVAL_MS && travelMeters <= DUPLICATE_DISTANCE_METERS) {
    return 'DUPLICATE_LOCATION';
  }
  if (elapsedMs <= 0 || elapsedMs > MAX_PREVIOUS_LOCATION_AGE_MS) return null;

  const accuracyAllowance = Math.max(0, Number(previous.accuracy) || 0) +
    Math.max(0, Number(next.accuracy) || 0);
  const allowedMeters = (MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND * (elapsedMs / 1000)) + accuracyAllowance;
  return travelMeters > allowedMeters ? 'IMPLAUSIBLE_MOVEMENT' : null;
}

async function persistSample(pool, location) {
  await pool.execute(
    `UPDATE technicians
     SET latitude = ?, longitude = ?, current_lat = ?, current_lng = ?, last_location_update = ?
     WHERE id = ?`,
    [
      location.lat,
      location.lng,
      location.lat,
      location.lng,
      new Date(location.recordedAtMs),
      location.technicianId,
    ],
  );
  await pool.execute(
    `INSERT INTO technician_location_history
      (technician_id, service_request_id, latitude, longitude, recorded_at, received_at,
       sequence_id, accuracy_m, speed_mps, heading_degrees)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      location.technicianId,
      location.requestId,
      location.lat,
      location.lng,
      new Date(location.recordedAtMs),
      new Date(location.receivedAt),
      location.sequenceId,
      location.accuracy,
      location.speed,
      location.heading,
    ],
  );
}

export function createLiveTrackingIngestion({ getPool, store, now = () => Date.now(), publish = () => {} }) {
  if (typeof getPool !== 'function') throw new TypeError('getPool must be a function.');
  if (!store) throw new TypeError('store is required.');

  return {
    async ingest({ identity, payload, source }) {
      if (String(identity?.role || '').toLowerCase() !== 'technician' || !identity?.id) {
        logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_rejected', { code: 'FORBIDDEN', role: identity?.role || null });
        return { ok: false, code: 'FORBIDDEN' };
      }

      let parsed;
      let nowMs;
      try {
        nowMs = toNowMs(now);
        parsed = parseTrackingLocation(
          { ...payload, technicianId: String(identity.id) },
          nowMs,
        );
      } catch (error) {
        if (error instanceof TrackingError) {
          logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_rejected', { code: error.code, technicianId: String(identity.id) });
          return { ok: false, code: error.code };
        }
        throw error;
      }

      let pool;
      let job;
      try {
        pool = await getPool();
        const [rows] = await pool.execute(
          `SELECT id, technician_id, status, service_type, vehicle_type,
                  location_lat, location_lng, customer_location_lat, customer_location_lng,
                  drop_latitude, drop_longitude
           FROM service_requests
           WHERE id = ? AND technician_id = ?
           LIMIT 1`,
          [parsed.jobId, identity.id],
        );
        job = rows?.[0] || null;
      } catch {
        return { ok: false, code: 'STORE_UNAVAILABLE' };
      }

      if (!job || !isLiveTrackingStatus(job.status)) {
        logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_rejected', {
          code: 'NO_ACTIVE_JOB', technicianId: String(identity.id), jobId: parsed.jobId,
        });
        return { ok: false, code: 'NO_ACTIVE_JOB' };
      }

      let previous;
      try {
        previous = await store.getForTechnician(identity.id);
      } catch (error) {
        if (error instanceof TrackingStoreError) return { ok: false, code: error.code };
        throw error;
      }

      logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_evaluating', {
        requestId: parsed.jobId,
        technicianId: String(identity.id),
        sequenceId: parsed.sequenceId,
        lat: parsed.lat,
        lng: parsed.lng,
        recordedAt: parsed.recordedAt,
        redisKey: liveTrackingKey(identity.id),
        previousLat: previous?.lat ?? null,
        previousLng: previous?.lng ?? null,
        previousSequenceId: previous?.sequenceId ?? null,
        previousRecordedAt: previous?.recordedAt ?? null,
      });

      const decision = locationDecision(previous, parsed);
      if (decision) {
        logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_rejected', {
          code: decision, technicianId: String(identity.id), jobId: parsed.jobId,
          sequenceId: parsed.sequenceId, lat: parsed.lat, lng: parsed.lng,
        });
        return { ok: false, code: decision };
      }

      const receivedAt = new Date(nowMs).toISOString();
      const acceptedLocation = {
        ...parsed,
        technicianId: String(identity.id),
        requestId: String(job.id),
        receivedAt,
        locationUpdatedAt: parsed.recordedAt,
        source: String(source || 'unknown'),
      };

      let writeResult;
      try {
        writeResult = await store.putIfNewer(acceptedLocation);
      } catch (error) {
        if (error instanceof TrackingStoreError) return { ok: false, code: error.code };
        throw error;
      }
      if (!writeResult.accepted) {
        logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_rejected', {
          code: writeResult.code || 'OUT_OF_ORDER', technicianId: String(identity.id), jobId: parsed.jobId,
          sequenceId: parsed.sequenceId, lat: parsed.lat, lng: parsed.lng,
        });
        return { ok: false, code: writeResult.code || 'OUT_OF_ORDER' };
      }

      if (isLiveTrackingDiagnosticsEnabled()) {
        try {
          const [redisLocation, redisTtlSeconds] = await Promise.all([
            store.getForTechnician(identity.id),
            store.getTtlForTechnician?.(identity.id),
          ]);
          logLiveTrackingDiagnostic('[RT-INGEST]', 'ingestion_accepted', {
            technicianId: acceptedLocation.technicianId,
            requestId: acceptedLocation.requestId,
            sequenceId: acceptedLocation.sequenceId,
            lat: acceptedLocation.lat,
            lng: acceptedLocation.lng,
            recordedAt: acceptedLocation.recordedAt,
            redisLat: redisLocation?.lat ?? null,
            redisLng: redisLocation?.lng ?? null,
            redisSequenceId: redisLocation?.sequenceId ?? null,
            redisTtlSeconds: redisTtlSeconds ?? null,
            redisKey: liveTrackingKey(identity.id),
          });
        } catch (error) {
          logLiveTrackingDiagnostic('[RT-INGEST]', 'redis_inspection_failed', { message: error?.message || String(error) });
        }
      }

      try {
        if (await store.claimHistorySample(acceptedLocation)) {
          await persistSample(pool, acceptedLocation);
        }
      } catch (error) {
        console.error('[LiveTracking] sampled persistence failed:', error?.message || error);
      }

      publish(acceptedLocation);
      return { ok: true, location: acceptedLocation, request: job };
    },

    async getRecoverySnapshot({ technicianId, requestId }) {
      try {
        return await store.getForRequest(technicianId, requestId);
      } catch (error) {
        if (error instanceof TrackingStoreError) return null;
        throw error;
      }
    },
  };
}

export {
  DUPLICATE_DISTANCE_METERS,
  DUPLICATE_INTERVAL_MS,
  LIVE_TRACKING_STATUSES,
  MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND,
  isLiveTrackingStatus,
};
