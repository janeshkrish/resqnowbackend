import { RouteServiceError } from "./routeServiceError.js";

const MAX_POINTS = 5;

function toFiniteCoordinate(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RouteServiceError(`${label} is invalid.`, 400, "invalid_coordinate");
  }
  return Number(parsed.toFixed(8));
}

export function normalizeRoutePoints(points = []) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new RouteServiceError("At least two route points are required.", 400, "invalid_route_points");
  }
  if (points.length > MAX_POINTS) {
    throw new RouteServiceError(`Route supports up to ${MAX_POINTS} points.`, 400, "too_many_route_points");
  }
  return points.map((point, index) => ({
    lat: toFiniteCoordinate(point?.lat ?? point?.latitude, `Point ${index + 1} latitude`, -90, 90),
    lng: toFiniteCoordinate(point?.lng ?? point?.lon ?? point?.longitude, `Point ${index + 1} longitude`, -180, 180),
  }));
}
