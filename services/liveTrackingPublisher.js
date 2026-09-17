import { getRoute, normalizeRouteVehicleMode } from './routeService.js';
import { isTowingServiceType } from './towingServiceType.js';
import {
  buildTechnicianLocationPayload,
  resolveLiveTrackingDestination,
} from './liveTrackingRouteMetrics.js';

export function createLiveTrackingPublisher({ store, publishLocation, getRoute: resolveRoute = getRoute } = {}) {
  if (!store || typeof store.claimRouteMetricRefresh !== 'function') {
    throw new TypeError('A live tracking store with route-metric throttling is required.');
  }
  if (typeof publishLocation !== 'function') throw new TypeError('publishLocation must be a function.');
  if (typeof resolveRoute !== 'function') throw new TypeError('getRoute must be a function.');

  return {
    async publishAccepted({ location, request }) {
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
