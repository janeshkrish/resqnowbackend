import axios from 'axios';
import { distanceMeters } from './liveTrackingContract.js';
import { logLiveTrackingDiagnostic } from './liveTrackingDiagnostics.js';
import { getRoute, normalizeRouteVehicleMode } from './routeService.js';

// Traffic-aware ETA for live tracking, kept apart from the location pipeline.
// One shared ETA per request lives in Redis; it is refreshed on a timer or on
// meaningful movement, never once per GPS fix, and only one provider call per
// request runs at a time. The provider key stays on the backend and is never
// logged or sent to clients.

const DEFAULT_MAPPLS_ROUTE_BASE_URL = 'https://route.mappls.com/route/direction';
const MAPPLS_PROFILES = {
  car: 'driving',
  'two-wheeler': 'biking',
  'commercial-tow': 'trucking',
};

// Statuses in which the technician is travelling to a destination.
const ETA_STATUSES = new Set([
  'assigned',
  'technician_assigned',
  'accepted',
  'processing',
  'en_route',
  'en_route_pickup',
  'on_the_way',
  'vehicle_loaded',
  'enroute_drop',
  'en_route_drop',
]);

const DESTINATION_CHANGE_METERS = 100;
const MOVING_METERS = 50;
const EARLY_REFRESH_METERS = 500;
const EARLY_REFRESH_MIN_AGE_MS = 15_000;
const LOCK_TTL_MS = 20_000;
const PROVIDER_BACKOFF_MS = 5 * 60_000;
const BACKOFF_STATUSES = new Set([401, 403, 429]);
const MAX_LOCAL_ENTRIES = 2_000;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const trafficEtaCacheKey = (requestId) => `eta:v1:request:${String(requestId)}`;
export const trafficEtaLockKey = (requestId) => `eta:v1:lock:${String(requestId)}`;
export const trafficEtaBackoffKey = (provider) => `eta:v1:provider-backoff:${String(provider)}`;

const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function getTrafficEtaConfig(env = process.env) {
  const refreshMs = boundedNumber(env.TRAFFIC_ETA_REFRESH_MS, 45_000, 15_000, 300_000);
  const stationaryRefreshMs = refreshMs * 2;
  return {
    enabled: String(env.TRAFFIC_ETA_ENABLED || '').trim().toLowerCase() === 'true',
    provider: String(env.TRAFFIC_ETA_PROVIDER || 'mappls').trim().toLowerCase() === 'osrm' ? 'osrm' : 'mappls',
    mapplsApiKey: String(env.MAPPLS_REST_API_KEY || '').trim(),
    mapplsBaseUrl: String(env.MAPPLS_ROUTE_BASE_URL || DEFAULT_MAPPLS_ROUTE_BASE_URL).trim().replace(/\/+$/, ''),
    timeoutMs: boundedNumber(env.TRAFFIC_ETA_TIMEOUT_MS, 4_000, 1_000, 10_000),
    refreshMs,
    stationaryRefreshMs,
    // The cache must outlive the slowest refresh so a live request never loses its ETA.
    cacheTtlMs: boundedNumber(env.TRAFFIC_ETA_CACHE_TTL_MS, 180_000, stationaryRefreshMs + 30_000, 900_000),
  };
}

