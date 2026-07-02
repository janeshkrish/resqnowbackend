import { isTowingServiceType } from "./towingServiceType.js";

const safeParseObject = (value) => {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const toPositiveMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const buildDropLocationPayload = (row) => {
  const lat = Number(row?.drop_latitude);
  const lng = Number(row?.drop_longitude);
  if (!row?.drop_address && !Number.isFinite(lat) && !Number.isFinite(lng)) return null;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    address: row?.drop_address || "",
  };
};

export const buildTowingRouteResponseFields = (row) => {
  const isTowing = isTowingServiceType(row?.service_type);
  if (!isTowing) {
    return { isTowing };
  }

  const routeMetadata = safeParseObject(row?.route_metadata_json) || safeParseObject(row?.routeMetadata);
  const pricingBreakdown = safeParseObject(row?.pricing_breakdown_json) || safeParseObject(row?.pricingBreakdown);
  const technicianEarning = toPositiveMoney(
    row?.technician_estimated_earning ?? row?.technicianEstimatedEarning ?? row?.estimatedEarnings
  );

  return {
    isTowing,
    drop_address: row?.drop_address || null,
    dropLocation: buildDropLocationPayload(row),
    pickupPlaceId: routeMetadata?.pickupPlaceId || routeMetadata?.placeIds?.pickup || routeMetadata?.googlePlaceIds?.pickup || null,
    dropPlaceId: routeMetadata?.dropPlaceId || routeMetadata?.placeIds?.drop || routeMetadata?.googlePlaceIds?.drop || null,
    drop_latitude: row?.drop_latitude ?? null,
    drop_longitude: row?.drop_longitude ?? null,
    route_distance_km: row?.route_distance_km ?? null,
    routeDistanceKm: row?.route_distance_km == null ? null : Number(row.route_distance_km),
    estimated_duration: row?.estimated_duration ?? null,
    estimatedDuration: row?.estimated_duration == null ? null : Number(row.estimated_duration),
    route_metadata: routeMetadata,
    routeMetadata,
    routeGeometry: routeMetadata?.geometry || null,
    routePolyline: Array.isArray(routeMetadata?.polyline) ? routeMetadata.polyline : null,
    pricing_breakdown: pricingBreakdown,
    pricingBreakdown,
    estimated_price: row?.estimated_price ?? null,
    final_price: row?.final_price ?? null,
    technician_estimated_earning: technicianEarning,
    technicianEstimatedEarning: technicianEarning,
    estimatedEarnings: technicianEarning,
    vehicle_loaded_time: row?.vehicle_loaded_time ?? null,
    vehicleLoadedTime: row?.vehicle_loaded_time ?? null,
    drop_arrival_time: row?.drop_arrival_time ?? null,
    dropArrivalTime: row?.drop_arrival_time ?? null,
  };
};
