import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import mysql from "mysql2/promise";
import * as db from "../db.js";
import techniciansRouter from "../routes/technicians.js";
import EmailTemplate from "../models/EmailTemplate.js";

// An admin fills in the app's own sign-up form: the technician must be saved exactly as an app sign-up is.
process.env.DB_HOST = "simulated.invalid";
process.env.DB_USER = "simulated";
process.env.DB_PASSWORD = "simulated";
process.env.DB_NAME = "simulated";
process.env.JWT_SECRET = "simulated-jwt-secret";
delete process.env.ADMIN_EMAIL;

let state;
const clone = (value) => JSON.parse(JSON.stringify(value));

async function query(sql, params = []) {
  if (sql === "SELECT 1") return [[{ result: 1 }]];
  if (/FROM email_templates/.test(sql)) return [[{ enabled: 0, is_enabled: 0 }]];
  if (/FROM technician_fleet_vehicles/.test(sql)) return [[]];
  if (/FROM technicians/.test(sql)) {
    if (/WHERE email = \? AND id <> \?/.test(sql)) return [state.technicians.filter((row) => row.email === params[0] && row.id !== Number(params[1]))];
    if (/WHERE email =/.test(sql)) return [state.technicians.filter((row) => row.email === params[0])];
    if (/WHERE id =/.test(sql)) return [clone(state.technicians.filter((row) => row.id === Number(params[0])))];
    return [clone(state.technicians)];
  }
  throw new Error(`Unexpected query: ${sql}`);
}

async function execute(sql, params = []) {
  if (/^\s*SELECT/i.test(sql)) return query(sql, params);
  state.executed.push(sql.replace(/\s+/g, " ").trim());
  if (/INSERT INTO technicians\s*\(/.test(sql)) {
    const columns = sql.match(/INSERT INTO technicians\s*\(([^)]*)\)/s)[1].split(",").map((column) => column.trim());
    const id = 7 + state.technicians.length;
    state.technicians.push({ id, ...Object.fromEntries(columns.map((column, index) => [column, params[index]])) });
    return [{ insertId: id }];
  }
  if (/UPDATE technicians SET status = 'approved'/.test(sql)) {
    const row = state.technicians.find((item) => item.id === Number(params[0]));
    Object.assign(row, { status: "approved", is_active: true, is_available: true });
    return [{ affectedRows: 1 }];
  }
  if (/UPDATE technicians SET/.test(sql)) {
    const row = state.technicians.find((item) => item.id === Number(params.at(-1)));
    const fields = [...sql.matchAll(/([a-z_]+)\s*=\s*\?/g)].map((match) => match[1]);
    fields.forEach((field, index) => { row[field] = params[index]; });
    state.updatedFields = fields;
    return [{ affectedRows: 1 }];
  }
  if (/technician_approval_audit|admin_actions_log|notifications|technician_services|technician_service_pricing|technician_fleet_vehicles/.test(sql)) return [{ affectedRows: 1 }];
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
beforeEach(() => { state = { technicians: [], executed: [], commits: 0, rollbacks: 0, updatedFields: [] }; });
after(async () => { await db.closePool(); driverMock.mock.restore(); emailTemplateMock.mock.restore(); });

function handler(path, method) {
  const route = techniciansRouter.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `Missing route ${method} ${path}`);
  return route.route.stack.at(-1).handle;
}
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

const pricingRow = { service_id: 1, vehicle_category_id: 2, vehicle_subcategory_id: null,
  pricing_json: { service_domain: "flat-tire", vehicle_type: "car", vehicle_subtype: "sedan", vehicle_subtype_label: "Sedan", visit_charge: 200, free_distance: 3, cost_per_km: 15, tube_tyre_price: 250, tubeless_tyre_price: 300 } };
const signup = (extra = {}) => ({
  name: "PV Towing & Tyres", proprietor_name: "Prakash V", phone: "+91 98431 22760", email: "", password: "", confirmPassword: "",
  address: "12/4, Trichy Road", locality: "Singanallur", region: "Coimbatore", district: "Coimbatore", state: "Tamil Nadu",
  latitude: 10.9989, longitude: 77.027, serviceAreaRange: 15, experience: 12,
  specialties: ["flat-tire"], vehicle_types: { car: true }, aadhaar_number: "582166043317",
  working_hours: { is_24x7: false, opening_time: "06:00", closing_time: "23:00", weekly_off: "None" },
  payment_details: { modes: { cash: true }, upi_id: "prakashv@okicici" }, app_readiness: { has_smartphone: false, preferred_language: "Tamil" },
  documents: { garage_front: "/uploads/front.jpg" },
  pricing_config: [{ service_domain: "flat-tire", vehicle_categories: ["car"], flat_tire_vehicle_pricing: { car: { visit_charge: 200 } } }],
  dynamic_pricing_config: [pricingRow], consent: { agreed: true }, technician_agreement_accepted: true,
  ...extra,
});