export function isEtaTrackedStatus(status) {
  return ETA_STATUSES.has(String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

export class TrafficEtaProviderError extends Error {
  constructor(provider, { status = null, code = 'provider_error' } = {}) {
    super(`${provider} ETA failed (${status ?? code})`);
    this.name = 'TrafficEtaProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
  }
}

/** Mappls `route_eta`: the default route with live-traffic delays applied (India). */
export function createMapplsEtaProvider({ apiKey, baseUrl = DEFAULT_MAPPLS_ROUTE_BASE_URL, timeoutMs = 4_000, http = axios } = {}) {
  return async function fetchMapplsEta({ origin, destination, vehicleMode }) {
    const profile = MAPPLS_PROFILES[normalizeRouteVehicleMode(vehicleMode)];
    const coordinates = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
    let response;
    try {
      response = await http.get(`${baseUrl}/route_eta/${profile}/${coordinates}`, {
        timeout: timeoutMs,
        params: { access_token: apiKey, steps: false },
        headers: { Accept: 'application/json' },
        // Statuses are handled here so no library error (which carries the
        // request URL and key) ever leaves this function.
        validateStatus: () => true,
      });
    } catch (error) {
      throw new TrafficEtaProviderError('mappls', { code: error?.code === 'ECONNABORTED' ? 'timeout' : 'network' });
    }
    if (response.status !== 200) {
      throw new TrafficEtaProviderError('mappls', { status: response.status, code: 'http_error' });
    }
    const route = response.data?.routes?.[0];
    const duration = Number(route?.duration);
    const distance = Number(route?.distance);
    if (String(response.data?.code || '').toLowerCase() !== 'ok' || !(duration >= 0) || !(distance >= 0)) {
      throw new TrafficEtaProviderError('mappls', { status: 200, code: 'no_route' });
    }
    return { etaSeconds: Math.round(duration), distanceMeters: Math.round(distance), trafficAware: true, provider: 'mappls' };
  };
}

/** OSRM road route: no traffic data, so always reported as not traffic-aware. */
export function createOsrmEtaProvider({ resolveRoute = getRoute } = {}) {
  return async function fetchOsrmEta({ origin, destination, vehicleMode }) {
    let route;
    try {
      route = await resolveRoute({ points: [origin, destination], overview: 'simplified', vehicleMode });
    } catch (error) {
      throw new TrafficEtaProviderError('osrm', { code: error?.code || 'route_failed' });
    }
    const durationMinutes = Number(route?.durationMinutes ?? route?.estimatedDuration);
    const distanceKm = Number(route?.distanceKm ?? route?.distance_km);
    if (!(durationMinutes >= 0) || !(distanceKm >= 0)) {
      throw new TrafficEtaProviderError('osrm', { code: 'no_route' });
    }
    return {
      etaSeconds: Math.round(durationMinutes * 60),
      distanceMeters: Math.round(distanceKm * 1000),
      trafficAware: false,
      provider: 'osrm',
    };
  };
}

function parseCachedEta(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.etaSeconds)) ? parsed : null;
  } catch {
    return null;
  }
}

const pointOf = (lat, lng) => ({ lat: Number(lat), lng: Number(lng) });

/** The fields clients receive; the legacy ones keep older app builds working. */
export function buildEtaLocationFields(eta) {
  if (!eta) return {};
  const minutes = eta.etaSeconds / 60;
  return {
    eta: {
      requestId: String(eta.requestId),
      technicianLat: eta.technicianLat,
      technicianLng: eta.technicianLng,
      destinationLat: eta.destinationLat,
      destinationLng: eta.destinationLng,
      etaSeconds: eta.etaSeconds,
      distanceMeters: eta.distanceMeters,
      trafficAware: eta.trafficAware === true,
      provider: eta.provider,
      calculatedAt: eta.calculatedAt,
    },
    distanceKm: eta.distanceMeters / 1000,
    durationMinutes: minutes,
    etaText: `${Math.max(1, Math.ceil(minutes))} min`,
    etaSource: eta.provider,
    trafficAware: eta.trafficAware === true,
    etaCalculatedAt: eta.calculatedAt,
  };
}

