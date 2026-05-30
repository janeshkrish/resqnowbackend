import axios from "axios";
import { roundMoney } from "../utils/money.js";
import { RouteServiceError } from "./routeServiceError.js";
import { normalizeRoutePoints } from "./routePointNormalizer.js";

const ROUTE_TIMEOUT_MS = Math.max(1500, Number(process.env.ROUTE_PROVIDER_TIMEOUT_MS || process.env.TOWING_ROUTE_TIMEOUT_MS || 6500));
const ROUTE_CACHE_TTL_MS = Math.max(30_000, Number(process.env.ROUTE_CACHE_TTL_MS || 10 * 60 * 1000));
const ROUTE_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.ROUTE_PROVIDER_RETRY_ATTEMPTS || 2)));
const ROUTE_RETRY_DELAY_MS = Math.max(100, Number(process.env.ROUTE_PROVIDER_RETRY_DELAY_MS || 250));
export { normalizeRoutePoints } from "./routePointNormalizer.js";

const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + ROUTE_CACHE_TTL_MS });
  if (cache.size > 1500) {
    const now = Date.now();
    for (const [entryKey, entry] of cache.entries()) {
      if (entry.expiresAt <= now || cache.size > 1100) cache.delete(entryKey);
    }
  }
  return value;
}

function getOsrmBaseUrl() {
  return String(
    process.env.OSRM_ROUTE_URL ||
      process.env.OSRM_URL ||
      "https://router.project-osrm.org/route/v1/driving"
  ).replace(/\/+$/, "");
}

function buildCacheKey(points, overview) {
  const rounded = points.map((point) => [Number(point.lat.toFixed(5)), Number(point.lng.toFixed(5))]);
  return `osrm:${overview}:${JSON.stringify(rounded)}`;
}

function coordinatesToPolyline(coordinates = []) {
  return coordinates
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const lng = Number(entry[0]);
      const lat = Number(entry[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return [lat, lng];
    })
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRouteError(error) {
  const status = Number(error?.response?.status);
  return !status || status === 429 || status >= 500;
}

async function withRouteRetry(operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= ROUTE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= ROUTE_RETRY_ATTEMPTS || !isRetryableRouteError(error)) break;
      await sleep(ROUTE_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function normalizeOsrmRoute(route, points) {
  const distanceMeters = Number(route?.distance || 0);
  const durationSeconds = Number(route?.duration || 0);
  const coordinates = Array.isArray(route?.geometry?.coordinates)
    ? route.geometry.coordinates
    : points.map((point) => [point.lng, point.lat]);
  if (distanceMeters <= 0 || durationSeconds <= 0) {
    throw new RouteServiceError(
      "Unable to calculate a road route for these locations. Please adjust the pickup or drop location.",
      502,
      "route_unavailable"
    );
  }

  const distanceKm = roundMoney(distanceMeters / 1000);
  const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));
  return {
    provider: "osrm",
    source: "osrm",
    distanceKm,
    distance_km: distanceKm,
    durationMinutes,
    estimatedDuration: durationMinutes,
    estimated_duration: durationMinutes,
    geometry: {
      type: "LineString",
      coordinates,
    },
    polyline: coordinatesToPolyline(coordinates),
    trafficAware: false,
    traffic_aware: false,
    tollDetected: false,
    toll_detected: false,
    summary: "OSRM driving route",
    warnings: [],
    calculatedAt: new Date().toISOString(),
  };
}

export async function getRoute(input = {}) {
  const points = normalizeRoutePoints(input.points || []);
  const overview = String(input.overview || "full").trim().toLowerCase() === "simplified" ? "simplified" : "full";
  const cacheKey = buildCacheKey(points, overview);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const coordinateParam = points.map((point) => `${point.lng},${point.lat}`).join(";");
  try {
    const response = await withRouteRetry(() => axios.get(`${getOsrmBaseUrl()}/${coordinateParam}`, {
      timeout: ROUTE_TIMEOUT_MS,
      params: {
        overview,
        alternatives: false,
        steps: false,
        geometries: "geojson",
      },
      headers: { Accept: "application/json" },
    }));
    const route = response.data?.routes?.[0];
    if (!route) {
      throw new RouteServiceError("Route provider did not return a route.", 502, "route_unavailable");
    }
    return setCached(cacheKey, normalizeOsrmRoute(route, points));
  } catch (error) {
    if (error instanceof RouteServiceError) throw error;
    console.warn("[Route Service] OSRM lookup failed:", error?.message || error);
    throw new RouteServiceError("Route provider failed.", 502, "route_failed");
  }
}

export function normalizeRouteServiceError(error) {
  if (error instanceof RouteServiceError) {
    return {
      statusCode: error.statusCode,
      payload: { error: error.message, code: error.code },
    };
  }
  return {
    statusCode: 500,
    payload: { error: "Failed to calculate route.", code: "route_failed" },
  };
}
