import assert from "node:assert/strict";
import test from "node:test";

import {
  getCustomer,
  getNavCounts,
  getPriceMedians,
  getReports,
  getToday,
  istDayStart,
  listAudit,
  listCustomers,
  listRequests,
  listTechnicians,
  search,
} from "../services/adminPortalService.js";
import { createAdminPortalRouter } from "../routes/adminPortal.js";
import { jobDispatchService } from "../services/jobDispatchService.js";

// 14 Oct 2026, 4:46 PM in India.
const NOW = Date.parse("2026-10-14T11:16:00.000Z");
const DAY_START = istDayStart(NOW);
const at = (ms) => new Date(ms);
const today = (hour, minute = 0) => at(DAY_START + (hour * 60 + minute) * 60_000);

function fakePool(routes) {
  const seen = [];
  const answer = async (sql, params = []) => {
    seen.push({ sql, params });
    for (const [pattern, reply] of routes) {
      if (pattern.test(sql)) return [typeof reply === "function" ? reply(params, sql) : reply, []];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 140)}`);
  };
  return { query: answer, execute: answer, seen };
}

test("the day starts at midnight in India", () => {
  assert.equal(new Date(DAY_START).toISOString(), "2026-10-13T18:30:00.000Z");
});

test("side bar counts come from live jobs, open alerts, applications, payout requests and complaints", async () => {
  const pool = fakePool([
    [/FROM service_requests/, [{ n: 8 }]],
    [/FROM job_monitoring_alerts/, [{ n: 2 }]],
    [/FROM technicians/, [{ n: 4 }]],
    [/FROM withdrawal_requests/, [{ n: 3 }]],
    [/FROM admin_complaints/, [{ n: 5 }]],
  ]);
  assert.deepEqual(await getNavCounts({ pool }), { live: 8, alerts: 2, applications: 4, payouts: 3, complaints: 5 });
});

test("a table the database does not have yet counts as nothing, other errors still fail", async () => {
  const missing = fakePool([[/./, () => { throw new Error("Table 'resq.admin_complaints' doesn't exist"); }]]);
  assert.deepEqual(await getNavCounts({ pool: missing }), { live: 0, alerts: 0, applications: 0, payouts: 0, complaints: 0 });
  const broken = fakePool([[/./, () => { throw new Error("Unknown column 'x'"); }]]);
  await assert.rejects(() => getNavCounts({ pool: broken }), /Unknown column/);
});

test("Today buckets requests by Indian hour, compares with last week and splits the money", async () => {
  const weekAgo = DAY_START - 7 * 86_400_000;
  const pool = fakePool([
    [/FROM service_requests WHERE created_at/, [
      { id: 1, status: "completed", service_type: "car-towing", created_at: today(9, 10), completed_at: today(10) },
      { id: 2, status: "on-the-way", service_type: "flat-tire", created_at: today(16, 30) },
      { id: 3, status: "cancelled", service_type: "battery", created_at: today(16, 40) },
      { id: 4, status: "completed", service_type: "fuel", created_at: at(weekAgo + 9 * 3_600_000), completed_at: at(weekAgo + 10 * 3_600_000) },
      { id: 5, status: "completed", service_type: "fuel", created_at: at(weekAgo + 20 * 3_600_000), completed_at: at(weekAgo + 21 * 3_600_000) },
    ]],
    [/FROM payments WHERE created_at/, [
      { payment_method: "razorpay", status: "completed", amount: 760, technician_amount: 646 },
      { payment_method: "cash", status: "completed", amount: 350, technician_amount: 298 },
      { payment_method: "razorpay", status: "pending", amount: 450, technician_amount: 383 },
    ]],
    [/FROM withdrawal_requests/, [{ amount: 6420, name: "Selvam R" }, { amount: 4180, name: "Vijay P" }]],
    [/FROM technician_dues/, [{ technician_id: 6, amount: 1240 }, { technician_id: 6, amount: 52 }, { technician_id: 5, amount: 480 }]],
    [/FROM technicians WHERE LOWER\(COALESCE\(status, ''\)\) = 'approved'/, [
      { id: 1, name: "Arun", is_active: 1, current_job_id: 5502, current_lat: 11, current_lng: 76.9 },
      { id: 2, name: "Murugan", is_active: 1, current_job_id: null, current_lat: 11.01, current_lng: 76.95 },
      { id: 3, name: "Bala", is_active: 0, current_job_id: null },
    ]],
    [/FROM job_monitoring_alerts/, [{ service_request_id: 5499, reason_code: "movement_stationary", reason_text: "Stationary", risk_level: "red", first_detected_at: today(16, 41), service_type: "flat-tire", customer_name: "Priya M", technician_name: "Ravi N" }]],
    [/status, 'pending'\)\) = 'pending' ORDER BY created_at/, [{ id: 9, name: "MK Tyre Works", created_at: at(NOW - 2 * 86_400_000) }]],
    [/FROM admin_complaints/, [{ id: 1, title: "Asked for extra cash", created_at: at(NOW - 3_600_000) }, { id: 2, title: "Rude", created_at: at(NOW - 26 * 3_600_000) }]],
  ]);
  const result = await getToday({ pool, now: NOW });
  assert.equal(result.requestsToday, 3);
  assert.equal(result.requestsByHour.today[16], 2);
  assert.equal(result.requestsByHour.today[9], 1);
  assert.equal(result.requestsByHour.lastWeek[9], 1);
  assert.equal(result.requestsByHour.currentHour, 16);
  assert.deepEqual(result.completed, { today: 1, sameTimeLastWeek: 1 });
  assert.equal(result.cancelledToday, 1);
  assert.equal(result.money.collected, 1110);
  assert.deepEqual(result.money.online, { amount: 760, count: 1 });
  assert.deepEqual(result.money.cash, { amount: 350, count: 1 });
  assert.equal(result.money.toResqnow, 166);
  assert.deepEqual(result.money.payoutsWaiting, { amount: 10600, count: 2 });
  assert.deepEqual(result.money.cashDues, { amount: 1772, technicians: 2 });
  assert.equal(result.technicians.onDuty, 2);
  assert.equal(result.technicians.onJob, 1);
  assert.deepEqual(result.technicians.freePositions, [{ id: 2, name: "Murugan", position: { lat: 11.01, lng: 76.95 } }]);
  assert.equal(result.needs.alerts[0].requestId, 5499);
  assert.equal(result.needs.applications.oldest.name, "MK Tyre Works");
  assert.deepEqual(result.needs.payouts.names, ["Selvam R", "Vijay P"]);
  assert.equal(result.needs.complaints.olderThanDay, 1);
  assert.deepEqual(result.serviceMix.map((row) => row.service).sort(), ["battery", "flat-tire", "towing"]);
});

test("search looks for a request number, a phone number and a name, and keeps phones masked", async () => {
  const pool = fakePool([
    [/FROM users u WHERE/, [{ id: 41, full_name: "Asha Raman", phone: "+919876543210", requests: 3, subscription: "smart_care" }]],
    [/FROM service_requests sr/, (params) => (params[0] === 5502 ? [{ id: 5502, status: "on-the-way", service_type: "lockout", created_at: today(16, 35), customer_name: "Asha Raman", fare: 110 }] : [])],
    [/FROM technicians/, []],
    [/FROM payments p/, []],
    [/FROM payouts p/, [{ id: 3, technician_name: "Senthil P", amount: 5200, status: "paid", external_reference: "428713390021" }]],
  ]);
  const result = await search({ pool, q: "5502" });
  assert.equal(result.requests[0].id, 5502);
  assert.equal(result.requests[0].phase, "on_the_way");
  assert.equal(result.customers[0].phoneMasked, "+91 98••• ••210");
  assert.equal(result.payments[0].kind, "payout");
  assert.equal((await search({ pool, q: "a" })).requests.length, 0);
});

test("All requests: tab counts, arrival against the promise, work time, margin and priority", async () => {
  const promised = new Date(today(10, 15)).toISOString();
  const pool = fakePool([
    [/FROM service_requests sr/, [
      { id: 5466, status: "completed", service_type: "winching", created_at: today(10, 5), user_id: 7, customer_name: "Ganesh P", technician_id: 1, technician_name: "Selvam R", technician_rating: 4.9,
        fare: 1100, payment_method: "cash", payment_state: "completed", paid_amount: 1100, technician_amount: 935, refunded_amount: 0 },
      { id: 5493, status: "cancelled", service_type: "flat-tire", created_at: today(15, 52), user_id: 8, customer_name: "Sanjay M", fare: null },
      { id: 5502, status: "on-the-way", service_type: "lockout", created_at: today(16, 35), user_id: 41, customer_name: "Asha", payment_method: null, payment_state: null },
      { id: 5442, status: "completed", service_type: "battery", created_at: today(9), user_id: 9, fare: 450, payment_method: "razorpay", payment_state: "completed", paid_amount: 450, technician_amount: 383, refunded_amount: 450 },
    ]],
    [/FROM admin_actions_log/, [{ id: 5466 }]],
    [/FROM request_timeline/, [
      { request_id: 5466, event_type: "accepted", metadata: JSON.stringify({ promisedAt: promised }), created_at: today(10, 5) },
      { request_id: 5466, event_type: "arrived", created_at: today(10, 22) },
      { request_id: 5466, event_type: "work_started", created_at: today(10, 24) },
      { request_id: 5466, event_type: "work_done", created_at: today(11, 8) },
    ]],
  ]);
  const result = await listRequests({ pool, query: { days: 7 }, now: NOW });
  assert.deepEqual(result.counts, { all: 4, live: 1, completed: 2, cancelled: 1, payment_due: 0, refunded: 1 });
  const winching = result.rows.find((row) => row.id === 5466);
  assert.equal(winching.lateMinutes, 7);
  assert.equal(winching.workMinutes, 44);
  assert.equal(winching.margin, 165);
  assert.equal(winching.priority, "high");
  assert.equal(winching.payment.method, "cash");
  const cash = await listRequests({ pool, query: { payment: "cash" }, now: NOW });
  assert.deepEqual(cash.rows.map((row) => row.id), [5466]);
  const high = await listRequests({ pool, query: { priority: "high", tab: "completed" }, now: NOW });
  assert.equal(high.total, 1);
});

test("Technicians: right now, on-time, accepts, hours today, dues, hidden and who needs a look", async () => {
  const promised = new Date(today(9, 30)).toISOString();
  const pool = fakePool([
    [/FROM technicians t LEFT JOIN service_requests/, [
      { id: 1, name: "Selvam R", phone: "+919400000507", status: "approved", is_active: 1, current_job_id: 5501, job_status: "enroute_drop", specialties: '["towing","winching"]', vehicle_types: '{"car":true,"bike":true}', rating: 4.9, admin_hidden: 0 },
      { id: 2, name: "Ravi N", status: "approved", is_active: 1, current_job_id: 5499, job_status: "on-the-way", specialties: '["flat-tire"]', admin_hidden: 0 },
      { id: 3, name: "Bala S", status: "approved", is_active: 0, current_job_id: null, last_seen_at: at(NOW - 20 * 60_000), specialties: '["fuel"]', admin_hidden: 1 },
    ]],
    [/FROM service_requests WHERE technician_id IS NOT NULL/, [{ technician_id: 1, id: 10, status: "completed" }, { technician_id: 1, id: 11, status: "completed" }]],
    [/FROM dispatch_offers/, [
      ...Array.from({ length: 6 }, () => ({ technician_id: 2, status: "expired" })), { technician_id: 2, status: "accepted" },
      { technician_id: 1, status: "accepted" }, { technician_id: 1, status: "declined" },
    ]],
    [/FROM reviews/, [{ technician_id: 1, rating: 4.86, n: 164 }]],
    [/FROM technician_login_sessions/, [{ technician_id: 1, login_at: today(10, 2), logout_at: null }]],
    [/FROM technician_dues/, [{ technician_id: 2, amount: 1240 }]],
    [/FROM job_monitoring_alerts/, [{ technician_id: 2, reason_code: "movement_stationary", reason_text: "Stationary" }]],
    [/FROM account_notes/, []],
    [/FROM request_timeline/, [
      { request_id: 10, event_type: "accepted", metadata: JSON.stringify({ promisedAt: promised }) }, { request_id: 10, event_type: "arrived", created_at: today(9, 28) },
      { request_id: 11, event_type: "accepted", metadata: JSON.stringify({ promisedAt: promised }) }, { request_id: 11, event_type: "arrived", created_at: today(9, 40) },
    ]],
  ]);
  const result = await listTechnicians({ pool, query: {}, now: NOW });
  assert.deepEqual(result.counts, { all: 3, on_duty: 2, on_job: 2, offline: 1, hidden: 1, needs_look: 2 });
  assert.equal(result.rows.find((row) => row.id === 1).needsLook, true);
  const selvam = result.rows.find((row) => row.id === 1);
  assert.equal(selvam.now.state, "on_job");
  assert.equal(selvam.jobs30, 2);
  assert.equal(selvam.onTimeRate, 0.5);
  assert.equal(selvam.acceptRate, 0.5);
  assert.equal(selvam.rating, 4.86);
  assert.equal(selvam.onDutyTodayMinutes, 404);
  assert.deepEqual(selvam.vehicles.sort(), ["bike", "car"]);
  const ravi = result.rows.find((row) => row.id === 2);
  assert.equal(ravi.now.alert.code, "movement_stationary");
  assert.equal(ravi.needsLook, true);
  assert.equal(ravi.dues, 1240);
  const bala = result.rows.find((row) => row.id === 3);
  assert.equal(bala.hidden, true);
  assert.equal(bala.now.state, "offline");
  assert.deepEqual((await listTechnicians({ pool, query: { tab: "hidden" }, now: NOW })).rows.map((row) => row.id), [3]);
});

test("Customers: plan, live request, spend and tabs; one customer's totals and how they sign in", async () => {
  const pool = fakePool([
    [/FROM users WHERE LOWER/, [
      { id: 41, full_name: "Asha Raman", phone: "+919876543210", created_at: at(NOW - 100 * 86_400_000), subscription: "smart_care" },
      { id: 42, full_name: "Priya M", created_at: at(NOW - 3_600_000), subscription: "free" },
    ]],
    [/GROUP BY sr.user_id/, [{ user_id: 41, requests: 3, spent: 1010, cancelled: 0, last_at: at(NOW - 3_600_000) }]],
    [/SELECT user_id, id FROM service_requests/, [{ user_id: 41, id: 5502 }]],
    [/FROM user_vehicles/, [{ user_id: 41, type: "truck" }, { user_id: 41, type: "car" }]],
  ]);
  const list = await listCustomers({ pool, query: {}, now: NOW });
  assert.deepEqual(list.counts, { all: 2, active: 1, members: 1, live: 1 });
  assert.equal(list.joinedThisMonth, 1);
  const asha = list.rows.find((row) => row.id === 41);
  assert.equal(asha.plan, "smart_care");
  assert.equal(asha.liveRequestId, 5502);
  assert.equal(asha.spent, 1010);
  assert.equal(list.rows.find((row) => row.id === 42).plan, null);

  const one = fakePool([
    [/FROM users WHERE id/, [{ id: 41, full_name: "Asha Raman", firebase_uid: "abc", created_at: at(NOW) }]],
    [/FROM service_requests sr/, [{ id: 5502, status: "on-the-way", service_type: "lockout", technician_name: "Arun" }, { id: 5318, status: "completed", fare: 450 }]],
    [/FROM payments/, [{ id: 1, service_request_id: 5318, status: "completed", amount: 450 }]],
    [/FROM user_vehicles/, []],
    [/FROM account_notes/, [{ id: 1, admin_id: "ops@resqnow.org", note: "Prefers a call", created_at: at(NOW) }]],
    [/FROM reviews/, [{ service_request_id: 5318, rating: 5 }]],
  ]);
  const customer = await getCustomer({ pool: one, customerId: 41 });
  assert.equal(customer.signsInWith, "phone");
  assert.equal(customer.live.id, 5502);
  assert.deepEqual(customer.totals, { requests: 2, cancelled: 0, spent: 450, paidJobs: 1, ratingGiven: 5, ratings: 1 });
  assert.equal(customer.requests.find((row) => row.id === 5318).rating, 5);
  assert.equal(customer.notes[0].by, "ops@resqnow.org");
  assert.equal(await getCustomer({ pool: fakePool([[/./, []]]), customerId: 9 }), null);
});

test("Reports: per day, the funnel, busy hours, cancellations and the period before", async () => {
  const startOfPeriod = DAY_START - 6 * 86_400_000;
  const pool = fakePool([
    [/FROM service_requests WHERE created_at/, [
      { id: 1, status: "completed", service_type: "towing", created_at: today(10) },
      { id: 2, status: "cancelled", service_type: "flat-tire", cancellation_reason: "Found help nearby", created_at: today(11) },
      { id: 3, status: "on-the-way", service_type: "towing", created_at: today(16) },
      { id: 4, status: "cancelled", service_type: "fuel", created_at: at(startOfPeriod - 86_400_000) },
    ]],
    [/FROM payments WHERE created_at/, [{ service_request_id: 1, status: "completed", amount: 900, technician_amount: 765, created_at: today(11) }]],
    [/FROM dispatch_offers/, [{ service_request_id: 1 }, { service_request_id: 2 }, { service_request_id: 3 }]],
    [/FROM request_timeline/, [
      { request_id: 1, event_type: "accepted", created_at: today(10, 2) }, { request_id: 1, event_type: "arrived", created_at: today(10, 14) },
      { request_id: 3, event_type: "accepted", created_at: today(16, 1) },
    ]],
  ]);
  const result = await getReports({ pool, days: 7, now: NOW });
  assert.equal(result.kpis.requests, 3);
  assert.equal(result.kpis.previousRequests, 1);
  assert.equal(result.kpis.averageArrivalMinutes, 12);
  assert.equal(result.kpis.margin, 135);
  assert.deepEqual(result.funnel.map((step) => step.count), [3, 3, 2, 1, 1, 1]);
  assert.deepEqual(result.perDay.at(-1), { date: "2026-10-14", completed: 1, cancelled: 1, other: 1 });
  assert.equal(result.busyHours[3][16], 1);
  assert.deepEqual(result.cancellations.reasons, [{ reason: "Found help nearby", count: 1 }]);
});

test("price medians are per service, vehicle type, type and field", async () => {
  const row = (base) => ({ service_id: 3, pricing_json: JSON.stringify({ service_domain: "towing", vehicle_type: "car", vehicle_subtype: "sedan", base_charge: base, free_distance: 5 }) });
  const result = await getPriceMedians({ pool: fakePool([[/technician_service_pricing/, [row(600), row(700), row(650), row(800)]]]) });
  const base = result.find((item) => item.field === "base_charge");
  assert.deepEqual(base, { serviceId: 3, vehicleType: "car", subtype: "sedan", field: "base_charge", median: 675, technicians: 4 });
});

test("the audit log groups actions and drops the old route prefix", async () => {
  const pool = fakePool([[/FROM admin_actions_log/, [
    { id: 3, admin_id: "ops@resqnow.org", action_type: "adminExtended.technicians.toggleTechnicianVisibility", target_type: "technician", target_id: "31", metadata: '{"isVisible":false}', created_at: today(11, 20) },
    { id: 2, admin_id: "ops@resqnow.org", action_type: "overrideRequestPricing", target_id: "5474", metadata: '{"newFare":780}', created_at: today(14, 30) },
    { id: 1, admin_id: "ops@resqnow.org", action_type: "technicianBroadcast", target_id: "broadcast", created_at: today(9) },
  ]]]);
  const result = await listAudit({ pool, query: {}, now: NOW });
  assert.deepEqual(result.counts, { all: 3, requests: 1, technicians: 1, complaints: 0, messages: 1, other: 0 });
  assert.equal(result.rows[0].type, "toggleTechnicianVisibility");
  assert.equal((await listAudit({ pool, query: { group: "requests" }, now: NOW })).rows[0].targetId, "5474");
  assert.equal((await listAudit({ pool, query: { search: "780" }, now: NOW })).total, 1);
});

test("a technician hidden by an admin is not offered new jobs", () => {
  const criteria = jobDispatchService.buildRequestCriteria({ location_lat: 11, location_lng: 76.9, service_type: "fuel", vehicle_type: "bike" });
  const tech = { status: "approved", is_active: 1, is_available: 1, current_job_id: null, latitude: 11.01, longitude: 76.91, service_type: "fuel", specialties: '["fuel"]', vehicle_types: '{"bike":true}', service_area_range: 10 };
  assert.equal(jobDispatchService.evaluateTechnicianForRequest(tech, criteria).eligible, true);
  const hidden = jobDispatchService.evaluateTechnicianForRequest({ ...tech, admin_hidden: 1 }, criteria);
  assert.equal(hidden.eligible, false);
  assert.deepEqual(hidden.reasons, ["hidden_by_admin"]);
});

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(router, path, method = "get") {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `missing ${method} ${path}`);
  return layer.route.stack.at(-1).handle;
}

test("the portal router is admin-only, answers 404 for a missing customer and reports settings truthfully", async () => {
  const guarded = createAdminPortalRouter({ guard: (_req, res) => res.status(401).json({ error: "Unauthorized" }), getPool: async () => fakePool([]) });
  assert.equal(guarded.stack[0].name, "guard");
  const router = createAdminPortalRouter({
    guard: (_req, _res, next) => next(), ensureSchema: async () => {}, now: () => NOW,
    getPool: async () => fakePool([[/FROM users WHERE id/, []], [/./, []]]),
  });
  const missing = response();
  await handler(router, "/customers/:id")({ params: { id: "99" }, query: {} }, missing);
  assert.equal(missing.statusCode, 404);
  const empty = response();
  await handler(router, "/customers/:id/notes", "post")({ params: { id: "41" }, body: { note: "Prefers a call" } }, empty);
  assert.equal(empty.statusCode, 404);
  const settings = response();
  await handler(router, "/settings")({ adminEmail: "ops@resqnow.org", query: {} }, settings);
  assert.equal(settings.body.admin.email, "ops@resqnow.org");
  assert.ok(settings.body.dispatch.offerTimeoutSeconds >= 1);
  assert.ok(settings.body.monitoring.rules.some((rule) => rule.code === "gps_inactive" && /8 min/.test(rule.threshold)));
  const failing = createAdminPortalRouter({ guard: (_req, _res, next) => next(), getPool: async () => fakePool([[/./, () => { throw new Error("boom"); }]]) });
  const error = response();
  await handler(failing, "/today")({ query: {} }, error);
  assert.equal(error.statusCode, 500);
});

test("portal SQL avoids subqueries inside a join condition, which TiDB in production rejects", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../services/adminPortalService.js", import.meta.url), "utf8");
  const joins = source.match(/JOIN\s+\w+\s+\w+\s+ON\s+[^\n]*\(\s*SELECT/gi) || [];
  assert.deepEqual(joins, []);
});
