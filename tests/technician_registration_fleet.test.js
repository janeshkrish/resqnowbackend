import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import * as db from "../db.js";
import techniciansRouter from "../routes/technicians.js";
import adminRouter from "../routes/admin.js";
import { reassignMonitoredRequest } from "../services/operationsCommandCenterService.js";
import { jobDispatchService } from "../services/jobDispatchService.js";
import EmailTemplate from "../models/EmailTemplate.js";

// Replace the database driver before any route opens a pool. No real DB or mail provider is used.
process.env.DB_HOST = "simulated.invalid";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";
process.env.JWT_SECRET = "simulated-jwt-secret";
delete process.env.ADMIN_EMAIL;
let state;
const clone = value => JSON.parse(JSON.stringify(value));
const pricing = [{ service_domain: "towing", vehicle_categories: ["car"],
  towing_fleet_types: ["flatbed", "wheel-lift", "heavy-duty-wrecker"],
  towing_vehicle_pricing: { car: { base_charge: 900, extra_km_charge: 30 } },
}];
const payload = () => ({ name: "Simulated operator", phone: "9876543210", email: "operator@example.invalid",
  password: "simulated-password", specialties: ["towing"], vehicle_types: { car: true },
  service_costs: clone(pricing), pricing_config: clone(pricing),
});

async function query(sql, params = []) {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (/FROM email_templates/.test(sql)) return [[{ enabled: 0, is_enabled: 0 }]];
  if (/FROM technician_fleet_vehicles/.test(sql)) return [clone(state.fleet)];
  if (/FROM dispatch_offers/.test(sql)) return [[]];
  if (/FROM service_requests/.test(sql)) return [state.request ? [clone(state.request)] : []];
  if (/FROM technicians/.test(sql)) {
    if (/WHERE email =/.test(sql)) return [state.technicians.filter(row => row.email === params[0])];
    if (/WHERE id =/.test(sql)) return [state.technicians.filter(row => row.id === Number(params[0]))];
    return [clone(state.technicians)];
  }
  throw new Error(`Unexpected query: ${sql}`);
}

async function execute(sql, params = []) {
  if (/INSERT INTO technicians\s*\(/.test(sql)) {
    const columns = sql.match(/INSERT INTO technicians\s*\(([^)]*)\)/s)[1].split(",").map(column => column.trim());
    state.technicians.push({ id: 7, ...Object.fromEntries(columns.map((column, index) => [column, params[index]])) });
    return [{ insertId: 7 }];
  }
  if (/DELETE FROM technician_fleet_vehicles/.test(sql)) { state.fleet = []; return [{ affectedRows: 1 }]; }
  if (/INSERT INTO technician_fleet_vehicles/.test(sql)) {
    if (state.failFleetInsert) throw new Error("Simulated fleet storage failure");
    for (let index = 0; index < params.length; index += 4) {
      const [technician_id, vehicle_type, vehicle_number, status] = params.slice(index, index + 4);
      if (state.fleet.some(row => row.technician_id === technician_id && row.vehicle_number === vehicle_number)) throw new Error("Duplicate vehicle number");
      state.fleet.push({ id: state.fleet.length + 1, technician_id, vehicle_type, vehicle_number, status });
    }
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE technicians/.test(sql)) {
    const row = state.technicians.find(item => item.id === Number(params.at(-1)));
    const fields = [...sql.matchAll(/([a-z_]+)\s*=\s*\?/g)].map(match => match[1]);
    fields.forEach((field, index) => { row[field] = params[index]; });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE service_requests/.test(sql)) { state.request.technician_id = null; state.request.status = "pending"; return [{ affectedRows: 1 }]; }
  if (/technician_services|technician_service_pricing|dispatch_offers|notifications/.test(sql)) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected execute: ${sql}`);
}

const pool = { query, execute, end: async () => {}, getConnection: async () => {
  let before;
  return { query, execute, beginTransaction: async () => { before = clone(state); },
    commit: async () => { state.commits++; },
    rollback: async () => { state = { ...before, rollbacks: state.rollbacks + 1 }; }, release: () => {},
  };
} };
const driverMock = mock.method(mysql, "createPool", () => pool);
const emailTemplateMock = mock.method(EmailTemplate, "findOne", async () => null);
beforeEach(() => { state = { technicians: [], fleet: [], request: null, commits: 0, rollbacks: 0 }; });
after(async () => { await db.closePool(); driverMock.mock.restore(); emailTemplateMock.mock.restore(); });

function handler(router, path, method) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `Missing route ${method} ${path}`);
  return route.route.stack.at(-1).handle;
}
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

for (const path of ["/register", "/create"]) {
  test(`${path} stores every selected towing truck in the registration transaction`, async () => {
    const res = response();
    await handler(techniciansRouter, path, "post")({ body: payload() }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(state.fleet.map(row => row.vehicle_type), ["flatbed", "wheel-lift", "heavy-duty-wrecker"]);
    assert.equal(state.commits, 1);
    assert.deepEqual(JSON.parse(state.technicians[0].service_costs)[0].towing_fleet_types, ["flatbed", "wheel-lift", "heavy-duty-wrecker"]);
  });
  test(`${path} rolls back the technician when fleet persistence fails`, async () => {
    state.failFleetInsert = true;
    const res = response();
    await handler(techniciansRouter, path, "post")({ body: payload() }, res);
    assert.ok(res.statusCode >= 400);
    assert.equal(state.technicians.length, 0);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
  });
}

test("an admin phone or pricing edit preserves actual fleet records and unavailable status", async () => {
  state.technicians = [{ id: 7, name: "Towing operator", specialties: '["towing"]', service_type: "towing", service_costs: JSON.stringify(pricing) }];
  const fleet = [{ id: 11, technician_id: 7, vehicle_type: "flatbed", vehicle_number: "TN01AB1234", capacity: "3 tonnes", status: "offline" }];
  state.fleet = clone(fleet);
  const res = response();
  await handler(adminRouter, "/update-technician/:id", "put")({ params: { id: "7" }, body: { phone: "9876543211", service_costs: clone(pricing) } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(state.fleet, fleet);
});

const ready = (id, latitude = 11.0168) => ({ id, name: "Operator", status: "approved", is_active: 1, is_available: 1,
  current_job_id: null, service_type: "towing", vehicle_types: '{"car":true}', specialties: '["towing"]',
  latitude, longitude: 76.9558, service_area_range: 25,
});
function matchingScenario() {
  state.request = { id: 101, user_id: 41, service_type: "car-towing", vehicle_type: "car", tow_truck_type: "wheel-lift", technician_id: null,
    location_lat: 11.0168, location_lng: 76.9558, status: "pending" };
  state.technicians = [ready(8), ready(9, 11.02)];
  state.fleet = [
    { technician_id: 8, vehicle_type: "flatbed", status: "available" },
    { technician_id: 9, vehicle_type: "wheel-lift", status: "available" },
  ];
}

test("the per-request admin audit evaluates the actual truck requirement and current equipment", async () => {
  matchingScenario();
  const res = response();
  await handler(adminRouter, "/dispatch-audit/:requestId", "get")({ params: { requestId: "101" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.criteria.requiredTowTruckType, "wheel-lift");
  assert.equal(res.body.summary.eligible_count, 1);
});

test("operations reassignment retains a compatible candidate", async t => {
  matchingScenario();
  t.mock.method(jobDispatchService, "dispatchJob", async () => {});
  const result = await reassignMonitoredRequest({ requestId: 101 });
  assert.equal(result.success, true);
  assert.deepEqual(result.candidates.map(row => row.technicianId), [9]);
});