test("an admin can add a technician without an email, as the app sign-up allows, and the shop's location is saved", async () => {
  const res = response();
  await handler("/create", "post")({ body: signup(), adminEmail: "ops@resqnow.org" }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "pending");
  const saved = state.technicians[0];
  assert.match(saved.email, /^unclaimed-.+@resqnow\.invalid$/);
  assert.equal(saved.password_hash, null);
  assert.equal(saved.latitude, 10.9989);
  assert.equal(saved.longitude, 77.027);
  assert.equal(saved.status, "pending");
  assert.equal(saved.is_active, false);
  assert.equal(saved.proprietor_name, "Prakash V");
  assert.equal(JSON.parse(saved.app_readiness).preferred_language, "Tamil");
  assert.ok(state.executed.some((sql) => /technician_service_pricing/.test(sql)), "the sign-up prices are saved");
  assert.ok(state.executed.some((sql) => /INSERT INTO notifications/.test(sql)), "the application shows in the admin bell");
  assert.equal(state.commits, 1);
});

test("the admin form needs both agreements, like the app", async () => {
  const res = response();
  await handler("/create", "post")({ body: signup({ technician_agreement_accepted: false }) }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /agreements/);
  assert.equal(state.technicians.length, 0);
});

test("with an email the same password rule applies, and a taken email is refused", async () => {
  const noPassword = response();
  await handler("/create", "post")({ body: signup({ email: "pv@example.com" }) }, noPassword);
  assert.equal(noPassword.statusCode, 400);
  state.technicians.push({ id: 3, email: "pv@example.com" });
  const taken = response();
  await handler("/create", "post")({ body: signup({ email: "pv@example.com", password: "long-enough" }) }, taken);
  assert.equal(taken.statusCode, 409);
});

test("Approve now runs the real approval: approved, on duty-ready, audited and announced", async () => {
  const res = response();
  await handler("/create", "post")({ body: signup({ status: "approved" }), adminEmail: "ops@resqnow.org" }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, "approved");
  assert.equal(state.technicians[0].status, "approved");
  assert.equal(state.technicians[0].is_active, true);
  assert.ok(state.executed.some((sql) => /INSERT INTO technician_approval_audit/.test(sql)));
  assert.ok(!state.executed.some((sql) => /New Technician Application/.test(sql)));
});

test("Applications approve uses the same approval", async () => {
  state.technicians.push({ id: 7, name: "MK Tyre Works", email: "mk@example.com", status: "pending" });
  const res = response();
  await handler("/:id/approve", "patch")({ params: { id: "7" }, body: { reason: "Checked" }, adminEmail: "ops@resqnow.org" }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(state.technicians[0].status, "approved");
  const missing = response();
  await handler("/:id/approve", "patch")({ params: { id: "70" }, body: {} }, missing);
  assert.equal(missing.statusCode, 404);
});

test("editing saves every sign-up field and the prices, keeps the password unless a new one is given, and is logged", async () => {
  state.technicians.push({ id: 7, name: "Squad Recovery", email: "selvam@example.com", password_hash: "hash", status: "approved", current_job_id: 5501 });
  const res = response();
  await handler("/:id/profile", "put")({ params: { id: "7" }, body: signup({ name: "Squad Recovery", email: "", latitude: 11.05, longitude: 76.99 }), adminEmail: "ops@resqnow.org" }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = state.technicians[0];
  assert.equal(row.email, "selvam@example.com", "a blank email keeps the current one");
  assert.equal(row.latitude, 11.05);
  assert.equal(row.status, "approved", "status is not touched by an edit");
  assert.equal(row.current_job_id, 5501);
  assert.ok(!state.updatedFields.includes("password_hash"));
  assert.ok(!state.updatedFields.includes("status"));
  assert.ok(state.executed.some((sql) => /technician_service_pricing/.test(sql)));
  assert.ok(state.executed.some((sql) => /updateTechnicianProfile/.test(sql)));

  const withPassword = response();
  await handler("/:id/profile", "put")({ params: { id: "7" }, body: signup({ name: "Squad Recovery", password: "a-new-password" }) }, withPassword);
  assert.equal(withPassword.statusCode, 200);
  assert.ok(state.updatedFields.includes("password_hash"));
  assert.notEqual(state.technicians[0].password_hash, "hash");
});

test("editing refuses an email another technician has, and an unknown technician", async () => {
  state.technicians.push({ id: 7, name: "A", email: "a@example.com", password_hash: "hash" }, { id: 8, name: "B", email: "b@example.com" });
  const taken = response();
  await handler("/:id/profile", "put")({ params: { id: "7" }, body: signup({ name: "A", email: "b@example.com" }) }, taken);
  assert.equal(taken.statusCode, 409);
  const missing = response();
  await handler("/:id/profile", "put")({ params: { id: "99" }, body: signup() }, missing);
  assert.equal(missing.statusCode, 404);
});
