export const TRACKING_EVENT = 'tracking:location:v1';
export const TRACKING_TTL_SECONDS = 30;
export const MAX_LOCATION_AGE_MS = 60_000;
export const MAX_FUTURE_SKEW_MS = 5_000;

export class TrackingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrackingError';
    this.code = code;
  }
}

function requiredIdentifier(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new TrackingError('INVALID_LOCATION', `${fieldName} is required.`);
  }
  return normalized;
}

function finiteNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TrackingError('INVALID_LOCATION', `${fieldName} must be finite.`);
  }
  return parsed;
}

function optionalNumber(value, fieldName, minimum, maximum) {
  if (value == null || value === '') return null;
  const parsed = finiteNumber(value, fieldName);
  if (parsed < minimum || parsed > maximum) {
    throw new TrackingError('INVALID_LOCATION', `${fieldName} is outside its valid range.`);
  }
  return parsed;
}

export function parseTrackingLocation(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object' || Number(payload.version) !== 1) {
    throw new TrackingError('INVALID_LOCATION', 'A version 1 tracking location is required.');
  }

  const lat = finiteNumber(payload.lat, 'lat');
  const lng = finiteNumber(payload.lng, 'lng');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new TrackingError('INVALID_LOCATION', 'Coordinates are outside valid bounds.');
  }

  const recordedAt = String(payload.recordedAt ?? '').trim();
  const recordedAtMs = Date.parse(recordedAt);
  if (!Number.isFinite(recordedAtMs)) {
    throw new TrackingError('INVALID_LOCATION', 'recordedAt must be an ISO timestamp.');
  }
  if (recordedAtMs < nowMs - MAX_LOCATION_AGE_MS) {
    throw new TrackingError('STALE_LOCATION', 'The location is older than sixty seconds.');
  }
  if (recordedAtMs > nowMs + MAX_FUTURE_SKEW_MS) {
    throw new TrackingError('STALE_LOCATION', 'The location timestamp is too far in the future.');
  }

  const sequenceId = Number(payload.sequenceId);
  if (!Number.isSafeInteger(sequenceId) || sequenceId < 1) {
    throw new TrackingError('INVALID_LOCATION', 'sequenceId must be a positive safe integer.');
  }

  return {
    version: 1,
    technicianId: requiredIdentifier(payload.technicianId, 'technicianId'),
    jobId: requiredIdentifier(payload.jobId, 'jobId'),
    lat,
    lng,
    speed: optionalNumber(payload.speed, 'speed', 0, 100),
    heading: optionalNumber(payload.heading, 'heading', 0, 359.999999),
    accuracy: optionalNumber(payload.accuracy, 'accuracy', 0, 500),
    recordedAt,
    recordedAtMs,
    sequenceId,
  };
}

export function compareTrackingOrder(left, right) {
  const leftTime = Number(left?.recordedAtMs);
  const rightTime = Number(right?.recordedAtMs);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;

  const leftSequence = Number(left?.sequenceId);
  const rightSequence = Number(right?.sequenceId);
  if (leftSequence === rightSequence) return 0;
  return leftSequence > rightSequence ? 1 : -1;
}

export function distanceMeters(left, right) {
  const earthRadiusMeters = 6_371_000;
  const latitudeRadians = (degrees) => (degrees * Math.PI) / 180;
  const latDelta = latitudeRadians(Number(right.lat) - Number(left.lat));
  const lngDelta = latitudeRadians(Number(right.lng) - Number(left.lng));
  const a = Math.sin(latDelta / 2) ** 2 +
    Math.cos(latitudeRadians(Number(left.lat))) *
      Math.cos(latitudeRadians(Number(right.lat))) *
      Math.sin(lngDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
