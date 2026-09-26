import { getRoute, normalizeRouteVehicleMode } from './routeService.js';
import { isTowingServiceType } from './towingServiceType.js';
import {
  buildTechnicianLocationPayload,
  resolveLiveTrackingDestination,
} from './liveTrackingRouteMetrics.js';
import { buildEtaLocationFields, isEtaTrackedStatus } from './trafficEtaService.js';

const MAX_TRACKED_REQUESTS = 2_000;

const rememberBounded = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_REQUESTS) map.delete(map.keys().next().value);
};

export function createLiveTrackingPublisher({
  store,
  publishLocation,
  getRoute: resolveRoute = getRoute,
  trafficEta = null,
} = {}) {
  if (!store || typeof store.claimRouteMetricRefresh !== 'function') {
    throw new TypeError('A live tracking store with route-metric throttling is required.');
  }
  if (typeof publishLocation !== 'function') throw new TypeError('publishLocation must be a function.');
  if (typeof resolveRoute !== 'function') throw new TypeError('getRoute must be a function.');

  // Behind TRAFFIC_ETA_ENABLED: each fix goes out at once with the request's
  // shared cached ETA, and a refreshed ETA is re-sent with the latest fix.
  const latestLocations = new Map();
  const publishedEtaAt = new Map();

  function publishWithTrafficEta({ location, request }) {
    const requestId = String(location.requestId);
    const destination = resolveLiveTrackingDestination(request || {});
    const tracked = Boolean(destination) && isEtaTrackedStatus(request?.status);
    const attached = tracked ? trafficEta.peek(requestId, destination) : null;
    publishLocation(attached ? { ...location, ...buildEtaLocationFields(attached) } : location);

    if (!tracked) {
      latestLocations.delete(requestId);
      publishedEtaAt.delete(requestId);
    } else {
      rememberBounded(latestLocations, requestId, location);
      if (attached) rememberBounded(publishedEtaAt, requestId, attached.calculatedAt);
    }
    if (!destination) return { routeMetricsPromise: Promise.resolve() };

    const vehicleMode = isTowingServiceType(request?.service_type)
      ? 'commercial-tow'
      : normalizeRouteVehicleMode(request?.vehicle_type);
    const routeMetricsPromise = Promise.resolve()
      .then(() => trafficEta.resolve({
        requestId,
        origin: { lat: location.lat, lng: location.lng },
        destination,
        vehicleMode,
        status: request?.status,
      }))
      .then(({ eta } = {}) => {
        if (!eta || publishedEtaAt.get(requestId) === eta.calculatedAt) return;
        const latest = latestLocations.get(requestId) ?? location;
        rememberBounded(publishedEtaAt, requestId, eta.calculatedAt);
        publishLocation({ ...latest, ...buildEtaLocationFields(eta) });
      })
      .catch((error) => {
        console.warn('[LiveTracking] traffic ETA lookup failed:', error?.message || error);
      });
    return { routeMetricsPromise };
  }

  return {
    async publishAccepted({ location, request }) {
      if (trafficEta?.enabled) return publishWithTrafficEta({ location, request });

      publishLocation(location);

      const destination = resolveLiveTrackingDestination(request || {});
      if (!destination) return { routeMetricsPromise: Promise.resolve() };

      let shouldRefresh;
      try {
        shouldRefresh = await store.claimRouteMetricRefresh(location.requestId);
      } catch (error) {
        console.error('[LiveTracking] route metric throttle failed:', error?.message || error);
        return { routeMetricsPromise: Promise.resolve() };
      }
      if (!shouldRefresh) return { routeMetricsPromise: Promise.resolve() };

      const vehicleMode = isTowingServiceType(request?.service_type)
        ? 'commercial-tow'
        : normalizeRouteVehicleMode(request?.vehicle_type);
      const routeMetricsPromise = Promise.resolve(resolveRoute({
        points: [
          { lat: location.lat, lng: location.lng },
          destination,
        ],
        overview: 'simplified',
        vehicleMode,
      })).then((route) => {
        const metrics = buildTechnicianLocationPayload({
          technicianId: location.technicianId,
          requestId: location.requestId,
          latitude: location.lat,
          longitude: location.lng,
          locationUpdatedAt: location.locationUpdatedAt,
          route,
        });
        if (Number.isFinite(Number(metrics.distanceKm)) && Number.isFinite(Number(metrics.durationMinutes))) {
          publishLocation({ ...location, ...metrics });
        }
      }).catch((error) => {
        console.warn('[LiveTracking] route metric lookup failed:', error?.message || error);
      });

      return { routeMetricsPromise };
    },
  };
}
