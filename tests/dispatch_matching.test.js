import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runDispatchMatrixAudit } from "../services/dispatchMatrixAudit.js";
import { jobDispatchService } from "../services/jobDispatchService.js";
import {
  hasRegisteredDispatchWorker,
  recoverRecentPendingDispatchJobs,
} from "../services/dispatchQueueService.js";

const location = {
  latitude: 11.0168,
  longitude: 76.9558,
  service_area_range: 25,
};

const readyTechnician = (overrides = {}) => ({
  id: 1,
  name: "Dispatch fixture",
  status: "approved",
  is_active: 1,
  is_available: 1,
  current_job_id: null,
  service_type: "flat-tire",
  specialties: JSON.stringify(["flat-tire"]),
  service_costs: JSON.stringify({}),
  vehicle_types: JSON.stringify({ bike: true, car: true, commercial: true, ev: true }),
  ...location,
  ...overrides,
});

const requestFor = (serviceType, vehicleType = "car") => ({
  id: `request-${serviceType}-${vehicleType}`,
  service_type: serviceType,
  vehicle_type: vehicleType,
  location_lat: location.latitude,
  location_lng: location.longitude,
});

test("a two-domain technician matches both selected domains and no others", () => {
  const technician = readyTechnician({
    service_type: "flat-tire",
    specialties: JSON.stringify(["flat-tire", "winching"]),
  });

  const flatTire = jobDispatchService.analyzeTechnicians(
    requestFor("car-flat-tire"),
    [technician]
  ).analysis[0];
  const winching = jobDispatchService.analyzeTechnicians(
    requestFor("car-winching"),
    [technician]
  ).analysis[0];
  const battery = jobDispatchService.analyzeTechnicians(
    requestFor("car-battery"),
    [technician]
  ).analysis[0];

  assert.equal(flatTire.eligible, true);
  assert.equal(winching.eligible, true);
  assert.equal(battery.eligible, false);
  assert.deepEqual(battery.reasons, ["service_mismatch"]);
});

test("a single-domain technician is not offered another service domain", () => {
  const technician = readyTechnician();

  const matching = jobDispatchService.analyzeTechnicians(
    requestFor("flat-tire"),
    [technician]
  ).analysis[0];
  const nonMatching = jobDispatchService.analyzeTechnicians(
    requestFor("battery"),
    [technician]
  ).analysis[0];

  assert.equal(matching.eligible, true);
  assert.equal(nonMatching.eligible, false);
  assert.deepEqual(nonMatching.reasons, ["service_mismatch"]);
});

test("dispatch matrix covers every canonical combination when profiles do", async () => {
  const domains = [
    "towing",
    "flat-tire",
    "battery",
    "mechanical",
    "fuel",
    "lockout",
    "winching",
    "ev-charging",
  ];
  const technicians = domains.map((domain, index) =>
    readyTechnician({
      id: index + 1,
      service_type: domain,
      specialties: JSON.stringify([domain]),
    })
  );
  const pool = {
    query: async () => [technicians],
  };

  const report = await runDispatchMatrixAudit({ pool, simulateReady: true });

  assert.equal(report.summary.pass_count, 32);
  assert.equal(report.summary.missing_count, 0);
});

test("queue handoff requires a registered dispatch worker", async () => {
  assert.equal(
    await hasRegisteredDispatchWorker({ getWorkersCount: async () => 1 }),
    true
  );
  assert.equal(
    await hasRegisteredDispatchWorker({ getWorkersCount: async () => 0 }),
    false
  );
  assert.equal(await hasRegisteredDispatchWorker(null), false);
});

test("request creation awaits the dispatch handoff before responding", async () => {
  const source = await readFile(
    new URL("../routes/service_requests.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /await \(async \(\) => \{\s+const runDirectFallbackDispatch/);
  assert.doesNotMatch(source, /Trigger Direct Notify or queue-driven dispatch \(async\)/);
});

test("startup recovery requeues only the bounded orphan request set", async () => {
  const enqueued = [];
  const pool = {
    query: async (_sql, params) => {
      assert.deepEqual(params, [15, 25]);
      return [[
        { id: 101, user_id: 201 },
        { id: 102, user_id: 202 },
      ]];
    },
  };
  const enqueue = async (payload) => {
    enqueued.push(payload);
    return payload.jobId === 101
      ? { queued: true, id: "queue-101" }
      : { queued: false, reason: "no_active_dispatch_worker" };
  };

  const result = await recoverRecentPendingDispatchJobs({
    pool,
    enqueue,
    maxAgeMinutes: 15,
    limit: 25,
  });

  assert.deepEqual(result, {
    scanned: 2,
    queued: 1,
    failed: 1,
    maxAgeMinutes: 15,
  });
  assert.deepEqual(enqueued, [
    {
      jobId: 101,
      userId: 201,
      retryCount: 0,
      attemptedTechnicianIds: [],
      source: "startup_recovery",
    },
    {
      jobId: 102,
      userId: 202,
      retryCount: 0,
      attemptedTechnicianIds: [],
      source: "startup_recovery",
    },
  ]);
});
