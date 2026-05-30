import axios from "axios";

const DEFAULT_PROVIDER = "nominatim";
const DEFAULT_COUNTRY_CODES = "in";
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 8;
const CACHE_TTL_MS = Math.max(30_000, Number(process.env.LOCATION_CACHE_TTL_MS || 10 * 60 * 1000));
const PROVIDER_TIMEOUT_MS = Math.max(1500, Number(process.env.LOCATION_PROVIDER_TIMEOUT_MS || 6500));
const PROVIDER_RETRY_ATTEMPTS = Math.max(1, Math.min(3, Number(process.env.LOCATION_PROVIDER_RETRY_ATTEMPTS || 2)));
const PROVIDER_RETRY_DELAY_MS = Math.max(100, Number(process.env.LOCATION_PROVIDER_RETRY_DELAY_MS || 250));
const USER_AGENT = String(
  process.env.LOCATION_PROVIDER_USER_AGENT || "ResQNow/1.0 (support@resqnow.com)"
).trim();

class LocationProviderError extends Error {
  constructor(message, statusCode = 502, code = "location_provider_error") {
    super(message);
    this.name = "LocationProviderError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

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
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [entryKey, entry] of cache.entries()) {
      if (entry.expiresAt <= now || cache.size > 1500) cache.delete(entryKey);
    }
  }
  return value;
}

function normalizeProviderName(value) {
  const provider = String(value || process.env.LOCATION_SEARCH_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  if (["nominatim", "photon", "pelias"].includes(provider)) return provider;
  return DEFAULT_PROVIDER;
}

function toFiniteCoordinate(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new LocationProviderError(`${label} is invalid.`, 400, "invalid_coordinate");
  }
  return Number(parsed.toFixed(8));
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function normalizeQuery(value) {
  const query = String(value || "").replace(/\s+/g, " ").trim();
  if (query.length < 2) {
    throw new LocationProviderError("Search query must be at least 2 characters.", 400, "invalid_query");
  }
  if (query.length > 160) {
    throw new LocationProviderError("Search query is too long.", 400, "invalid_query");
  }
  return query;
}

function roundBias(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : null;
}

function buildCacheKey(prefix, payload) {
  return `${prefix}:${JSON.stringify(payload)}`;
}

function parseCoordinatePair(rawLat, rawLng) {
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat: Number(lat.toFixed(8)), lng: Number(lng.toFixed(8)) };
}

function firstPresent(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableProviderError(error) {
  const status = Number(error?.response?.status);
  return !status || status === 429 || status >= 500;
}

async function withProviderRetry(operation, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= PROVIDER_RETRY_ATTEMPTS || !isRetryableProviderError(error)) break;
      await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
    }
  }
  console.warn(`[Location Provider] ${label} failed after retry:`, lastError?.message || lastError);
  throw lastError;
}

function normalizeNominatimResult(entry) {
  const coordinate = parseCoordinatePair(entry?.lat, entry?.lon);
  if (!coordinate) return null;
  const address = entry?.address && typeof entry.address === "object" ? entry.address : {};
  const name = firstPresent(
    entry?.namedetails?.name,
    entry?.name,
    address.amenity,
    address.shop,
    address.mall,
    address.aeroway,
    address.road,
    address.suburb,
    address.city,
    address.town
  );
  const label = firstPresent(entry?.display_name, name);
  if (!label) return null;

  return {
    id: String(entry?.place_id ?? `${coordinate.lat},${coordinate.lng}`),
    label,
    name: name || label.split(",")[0],
    address: label,
    lat: coordinate.lat,
    lng: coordinate.lng,
    category: firstPresent(entry?.class, entry?.type),
    provider: "nominatim",
    importance: Number.isFinite(Number(entry?.importance)) ? Number(entry.importance) : null,
    raw: {
      place_id: entry?.place_id ?? null,
      osm_type: entry?.osm_type ?? null,
      osm_id: entry?.osm_id ?? null,
      type: entry?.type ?? null,
      class: entry?.class ?? null,
      address,
    },
  };
}

function normalizePhotonResult(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const coordinate = parseCoordinatePair(coordinates[1], coordinates[0]);
  if (!coordinate) return null;
  const props = feature?.properties || {};
  const locality = firstPresent(props.city, props.town, props.village, props.district, props.state, props.country);
  const name = firstPresent(props.name, props.street, props.osm_value);
  const label = [name, locality, props.country].filter(Boolean).join(", ");
  if (!label) return null;
  return {
    id: String(props.osm_id ?? props.gid ?? `${coordinate.lat},${coordinate.lng}`),
    label,
    name: name || label.split(",")[0],
    address: label,
    lat: coordinate.lat,
    lng: coordinate.lng,
    category: firstPresent(props.osm_key, props.osm_value),
    provider: "photon",
    importance: null,
    raw: props,
  };
}

function normalizePeliasResult(feature) {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const coordinate = parseCoordinatePair(coordinates[1], coordinates[0]);
  if (!coordinate) return null;
  const props = feature?.properties || {};
  const label = firstPresent(props.label, props.name);
  if (!label) return null;
  return {
    id: String(props.gid ?? `${coordinate.lat},${coordinate.lng}`),
    label,
    name: firstPresent(props.name, label.split(",")[0]),
    address: label,
    lat: coordinate.lat,
    lng: coordinate.lng,
    category: firstPresent(props.layer, props.source),
    provider: "pelias",
    importance: Number.isFinite(Number(props.confidence)) ? Number(props.confidence) : null,
    raw: props,
  };
}

