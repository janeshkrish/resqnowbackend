import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOsrmRoute,
  normalizeRouteVehicleMode,
} from "../services/routeService.js";

test("route vehicle modes normalize to the supported contract", () => {
  assert.equal(normalizeRouteVehicleMode("bike"), "two-wheeler");
  assert.equal(normalizeRouteVehicleMode("commercial"), "commercial-tow");
  assert.equal(normalizeRouteVehicleMode("unknown"), "car");
});

test("route normalization rejects missing road geometry instead of drawing endpoints", () => {
  assert.throws(
    () =>
      normalizeOsrmRoute(
        { distance: 2000, duration: 300 },
        [
          { lat: 12.97, lng: 77.59 },
          { lat: 12.98, lng: 77.6 },
        ],
        "car",
      ),
    /road route/i,
  );
});

test("route normalization returns multi-point geometry and selected vehicle mode", () => {
  const route = normalizeOsrmRoute(
    {
      distance: 2000,
      duration: 300,
      geometry: {
        coordinates: [
          [77.59, 12.97],
          [77.595, 12.975],
          [77.6, 12.98],
        ],
      },
    },
    [],
    "two-wheeler",
  );

  assert.equal(route.vehicleMode, "two-wheeler");
  assert.equal(route.polyline.length, 3);
});
