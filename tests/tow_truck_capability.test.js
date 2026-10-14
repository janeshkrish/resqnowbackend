import assert from "node:assert/strict";
import test from "node:test";
import { jobDispatchService } from "../services/jobDispatchService.js";
import { jobMatcher } from "../services/jobMatcher.js";
import { markTechnicianReserved } from "../services/technicianStateService.js";
import { normalizeServiceCosts } from "../services/serviceNormalization.js";
import { mapStoredPricingRowToTechnicianPricing, normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";
import { replaceTechnicianFleetVehicles, replaceTechnicianPricingRows } from "../services/technicianPricingStore.js";

const request = (type = "flatbed", overrides = {}) => ({
  id: 101, service_type: "car-towing", vehicle_type: "car", tow_truck_type: type,
  location_lat: 11.0168, location_lng: 76.9558, ...overrides,
});

const technician = (fleets = [], overrides = {}) => ({
  id: 7, name: "Towing operator", status: "approved", is_active: 1, is_available: 1,
  current_job_id: null, service_type: "towing", specialties: '["towing"]',
  vehicle_types: '{"car":true,"commercial":true,"bike":true,"ev":true}',
  latitude: 11.0168, longitude: 76.9558, service_area_range: 25,
  fleet_vehicles: fleets.map(type => ({ vehicle_type: type, status: "available" })),
  ...overrides,
});

function evaluate(job, tech) {
  return jobDispatchService.analyzeTechnicians(job, [tech]).analysis[0];
}

for (const required of ["flatbed", "wheel-lift", "heavy-duty-wrecker"]) {
  for (const owned of ["flatbed", "wheel-lift", "heavy-duty-wrecker"]) {
    test(`${required} towing requirement with ${owned} registered equipment`, () => {
      assert.equal(evaluate(request(required), technician([owned])).eligible, required === owned);
    });
  }
}

test("a busy flatbed cannot be replaced by an available wheel-lift", () => {
  const tech = technician([], { fleet_vehicles: [
    { vehicle_type: "flatbed", status: "busy" },
    { vehicle_type: "wheel-lift", status: "available" },
  ] });
  assert.equal(evaluate(request(), tech).eligible, false);
});

test("stale signup truck selections do not override the current fleet", () => {
  const tech = technician(["wheel-lift"], { service_costs: '[{"service_domain":"towing","towing_fleet_types":["flatbed"]}]' });
  assert.equal(evaluate(request(), tech).eligible, false);
});

test("a technician with no recorded truck cannot receive a towing job", () => {
  assert.equal(evaluate(request(), technician()).eligible, false);
});

test("heavy-duty vehicles added through the fleet screen match heavy-duty-wrecker requests", () => {
  assert.equal(evaluate(request("heavy-duty-wrecker"), technician(["heavy-duty"])).eligible, true);
});

test("legacy requests derive the required truck using the existing customer request rules", () => {
  assert.equal(evaluate(request(null), technician(["wheel-lift"])).eligible, false);
  assert.equal(evaluate(request(null), technician(["flatbed"])).eligible, true);
  assert.equal(evaluate(request(null, { vehicle_type: "commercial", service_type: "commercial-towing" }), technician(["flatbed"])).eligible, false);
});

test("an unknown explicit truck requirement cannot be silently substituted", () => {
  assert.equal(evaluate(request("crane"), technician(["flatbed", "wheel-lift", "heavy-duty-wrecker"])).eligible, false);
});

test("non-towing jobs do not require towing equipment", () => {
  const tech = technician([], { service_type: "flat-tire", specialties: '["flat-tire"]' });
  assert.equal(evaluate(request(null, { service_type: "car-flat-tire" }), tech).eligible, true);
});

function reservationDatabase(fleets, job = request()) {
  const tech = technician();
  const conn = {
    query: async (sql, params) => {
      if (/FROM technicians/.test(sql)) return [[{ ...tech }]];
      if (/FROM technician_fleet_vehicles/.test(sql)) return [fleets];
      if (/FROM service_requests/.test(sql)) {
        return [/WHERE id = \?/.test(sql) ? [{ ...job }] : []];
      }
      if (/UPDATE technicians/.test(sql)) {
        tech.current_job_id = Number(params[0]); tech.is_available = 0;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { tech, conn };
}

test("reservation rejects incompatible towing equipment before taking technician capacity", async () => {
  const db = reservationDatabase([{ vehicle_type: "wheel-lift", status: "available" }]);
  await assert.rejects(markTechnicianReserved(db.conn, 7, 101), { code: "tow_truck_mismatch" });
  assert.equal(db.tech.current_job_id, null);
  assert.equal(db.tech.is_available, 1);
});

test("reservation rejects a truck that became offline after the offer", async () => {
  const db = reservationDatabase([{ vehicle_type: "flatbed", status: "offline" }]);
  await assert.rejects(markTechnicianReserved(db.conn, 7, 101), { code: "tow_truck_unavailable" });
  assert.equal(db.tech.current_job_id, null);
});

test("reservation accepts a matching available tow truck", async () => {
  const db = reservationDatabase([{ vehicle_type: "flatbed", status: "available" }]);
  await markTechnicianReserved(db.conn, 7, 101);
  assert.equal(db.tech.current_job_id, 101);
});

test("continuing an already accepted towing job does not require its truck to become available again", async () => {
  const db = reservationDatabase([{ vehicle_type: "flatbed", status: "busy" }], request("flatbed", { technician_id: 7, status: "accepted" }));
  db.tech.current_job_id = 101;
  db.tech.is_available = 0;
  await markTechnicianReserved(db.conn, 7, 101, { alreadyOwned: true });
  assert.equal(db.tech.current_job_id, 101);
});

test("an assigned job still requires suitable available equipment before first acceptance", async () => {
  const db = reservationDatabase([{ vehicle_type: "flatbed", status: "busy" }], request("flatbed", { technician_id: 7, status: "assigned" }));
  db.tech.current_job_id = 101;
  db.tech.is_available = 0;
  await assert.rejects(markTechnicianReserved(db.conn, 7, 101, { alreadyOwned: true }), { code: "tow_truck_unavailable" });
});

test("dispatch filters equipment before comparing arrival times", async () => {
  const rows = [technician([], { id: 7 }), technician([], { id: 9, latitude: 11.02 })];
  const pool = { query: async (sql) => {
    if (/FROM technician_fleet_vehicles/.test(sql)) return [[
      { technician_id: 7, vehicle_type: "wheel-lift", status: "available" },
      { technician_id: 9, vehicle_type: "flatbed", status: "available" },
    ]];
    if (/FROM technicians/.test(sql)) return [rows];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const candidates = await jobDispatchService.findTopTechnicians(request(), 25, {
    pool, routeProvider: async () => ({ durationMinutes: 12, distanceKm: 4 }),
  });
  assert.deepEqual(candidates.map(tech => tech.id), [9]);
});

test("dispatch returns no candidate when all suitable trucks are unavailable", async () => {
  const pool = { query: async (sql) => /FROM technician_fleet_vehicles/.test(sql)
    ? [[{ technician_id: 7, vehicle_type: "flatbed", status: "offline" }]] : [[technician()]] };
  const candidates = await jobDispatchService.findTopTechnicians(request(), 25, {
    pool, routeProvider: async () => { throw new Error("No unsuitable technician should need routing"); },
  });
  assert.deepEqual(candidates, []);
});

test("reassignment selects the nearest compatible truck after excluding the previous technician", async () => {
  const pool = { query: async (sql) => /FROM technician_fleet_vehicles/.test(sql)
    ? [[
      { technician_id: 7, vehicle_type: "flatbed", status: "available" },
      { technician_id: 8, vehicle_type: "wheel-lift", status: "available" },
      { technician_id: 9, vehicle_type: "flatbed", status: "available" },
    ]] : [[technician([], { id: 7 }), technician([], { id: 8 }), technician([], { id: 9, latitude: 11.02 })]] };
  const match = await jobMatcher.findBestMatch(request(), [7], { pool });
  assert.equal(match.id, 9);
});

function registrationStore() {
  const fleet = [];
  const pricing = [];
  const conn = { execute: async (sql, params) => {
    if (/DELETE FROM technician_fleet_vehicles/.test(sql)) { fleet.length = 0; return [{ affectedRows: 1 }]; }
    if (/DELETE FROM technician_services/.test(sql)) { pricing.length = 0; return [{ affectedRows: 1 }]; }
    if (/INSERT INTO technician_fleet_vehicles/.test(sql)) {
      const rows = [];
      for (let index = 0; index < params.length; index += 4) {
        const [technician_id, vehicle_type, vehicle_number, status] = params.slice(index, index + 4);
        if ([...fleet, ...rows].some(row => row.technician_id === technician_id && row.vehicle_number === vehicle_number)) {
          throw Object.assign(new Error("Duplicate technician vehicle number"), { code: "ER_DUP_ENTRY" });
        }
        rows.push({ technician_id, vehicle_type, vehicle_number, status });
      }
      fleet.push(...rows); return [{ affectedRows: rows.length }];
    }
    if (/INSERT INTO technician_services/.test(sql)) {
      for (let index = 0; index < params.length; index += 19) {
        pricing.push({ technician_id: params[index], service_domain: params[index + 1], vehicle_type: params[index + 2], metadata: params[index + 18] });
      }
      return [{ affectedRows: pricing.length }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  return { conn, fleet, pricing };
}

const signup = [{ service_domain: "towing", vehicle_categories: ["car"],
  towing_fleet_types: ["flatbed", "wheel-lift", "heavy-duty-wrecker"],
  towing_vehicle_pricing: { car: { base_charge: 900, extra_km_charge: 30 } },
}];

test("registration stores all three selected tow-truck categories without a duplicate-number failure", async () => {
  const db = registrationStore();
  const profile = JSON.parse(JSON.stringify(normalizeServiceCosts(signup)));
  await replaceTechnicianFleetVehicles(db.conn, 7, profile);
  assert.deepEqual(db.fleet.map(row => row.vehicle_type), ["flatbed", "wheel-lift", "heavy-duty-wrecker"]);
  assert.equal(new Set(db.fleet.map(row => row.vehicle_number)).size, 3);
  assert.equal(db.fleet.every(row => row.status === "available"), true);
});

test("registration's pricing save/read round trip retains the selected truck types", async () => {
  const db = registrationStore();
  await replaceTechnicianPricingRows(db.conn, 7, normalizeTechnicianPricingEntries(signup));
  assert.deepEqual(mapStoredPricingRowToTechnicianPricing(db.pricing[0]).tow_truck_types, ["flatbed", "wheel-lift", "heavy-duty-wrecker"]);
});
