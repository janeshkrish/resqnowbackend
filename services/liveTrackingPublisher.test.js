import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTrackingPublisher } from './liveTrackingPublisher.js';

const location = {
  version: 1,
  technicianId: '7',
  requestId: '44',
  jobId: '44',
  lat: 12.9716,
  lng: 77.5946,
  speed: 8,
  heading: 90,
  accuracy: 10,
  recordedAt: '2026-09-17T10:00:00.000Z',
  recordedAtMs: Date.parse('2026-09-17T10:00:00.000Z'),
  sequenceId: 1001,
  receivedAt: '2026-09-17T10:00:00.010Z',
  locationUpdatedAt: '2026-09-17T10:00:00.000Z',
};

const request = {
  id: 44,
  status: 'en-route',
  service_type: 'car_repair',
  vehicle_type: 'car',
  location_lat: 12.9816,
  location_lng: 77.6046,
};

test('publishes location immediately then enriches the same accepted sequence with route metrics', async () => {
  const events = [];
  const publisher = createLiveTrackingPublisher({
    store: { claimRouteMetricRefresh: async () => true },
    publishLocation: (event) => events.push(event),
    getRoute: async () => ({ distanceKm: 4.2, durationMinutes: 9.4, source: 'road_route' }),
  });

  const { routeMetricsPromise } = await publisher.publishAccepted({ location, request });
  await routeMetricsPromise;

  assert.deepEqual(events[0], location);
  assert.deepEqual(events[1], {
    ...location,
    distanceKm: 4.2,
    durationMinutes: 9.4,
    etaText: '10 min',
    etaSource: 'road_route',
  });
});

test('does not request another route while Redis holds the request throttle', async () => {
  const events = [];
  const publisher = createLiveTrackingPublisher({
    store: { claimRouteMetricRefresh: async () => false },
    publishLocation: (event) => events.push(event),
    getRoute: async () => {
      throw new Error('route lookup must not run when throttled');
    },
  });

  const { routeMetricsPromise } = await publisher.publishAccepted({ location, request });
  await routeMetricsPromise;

  assert.deepEqual(events, [location]);
});
