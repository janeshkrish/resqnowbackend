import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { coercePricingTimestamp } from "../services/pricingTimestamp.js";
import { normalizeRoutePoints } from "../services/routePointNormalizer.js";
import { isTowingServiceType } from "../services/towingServiceType.js";
import { buildTowingRouteResponseFields } from "../services/towingRouteResponse.js";
import {
  mapRequestedTechnicianStatus,
  validateTechnicianStatusTransition,
} from "../services/requestStatusWorkflow.js";

test("towing service detection covers towing aliases", () => {
  assert.equal(isTowingServiceType("towing"), true);
  assert.equal(isTowingServiceType("car-towing"), true);
  assert.equal(isTowingServiceType("puncture"), false);
  assert.equal(isTowingServiceType("car-battery"), false);
});

test("payment and technician routes do not infer towing from route data", async () => {
  const [paymentsSource, techniciansSource] = await Promise.all([
    readFile(new URL("../routes/payments.js", import.meta.url), "utf8"),
    readFile(new URL("../routes/technicians.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(paymentsSource, /const hasTowingRouteData/);
  assert.doesNotMatch(techniciansSource, /const hasTowingRouteData/);
  assert.doesNotMatch(
    `${paymentsSource}\n${techniciansSource}`,
    /isTowingServiceType\([^)]*\)\s*\|\|\s*[^;]*(drop_address|route_distance_km)/
  );
});

test("towing route response fields expose an explicit service-type-only flag", () => {
  const routeRow = {
    service_type: "car-battery",
    drop_address: "Workshop drop",
    drop_latitude: 11.01,
    drop_longitude: 76.95,
    route_distance_km: 12.4,
  };

  assert.deepEqual(buildTowingRouteResponseFields(routeRow), { isTowing: false });

  const towingFields = buildTowingRouteResponseFields({
    ...routeRow,
    service_type: "car-towing",
  });

  assert.equal(towingFields.isTowing, true);
  assert.equal(towingFields.drop_address, "Workshop drop");
  assert.equal(towingFields.routeDistanceKm, 12.4);
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
