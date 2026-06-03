import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coercePricingTimestamp } from "../services/pricingTimestamp.js";
import { normalizeRoutePoints } from "../services/routePointNormalizer.js";
import { isTowingServiceType } from "../services/towingServiceType.js";
import {
  mapRequestedTechnicianStatus,
  validateTechnicianStatusTransition,
} from "../services/requestStatusWorkflow.js";

test("towing service detection covers towing aliases", () => {
  assert.equal(isTowingServiceType("towing"), true);
  assert.equal(isTowingServiceType("car-towing"), true);
  assert.equal(isTowingServiceType("puncture"), false);
});

test("towing workflow blocks skipped completion", () => {
  const transition = validateTechnicianStatusTransition({
    currentStatus: "accepted",
    nextStatus: "completed",
    serviceType: "towing",
    paymentStatus: "pending",
  });

  assert.equal(transition.ok, false);
  assert.match(transition.reason, /Invalid towing status transition/);
});

test("towing workflow allows only the next pickup and drop steps", () => {
  assert.equal(
    validateTechnicianStatusTransition({
      currentStatus: "accepted",
      nextStatus: "en_route_pickup",
      serviceType: "towing",
      paymentStatus: "pending",
    }).ok,
    true
  );

  assert.equal(
    validateTechnicianStatusTransition({
      currentStatus: "vehicle_loaded",
      nextStatus: "enroute_drop",
      serviceType: "towing",
      paymentStatus: "pending",
    }).ok,
    true
  );
});

test("towing close requires completed payment", () => {
  assert.equal(
    validateTechnicianStatusTransition({
      currentStatus: "payment_pending",
      nextStatus: "closed",
      serviceType: "towing",
      paymentStatus: "pending",
    }).ok,
    false
  );

  assert.equal(
    validateTechnicianStatusTransition({
      currentStatus: "payment_pending",
      nextStatus: "closed",
      serviceType: "towing",
      paymentStatus: "completed",
    }).ok,
    true
  );
});

test("legacy completed request maps to towing service_completed only after drop arrival", () => {
  assert.equal(
    mapRequestedTechnicianStatus({
      requestedStatus: "completed",
      currentStatus: "arrived_drop",
      serviceType: "towing",
    }),
    "service_completed"
  );
});

test("pricing timestamp coercion never leaves HH:mm-only values", () => {
  const timestamp = coercePricingTimestamp("09:30");
  assert.equal(Number.isNaN(new Date(timestamp).getTime()), false);
  assert.match(timestamp, /T/);
});

test("route point normalization rejects invalid coordinates", () => {
  assert.throws(
    () => normalizeRoutePoints([{ lat: 11, lng: 77 }, { lat: 111, lng: 77 }]),
    /latitude is invalid/
  );
});

test("towing estimate API route is declared and mounted before broad public API alias", async () => {
  const [indexSource, pricingSource] = await Promise.all([
    readFile(new URL("../index.js", import.meta.url), "utf8"),
    readFile(new URL("../routes/pricing.js", import.meta.url), "utf8"),
  ]);

  assert.match(pricingSource, /router\.post\(\s*["']\/towing-estimate["']/);

  const pricingMountIndex = indexSource.indexOf('app.use("/api/pricing", pricingRouter)');
  const publicAliasMountIndex = indexSource.indexOf('app.use("/api", publicRouter)');

  assert.notEqual(pricingMountIndex, -1);
  assert.notEqual(publicAliasMountIndex, -1);
  assert.ok(pricingMountIndex < publicAliasMountIndex);
});
