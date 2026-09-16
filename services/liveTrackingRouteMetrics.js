import { isTowingServiceType } from "./towingServiceType.js";

const TOWING_DROP_LEG_STATUSES = new Set([
  "vehicle_loaded",
  "enroute_drop",
  "en_route_drop",
  "arrived_drop",
  "service_completed",
  "payment_pending",
  "paid",
  "completed",
  "closed",
]);
const ROUTE_METRIC_REFRESH_INTERVAL_MS = 5_000;

const toFiniteCoordinate = (value, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const toPoint = (lat, lng) => {
  const normalizedLat = toFiniteCoordinate(lat, -90, 90);
  const normalizedLng = toFiniteCoordinate(lng, -180, 180);
  return normalizedLat == null || normalizedLng == null
    ? null
    : { lat: normalizedLat, lng: normalizedLng };
};

const normalizeStatus = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, "_");

export function resolveLiveTrackingDestination(request = {}) {
  const isDropLeg = isTowingServiceType(request.service_type ?? request.serviceType) &&
    TOWING_DROP_LEG_STATUSES.has(normalizeStatus(request.status));

  if (isDropLeg) {
    return toPoint(
      request.drop_latitude ?? request.dropLocation?.lat ?? request.destinationLatitude,
      request.drop_longitude ?? request.dropLocation?.lng ?? request.destinationLongitude,
    );
  }

  return toPoint(
    request.location_lat ?? request.location?.lat ?? request.customer_location_lat,
    request.location_lng ?? request.location?.lng ?? request.customer_location_lng,
  );
}

export function shouldRefreshLiveTrackingRoute(
  lastRequestedAt,
  now = Date.now(),
) {
  const previous = Number(lastRequestedAt);
  return !Number.isFinite(previous) || now - previous >= ROUTE_METRIC_REFRESH_INTERVAL_MS;
}

export function buildTechnicianLocationPayload({
  technicianId,
  requestId,
  latitude,
  longitude,
  locationUpdatedAt,
  route,
} = {}) {
  const payload = {
    technicianId: String(technicianId || ""),
    ...(requestId != null && String(requestId).trim()
      ? { requestId: String(requestId) }
      : {}),
    lat: Number(latitude),
    lng: Number(longitude),
    ...(locationUpdatedAt ? { locationUpdatedAt: String(locationUpdatedAt) } : {}),
  };

  const distanceKm = Number(route?.distanceKm ?? route?.distance_km);
  const durationMinutes = Number(
    route?.durationMinutes ?? route?.estimatedDuration ?? route?.estimated_duration,
  );
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(durationMinutes) || durationMinutes < 0) {
    return payload;
  }

  const roundedMinutes = Math.ceil(durationMinutes);
  return {
    ...payload,
    distanceKm,
    durationMinutes,
    etaText: `${roundedMinutes} min`,
    etaSource: String(route?.source ?? route?.provider ?? "road_route"),
  };
}
