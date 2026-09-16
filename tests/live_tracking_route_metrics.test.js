import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTechnicianLocationPayload,
  resolveLiveTrackingDestination,
  shouldRefreshLiveTrackingRoute,
} from "../services/liveTrackingRouteMetrics.js";
import { SocketService } from "../services/socket.js";

test("routes a normal job to the customer and a loaded tow to the drop", () => {
  assert.deepEqual(
    resolveLiveTrackingDestination({
      service_type: "flat-tire",
      status: "en-route",
      location_lat: 12.97,
      location_lng: 77.59,
    }),
    { lat: 12.97, lng: 77.59 },
  );

  assert.deepEqual(
    resolveLiveTrackingDestination({
      service_type: "towing",
      status: "vehicle_loaded",
      location_lat: 12.97,
      location_lng: 77.59,
      drop_latitude: 12.99,
      drop_longitude: 77.61,
    }),
    { lat: 12.99, lng: 77.61 },
  );
});

test("adds customer ETA fields only when a road route is available", () => {
  const input = {
    technicianId: "tech-1",
    requestId: "request-1",
    latitude: 12.965,
    longitude: 77.585,
  };

  assert.deepEqual(buildTechnicianLocationPayload(input), {
    technicianId: "tech-1",
    requestId: "request-1",
    lat: 12.965,
    lng: 77.585,
  });

  expectPayload(buildTechnicianLocationPayload({
    ...input,
    route: { distanceKm: 2.36, durationMinutes: 8, source: "osrm" },
  }));
});

test("limits route-provider ETA refreshes without delaying GPS delivery", () => {
  assert.equal(shouldRefreshLiveTrackingRoute(undefined, 10_000), true);
  assert.equal(shouldRefreshLiveTrackingRoute(6_000, 10_000), false);
  assert.equal(shouldRefreshLiveTrackingRoute(5_000, 10_000), true);
});

function expectPayload(payload) {
  assert.deepEqual(payload, {
    technicianId: "tech-1",
    requestId: "request-1",
    lat: 12.965,
    lng: 77.585,
    distanceKm: 2.36,
    durationMinutes: 8,
    etaText: "8 min",
    etaSource: "osrm",
  });
}

test("publishes an enriched location only to its technician and request rooms", () => {
  const emitted = [];
  const socketService = new SocketService();
  socketService.io = {
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
    emit(event, payload) {
      emitted.push({ room: "global", event, payload });
    },
  };

  const payload = { technicianId: "tech-1", requestId: "request-1", lat: 12.97, lng: 77.59 };
  socketService.publishTechnicianLocation(payload, "technician:location_update");

  assert.deepEqual(emitted, [
    { room: "technician_tech-1", event: "location_update", payload },
    { room: "global", event: "technician:tech-1:location", payload },
    { room: "request_request-1", event: "technician:location_update", payload },
  ]);
});