function getCountryCodes() {
  return String(process.env.LOCATION_SEARCH_COUNTRY_CODES || DEFAULT_COUNTRY_CODES).trim();
}

function getViewbox() {
  return String(process.env.LOCATION_SEARCH_VIEWBOX || "").trim();
}

async function searchWithNominatim({ query, limit, lat, lng }) {
  const baseUrl = String(process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
  const viewbox = getViewbox();
  const params = {
    q: query,
    format: "jsonv2",
    addressdetails: 1,
    namedetails: 1,
    dedupe: 1,
    limit,
    countrycodes: getCountryCodes(),
  };
  if (viewbox) {
    params.viewbox = viewbox;
    params.bounded = Number(process.env.LOCATION_SEARCH_BOUNDED || 0) ? 1 : 0;
  }
  if (lat != null && lng != null) {
    params.lat = lat;
    params.lon = lng;
  }

  const response = await withProviderRetry(() => axios.get(`${baseUrl}/search`, {
    timeout: PROVIDER_TIMEOUT_MS,
    params,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  }), "nominatim search");
  return (Array.isArray(response.data) ? response.data : [])
    .map(normalizeNominatimResult)
    .filter(Boolean);
}

async function searchWithPhoton({ query, limit, lat, lng }) {
  const baseUrl = String(process.env.PHOTON_BASE_URL || "https://photon.komoot.io").replace(/\/+$/, "");
  const params = { q: query, limit };
  if (lat != null && lng != null) {
    params.lat = lat;
    params.lon = lng;
  }
  const response = await withProviderRetry(() => axios.get(`${baseUrl}/api`, {
    timeout: PROVIDER_TIMEOUT_MS,
    params,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  }), "photon search");
  return (Array.isArray(response.data?.features) ? response.data.features : [])
    .map(normalizePhotonResult)
    .filter(Boolean);
}

async function searchWithPelias({ query, limit, lat, lng }) {
  const baseUrl = String(process.env.PELIAS_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new LocationProviderError("Pelias provider is not configured.", 503, "provider_not_configured");
  }
  const params = { text: query, size: limit };
  if (lat != null && lng != null) {
    params["focus.point.lat"] = lat;
    params["focus.point.lon"] = lng;
  }
  const response = await withProviderRetry(() => axios.get(`${baseUrl}/v1/search`, {
    timeout: PROVIDER_TIMEOUT_MS,
    params,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  }), "pelias search");
  return (Array.isArray(response.data?.features) ? response.data.features : [])
    .map(normalizePeliasResult)
    .filter(Boolean);
}

export async function searchLocations(input = {}) {
  const query = normalizeQuery(input.query ?? input.q);
  const limit = normalizeLimit(input.limit);
  const provider = normalizeProviderName(input.provider);
  const lat = roundBias(input.lat ?? input.latitude);
  const lng = roundBias(input.lng ?? input.lon ?? input.longitude);
  const cacheKey = buildCacheKey("search", { provider, query: query.toLowerCase(), limit, lat, lng });
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const payload = { query, limit, lat, lng };
    const results =
      provider === "photon"
        ? await searchWithPhoton(payload)
        : provider === "pelias"
          ? await searchWithPelias(payload)
          : await searchWithNominatim(payload);

    return setCached(cacheKey, {
      provider,
      query,
      results: results.slice(0, limit),
      cached: false,
    });
  } catch (error) {
    if (error instanceof LocationProviderError) throw error;
    console.warn("[Location Search] provider failed:", error?.message || error);
    throw new LocationProviderError("Location search provider failed.", 502, "search_failed");
  }
}

export async function reverseGeocode(input = {}) {
  const lat = toFiniteCoordinate(input.lat ?? input.latitude, "Latitude", -90, 90);
  const lng = toFiniteCoordinate(input.lng ?? input.lon ?? input.longitude, "Longitude", -180, 180);
  const provider = normalizeProviderName(input.provider || "nominatim");
  const cacheKey = buildCacheKey("reverse", { provider, lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) });
  const cached = getCached(cacheKey);
  if (cached) return cached;

  if (provider !== "nominatim") {
    throw new LocationProviderError("Reverse geocoding currently requires Nominatim.", 503, "provider_not_supported");
  }

  try {
    const baseUrl = String(process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org").replace(/\/+$/, "");
    const response = await withProviderRetry(() => axios.get(`${baseUrl}/reverse`, {
      timeout: PROVIDER_TIMEOUT_MS,
      params: {
        format: "jsonv2",
        lat,
        lon: lng,
        addressdetails: 1,
      },
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    }), "nominatim reverse");
    const data = response.data || {};
    const normalized = normalizeNominatimResult({ ...data, lat, lon: lng }) || {
      id: `${lat},${lng}`,
      label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      lat,
      lng,
      provider,
    };
    return setCached(cacheKey, {
      ...data,
      display_name: data.display_name || normalized.address,
      lat,
      lon: lng,
      provider,
      normalized,
      cached: false,
    });
  } catch (error) {
    console.warn("[Reverse Geocode] provider failed:", error?.message || error);
    throw new LocationProviderError("Reverse geocoding provider failed.", 502, "reverse_failed");
  }
}

export function normalizeLocationProviderError(error) {
  if (error instanceof LocationProviderError) {
    return {
      statusCode: error.statusCode,
      payload: { error: error.message, code: error.code },
    };
  }
  return {
    statusCode: 500,
    payload: { error: "Location provider failed.", code: "location_failed" },
  };
}