export function createTrafficEtaService({
  redis,
  config = getTrafficEtaConfig(),
  fetchMapplsEta,
  fetchOsrmEta = createOsrmEtaProvider(),
  now = () => Date.now(),
  log = logLiveTrackingDiagnostic,
  warn = console.warn,
} = {}) {
  const mapplsProvider = fetchMapplsEta ?? (config.mapplsApiKey
    ? createMapplsEtaProvider({ apiKey: config.mapplsApiKey, baseUrl: config.mapplsBaseUrl, timeoutMs: config.timeoutMs })
    : null);
  const enabled = Boolean(config.enabled && redis && typeof redis.get === 'function' && typeof redis.set === 'function');
  const local = new Map();
  const inFlight = new Map();
  const settled = new Set();

  if (enabled && config.provider === 'mappls' && !mapplsProvider) {
    warn('[TrafficETA] MAPPLS_REST_API_KEY is not set; live ETAs use OSRM and are not traffic-aware.');
  }

  const remember = (requestId, eta) => {
    local.delete(requestId);
    if (eta) local.set(requestId, eta);
    if (local.size > MAX_LOCAL_ENTRIES) local.delete(local.keys().next().value);
  };

  const ageOf = (eta, nowMs) => nowMs - Date.parse(eta.calculatedAt);

  const matchesDestination = (eta, destination) =>
    distanceMeters(pointOf(eta.destinationLat, eta.destinationLng), destination) <= DESTINATION_CHANGE_METERS;

  const isAttachable = (eta, destination, nowMs) =>
    Boolean(eta) && ageOf(eta, nowMs) <= config.cacheTtlMs && matchesDestination(eta, destination);

  function refreshReason(eta, { origin, destination }, nowMs) {
    if (!eta) return 'missing';
    if (!matchesDestination(eta, destination)) return 'destination_changed';
    const age = ageOf(eta, nowMs);
    const moved = distanceMeters(pointOf(eta.technicianLat, eta.technicianLng), origin);
    if (age >= (moved >= MOVING_METERS ? config.refreshMs : config.stationaryRefreshMs)) return 'interval';
    if (moved >= EARLY_REFRESH_METERS && age >= EARLY_REFRESH_MIN_AGE_MS) return 'moved';
    return null;
  }

  async function isBackedOff(provider) {
    try {
      return Boolean(await redis.get(trafficEtaBackoffKey(provider)));
    } catch {
      return false;
    }
  }

  async function startBackoff(provider, status) {
    warn(`[TrafficETA] ${provider} unavailable (HTTP ${status}); using the fallback for ${PROVIDER_BACKOFF_MS / 60_000} min.`);
    try {
      await redis.set(trafficEtaBackoffKey(provider), String(status), 'PX', PROVIDER_BACKOFF_MS);
    } catch {
      // Best effort: without the marker the next refresh simply tries again.
    }
  }

  /** Normalized ETA between two points, falling back from Mappls to OSRM. */
  async function getTrafficAwareEta({ origin, destination, vehicleMode = 'car', requestId = null }) {
    const useMappls = config.provider === 'mappls' && mapplsProvider && !(await isBackedOff('mappls'));
    if (useMappls) {
      const startedAt = now();
      try {
        const result = await mapplsProvider({ origin, destination, vehicleMode });
        log('[RT-ETA]', 'provider_success', {
          requestId, provider: 'mappls', trafficAware: true, latencyMs: now() - startedAt,
          etaSeconds: result.etaSeconds, distanceMeters: result.distanceMeters,
        });
        return { ...result, calculatedAt: new Date(now()).toISOString() };
      } catch (error) {
        log('[RT-ETA]', 'provider_failed', {
          requestId, provider: 'mappls', status: error?.status ?? null, code: error?.code ?? 'provider_error',
          latencyMs: now() - startedAt,
        });
        if (BACKOFF_STATUSES.has(error?.status)) await startBackoff('mappls', error.status);
      }
    }

    const startedAt = now();
    const result = await fetchOsrmEta({ origin, destination, vehicleMode });
    log('[RT-ETA]', 'provider_success', {
      requestId, provider: 'osrm', trafficAware: false, fallback: config.provider === 'mappls',
      latencyMs: now() - startedAt, etaSeconds: result.etaSeconds, distanceMeters: result.distanceMeters,
    });
    return { ...result, trafficAware: false, provider: 'osrm', calculatedAt: new Date(now()).toISOString() };
  }

  async function readCached(requestId) {
    const eta = parseCachedEta(await redis.get(trafficEtaCacheKey(requestId)));
    remember(requestId, eta);
    return eta;
  }

  async function refresh({ requestId, origin, destination, vehicleMode, reason }) {
    const token = `${now()}:${Math.random().toString(36).slice(2)}`;
    const lockKey = trafficEtaLockKey(requestId);
    if ((await redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') {
      log('[RT-ETA]', 'refresh_skipped_locked', { requestId, reason });
      return null;
    }
    log('[RT-ETA]', 'refresh_started', { requestId, reason });
    let result;
    try {
      result = await getTrafficAwareEta({ origin, destination, vehicleMode, requestId });
    } catch (error) {
      // The lock is left to expire, spacing out retries while providers fail.
      log('[RT-ETA]', 'refresh_failed', { requestId, provider: error?.provider ?? null, code: error?.code ?? null });
      return null;
    }
    const eta = {
      requestId: String(requestId),
      technicianLat: origin.lat,
      technicianLng: origin.lng,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      ...result,
    };
    await redis.set(trafficEtaCacheKey(requestId), JSON.stringify(eta), 'PX', config.cacheTtlMs);
    remember(requestId, eta);
    if (typeof redis.eval === 'function') {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, token).catch(() => {});
    }
    return eta;
  }

  /** This instance's last known ETA, without a Redis round trip. */
  function peek(requestId, destination) {
    const eta = local.get(String(requestId));
    return destination && isAttachable(eta, destination, now()) ? eta : null;
  }

  async function clear(requestId, reason = 'cleared') {
    const id = String(requestId);
    const hadLocal = local.delete(id);
    try {
      const removed = await redis.del(trafficEtaCacheKey(id));
      if (hadLocal || removed) log('[RT-ETA]', 'eta_cleared', { requestId: id, reason });
    } catch {
      // The cache entry expires on its own.
    }
  }

  /**
   * The current ETA for a request, refreshed first when it is due. Concurrent
   * calls for one request share a single refresh. Resolves to { eta, refreshed }.
   */
  async function resolve({ requestId, origin, destination, vehicleMode, status }) {
    const id = String(requestId);
    if (!enabled || !destination) return { eta: null, refreshed: false };
    if (!isEtaTrackedStatus(status)) {
      // Clear once per request on this instance rather than on every fix.
      if (!settled.has(id)) {
        settled.add(id);
        if (settled.size > MAX_LOCAL_ENTRIES) settled.delete(settled.values().next().value);
        await clear(id, 'status');
      }
      return { eta: null, refreshed: false };
    }
    settled.delete(id);

    // Registered before any await so simultaneous fixes share one lookup.
    const shared = inFlight.get(id);
    if (shared) {
      log('[RT-ETA]', 'refresh_coalesced', { requestId: id });
      const { eta } = await shared;
      return { eta: eta && isAttachable(eta, destination, now()) ? eta : null, refreshed: false };
    }
    const pending = lookup({ requestId: id, origin, destination, vehicleMode });
    inFlight.set(id, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(id) === pending) inFlight.delete(id);
    }
  }

  async function lookup({ requestId, origin, destination, vehicleMode }) {
    const cached = await readCached(requestId);
    const nowMs = now();
    const reason = refreshReason(cached, { origin, destination }, nowMs);
    if (!reason) {
      log('[RT-ETA]', 'cache_hit', { requestId, ageMs: ageOf(cached, nowMs), provider: cached.provider });
      return { eta: cached, refreshed: false };
    }
    const fresh = await refresh({ requestId, origin, destination, vehicleMode, reason });
    if (fresh) return { eta: fresh, refreshed: true };
    return { eta: isAttachable(cached, destination, now()) ? cached : null, refreshed: false };
  }

  return { enabled, config, getTrafficAwareEta, peek, resolve, clear };
}
