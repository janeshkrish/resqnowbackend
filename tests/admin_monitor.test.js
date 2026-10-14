import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enableRequestEvents,
  eventTypeForStatus,
  recordAcceptedEvent,
  recordRequestEvent,
  recordStatusChange,
} from '../services/requestEvents.js';
import {
  buildTimeline,
  getLiveRequests,
  getTechnicianJobs,
  getTechnicianRecord,
  maskPhone,
  phaseOf,
  stepsOf,
} from '../services/adminMonitorService.js';
import { ADMIN_ROOM, SocketService } from '../services/socket.js';
import { createAdminMonitorRouter } from '../routes/adminMonitor.js';

const NOW = Date.parse('2026-10-14T11:00:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000);

/** A pool that answers each query by the first pattern its SQL matches, and records what it was asked. */
function fakePool(routes) {
  const seen = [];
  const answer = async (sql, params = []) => {
    seen.push({ sql, params });
    for (const [pattern, reply] of routes) {
      if (pattern.test(sql)) return [typeof reply === 'function' ? reply(params, sql) : reply, []];
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 120)}`);
  };
  return { query: answer, execute: answer, seen };
}

// ---------------------------------------------------------------- request events

test('statuses map to the steps of a job', () => {
  assert.equal(eventTypeForStatus('accepted'), 'accepted');
  assert.equal(eventTypeForStatus('on-the-way'), 'set_off');
  assert.equal(eventTypeForStatus('en_route_pickup'), 'set_off');
  assert.equal(eventTypeForStatus('arrived'), 'arrived');
  assert.equal(eventTypeForStatus('service_started'), 'work_started');
  assert.equal(eventTypeForStatus('payment_pending'), 'work_done');
  assert.equal(eventTypeForStatus('paid'), 'paid');
  assert.equal(eventTypeForStatus('cancelled'), 'cancelled');
  assert.equal(eventTypeForStatus('nonsense'), null);
});

test('recording writes one timeline row and tells admins', async () => {
  const pool = fakePool([[/INSERT INTO request_timeline/, { insertId: 1 }]]);
  const told = [];
  const row = await recordRequestEvent(
    { requestId: '5502', eventType: 'arrived', status: 'arrived', actorType: 'technician', actorId: 7, metadata: { technicianId: '7' } },
    { getPool: async () => pool, notifyAdmins: (event, data) => told.push({ event, data }), now: () => new Date(NOW) }
  );
  assert.equal(row.requestId, 5502);
  assert.equal(row.title, 'Arrived');
  assert.equal(row.actorId, '7');
  assert.deepEqual(pool.seen[0].params, [5502, 'arrived', 'arrived', 'Arrived', null, 'technician', '7', JSON.stringify({ technicianId: '7' })]);
  assert.deepEqual(told.map((t) => t.event), ['admin:request_event']);
  assert.equal(told[0].data.at, new Date(NOW).toISOString());
});

test('recording is off unless the server switched it on, and never throws', async () => {
  enableRequestEvents(false);
  assert.equal(await recordRequestEvent({ requestId: 1, eventType: 'arrived' }), null);
  const broken = { execute: async () => { throw new Error('db down'); } };
  assert.equal(await recordRequestEvent({ requestId: 1, eventType: 'arrived' }, { getPool: async () => broken, notifyAdmins: () => {} }), null);
});

test('a status that stays in the same step is not recorded twice', async () => {
  const pool = fakePool([[/INSERT INTO request_timeline/, { insertId: 1 }]]);
  const deps = { getPool: async () => pool, notifyAdmins: () => {} };
  assert.equal(await recordStatusChange({ requestId: 1, status: 'en_route_pickup', previousStatus: 'on-the-way', actorType: 'technician', actorId: 7 }, deps), null);
  assert.equal(pool.seen.length, 0);
  const row = await recordStatusChange({ requestId: 1, status: 'arrived', previousStatus: 'on-the-way', actorType: 'technician', actorId: 7 }, deps);
  assert.equal(row.eventType, 'arrived');
  assert.equal(row.metadata.previousStatus, 'on-the-way');
});

test('accepting fixes the promised arrival from the route', async () => {
  const pool = fakePool([[/INSERT INTO request_timeline/, { insertId: 1 }]]);
  const row = await recordAcceptedEvent(
    { requestId: 5502, technicianId: 7, from: { lat: 11.0, lng: 76.9 }, to: { lat: 11.02, lng: 76.95 } },
    { getPool: async () => pool, notifyAdmins: () => {}, now: () => new Date(NOW), getRoute: async () => ({ durationMinutes: 7.2, distanceKm: 3.1 }) }
  );
  assert.equal(row.eventType, 'accepted');
  assert.equal(row.metadata.etaMinutes, 7.2);
  assert.equal(row.metadata.promisedAt, new Date(NOW + 8 * 60_000).toISOString());
  const noRoute = await recordAcceptedEvent(
    { requestId: 5502, technicianId: 7, from: { lat: 11, lng: 76.9 }, to: { lat: 11.02, lng: 76.95 } },
    { getPool: async () => pool, notifyAdmins: () => {}, now: () => new Date(NOW), getRoute: async () => { throw new Error('no route'); } }
  );
  assert.equal(noRoute.metadata.promisedAt, null);
});

test('admin events go to the admins room only', () => {
  const sent = [];
  const service = new SocketService();
  service.io = { to: (room) => ({ emit: (event, data) => sent.push({ room, event, data }) }), emit: () => assert.fail('must not reach everyone') };
  service.notifyAdmins('admin:payment_update', { requestId: 1 });
  assert.deepEqual(sent, [{ room: ADMIN_ROOM, event: 'admin:payment_update', data: { requestId: 1 } }]);
});

// ---------------------------------------------------------------- the live list

test('phases and steps follow the customer’s four steps', () => {
  assert.equal(phaseOf('pending'), 'finding');
  assert.equal(phaseOf('assigned'), 'offered');
  assert.equal(phaseOf('on-the-way'), 'on_the_way');
  assert.equal(phaseOf('service_started'), 'working');
  assert.equal(phaseOf('enroute_drop'), 'towing');
  assert.equal(phaseOf('payment_pending'), 'payment_due');
  assert.equal(phaseOf('paid'), 'done');
  assert.deepEqual(stepsOf('arrived'), { done: 2, now: 2 });
  assert.deepEqual(stepsOf('payment_due'), { done: 4, now: -1 });
});

test('phone numbers are masked', () => {
  assert.equal(maskPhone('+91 98765 43210'), '+91 98••• ••210');
  assert.equal(maskPhone('9876543210'), '+91 98••• ••210');
  assert.equal(maskPhone(''), null);
});

function liveRoutes() {
  const base = { user_id: 41, vehicle_type: 'truck', vehicle_model: 'Yodha', vehicle_brand: 'Tata', address: 'Bharathi Nagar', drop_address: null, drop_latitude: null, drop_longitude: null, contact_phone: '9876543210', amount: 110, final_price: null, estimated_price: null, payment_method: 'cash', payment_status: 'pending', updated_at: ago(1), started_at: null, start_time: null, completed_at: null, cancelled_at: null, cancellation_reason: null, route_distance_km: 3.1, pricing_breakdown_json: null, user_name: 'Asha Raman', user_phone: null, technician_rating: 4.8, technician_service_type: 'mechanic' };
  return [
    [/WHERE LOWER\(COALESCE\(sr\.status, ''\)\) IN/, [
      { ...base, id: 5502, technician_id: 7, status: 'on-the-way', service_type: 'truck-lockout', location_lat: 11.02, location_lng: 76.95, contact_name: 'Asha Raman', created_at: ago(11), accepted_time: ago(8), sla_deadline: null, technician_name: 'Arun Kumar' },
      { ...base, id: 5499, technician_id: 9, status: 'on-the-way', service_type: 'bike-flat-tire', location_lat: 11.0, location_lng: 76.96, contact_name: 'Priya M', created_at: ago(18), accepted_time: ago(17), sla_deadline: null, technician_name: 'Ravi N' },
      { ...base, id: 5503, technician_id: null, status: 'pending', service_type: 'car-battery', location_lat: 11.01, location_lng: 76.94, contact_name: 'Deepak V', created_at: ago(6), accepted_time: null, sla_deadline: null, technician_name: null },
    ]],
    [/FROM request_timeline\s+WHERE request_id IN/, [
      { request_id: 5502, event_type: 'accepted', metadata: JSON.stringify({ promisedAt: new Date(NOW + 6 * 60_000).toISOString() }), created_at: ago(8) },
      { request_id: 5499, event_type: 'accepted', metadata: { promisedAt: new Date(NOW - 3 * 60_000).toISOString() }, created_at: ago(17) },
    ]],
    [/FROM job_monitoring_alerts WHERE is_active = 1/, [
      { service_request_id: 5499, reason_code: 'movement_stationary', reason_text: 'Technician appears stationary', risk_level: 'high', eta_minutes: 9, first_detected_at: ago(5) },
    ]],
    [/FROM dispatch_offers\s+WHERE service_request_id IN/, [
      { service_request_id: 5503, status: 'rejected', n: 1 }, { service_request_id: 5503, status: 'pending', n: 2 }, { service_request_id: 5502, status: 'accepted', n: 1 },
    ]],
    [/FROM technician_location_history h/, [
      { service_request_id: 5499, latitude: 11.0, longitude: 76.93, recorded_at: ago(4), speed_mps: 0, heading_degrees: 90 },
    ]],
    [/SUM\(CASE WHEN completed_at >= \?/, [{ completed: 46, accept_seconds: 34.4 }]],
    [/a\.event_type = 'arrived' AND a\.created_at >= \?/, [
      { request_id: 5400, arrived_at: ago(60), accepted_time: ago(72) }, { request_id: 5401, arrived_at: ago(30), accepted_time: ago(40) },
    ]],
  ];
}

test('the live list: phase, minutes from the shared ETA, last seen, alerts, offers and today’s numbers', async () => {
  const pool = fakePool(liveRoutes());
  const runtime = {
    store: { getForRequest: async (techId, reqId) => (reqId === '5502' ? { lat: 11.005, lng: 76.93, recordedAt: new Date(NOW - 8_000).toISOString() } : null) },
    trafficEta: { readCachedEta: async (id) => (id === '5502' ? { etaSeconds: 360, distanceMeters: 2400, trafficAware: true, calculatedAt: new Date(NOW - 20_000).toISOString() } : null) },
  };
  const result = await getLiveRequests({ pool, runtime, now: NOW });
  const [arun, ravi, deepak] = result.requests;

  assert.equal(arun.phase, 'on_the_way');
  assert.deepEqual(arun.steps, { done: 1, now: 1 });
  assert.equal(arun.live.etaSeconds, 360);
  assert.equal(arun.live.distanceKm, 2.4);
  assert.equal(arun.live.distanceSource, 'route');
  assert.equal(arun.live.trafficAware, true);
  assert.equal(arun.live.gpsStale, false);
  assert.equal(arun.promisedAt, new Date(NOW + 6 * 60_000).toISOString());
  assert.equal(arun.customer.phoneMasked, '+91 98••• ••210');
  assert.equal(arun.technician.name, 'Arun Kumar');

  // No cached ETA: the straight-line distance from the last GPS point, which is 4 minutes old.
  assert.equal(ravi.live.etaSeconds, null);
  assert.equal(ravi.live.distanceSource, 'straight');
  assert.ok(ravi.live.distanceKm > 3 && ravi.live.distanceKm < 3.4, String(ravi.live.distanceKm));
  assert.equal(ravi.live.gpsStale, true);
  assert.equal(ravi.alerts[0].code, 'movement_stationary');

  assert.equal(deepak.phase, 'finding');
  assert.equal(deepak.technician, null);
  assert.equal(deepak.live, null);
  assert.deepEqual({ sent: deepak.search.sent, declined: deepak.search.declined, pending: deepak.search.pending }, { sent: 3, declined: 1, pending: 2 });

  assert.deepEqual(result.kpis, {
    live: 3, finding: 1, needsAttention: 1, acceptSecondsToday: 34, arrivalMinutesToday: 11, arrivalsMeasuredToday: 2, completedToday: 46,
  });
});

test('the timeline merges recorded events, offers, alerts and stored times, newest first', () => {
  const items = buildTimeline({
    request: { created_at: ago(30), accepted_time: ago(27), started_at: null, start_time: null, completed_at: null, cancelled_at: null },
    timeline: [{ event_type: 'set_off', title: 'Set off', created_at: ago(25), actor_type: 'technician', actor_id: '7', metadata: '{}' }],
    offers: [{ technician_id: 9, technician_name: 'Ravi N', status: 'rejected', sent_at: ago(29) }],
    alerts: [{ reason_code: 'start_delay', reason_text: 'Not moving', risk_level: 'medium', is_active: 0, first_detected_at: ago(26), resolved_at: ago(25) }],
    actions: [{ admin_id: 'ops@resqnow.org', action_type: 'remind_technician', metadata: '{}', created_at: ago(24) }],
  });
  assert.deepEqual(items.map((i) => i.kind), ['admin_action', 'set_off', 'alert', 'accepted', 'offer', 'created']);
  assert.equal(items.find((i) => i.kind === 'offer').meta.result, 'rejected');
  assert.equal(items.find((i) => i.kind === 'accepted').source, 'stored');
});

// ---------------------------------------------------------------- technician record

test('the technician record counts offers, removals, arrivals against the promise, reviews and money', async () => {
  const weekAgo = (d) => new Date(NOW - d * 86_400_000);
  const pool = fakePool([
    [/FROM technicians WHERE id = \?/, [{ id: 42, name: 'Selvam R', phone: '9443300507', service_type: 'towing', status: 'approved', is_available: 0, is_logged_in: 1, rating: 4.9, jobs_completed: 207, created_at: weekAgo(200), locality: 'Coimbatore', district: null, address: null, last_seen_at: ago(1) }]],
    [/SELECT COUNT\(\*\) AS completed FROM service_requests/, [{ completed: 5 }]],
    [/SELECT completed_at FROM service_requests/, [{ completed_at: ago(60) }, { completed_at: weekAgo(8) }, { completed_at: weekAgo(9) }]],
    [/FROM dispatch_offers WHERE technician_id = \? GROUP BY status/, [{ status: 'accepted', n: 6 }, { status: 'rejected', n: 2 }, { status: 'expired', n: 2 }]],
    [/SELECT id FROM service_requests WHERE technician_id = \? AND LOWER/, [{ id: 5501 }]],
    [/SELECT AVG\(rating\) AS avg, COUNT\(\*\) AS n FROM reviews/, [{ avg: 4.25, n: 4 }]],
    [/SELECT ROUND\(rating\) AS stars/, [{ stars: 5, n: 2 }, { stars: 4, n: 1 }, { stars: 2, n: 1 }]],
    [/r\.rating <= 2/, [{ service_request_id: 5386, rating: 2, comment: 'Truck too small', created_at: weekAgo(5), full_name: 'Prakash N' }]],
    [/FROM payments p JOIN service_requests sr/, [{ total: 4120, month: 860 }]],
    [/FROM technician_dues/, [{ owed: 0 }]],
    [/FROM job_monitoring_alerts WHERE technician_id = \?/, [{ reason_code: 'arrival_delay', n: 2 }, { reason_code: 'start_delay', n: 1 }]],
    [/event_type = 'technician_assigned'/, [
      { request_id: 5300, metadata: JSON.stringify({ technicianId: 9, previousTechnicianId: 42 }), created_at: weekAgo(20) },
      { request_id: 5301, metadata: JSON.stringify({ technicianId: 42, previousTechnicianId: 42 }), created_at: weekAgo(21) },
    ]],
    [/t\.event_type = 'cancelled' AND t\.actor_type = 'user'/, [{ request_id: 5420, description: 'Found help nearby', metadata: '{}', created_at: weekAgo(2), service_type: 'car-towing' }]],
    [/status = 'expired' AND sent_at >= \?/, [{ day: weekAgo(3), n: 3 }]],
    [/a\.event_type = 'arrived' AND a\.actor_id = \?/, [
      { request_id: 5466, arrived_at: ago(120), accepted_time: ago(140), service_type: 'car-winching', sla_deadline: null, accepted_meta: JSON.stringify({ promisedAt: ago(127).toISOString() }), accepted_at: ago(140) },
      { request_id: 5476, arrived_at: weekAgo(10), accepted_time: null, service_type: 'car-towing', sla_deadline: null, accepted_meta: JSON.stringify({ promisedAt: new Date(NOW - 10 * 86_400_000 + 2 * 60_000).toISOString() }), accepted_at: new Date(NOW - 10 * 86_400_000 - 12 * 60_000) },
      { request_id: 5477, arrived_at: weekAgo(11), accepted_time: weekAgo(11), service_type: 'car-towing', sla_deadline: null, accepted_meta: null, accepted_at: null },
    ]],
  ]);
  const record = await getTechnicianRecord({ pool, technicianId: 42, now: NOW });

  assert.equal(record.technician.name, 'Selvam R');
  assert.equal(record.technician.onDuty, true);
  assert.equal(record.technician.currentRequestId, 5501);
  assert.equal(record.technician.phoneMasked, '+91 94••• ••507');
  assert.deepEqual(record.kpis.offers, { sent: 10, accepted: 6, declined: 2, expired: 2, pending: 0 });
  assert.equal(record.kpis.acceptanceRate, 0.6);
  assert.equal(record.kpis.removedByAdmin, 1);
  assert.equal(record.kpis.customerCancelledAfterAccepting, 1);
  // 5466: promised 127 min ago, arrived 120 min ago → 7 late. 5476: early. 5477: no promise, not judged.
  assert.equal(record.kpis.arrivalsJudged, 2);
  assert.equal(record.kpis.onTimeRate, 0.5);
  assert.deepEqual(record.reliability.arrivals, { onTime: 1, late1to5: 0, late6to10: 1, lateOver10: 0 });
  assert.equal(record.reliability.late[0].requestId, 5466);
  assert.equal(record.reliability.late[0].lateMinutes, 7);
  assert.equal(record.kpis.averageMinutesToArrive, 11); // (20 + 12 + 0) / 3
  assert.equal(record.kpis.rating, 4.25);
  assert.deepEqual(record.reviews.distribution.map((d) => d.count), [2, 1, 0, 1, 0]);
  assert.equal(record.kpis.lowRatings, 1);
  assert.equal(record.kpis.earnedThisMonth, 860);
  assert.equal(record.kpis.duesOwed, 0);
  assert.equal(record.weekly.length, 12);
  assert.equal(record.weekly.reduce((a, w) => a + w.jobs, 0), 3);
  assert.equal(record.reliability.alerts.find((a) => a.code === 'arrival_delay').count, 2);
  assert.deepEqual(record.flags.map((f) => f.kind), ['late', 'review', 'expired']);
});

test('job history judges each arrival against its own promise', async () => {
  const pool = fakePool([
    [/ORDER BY sr\.created_at DESC\s+LIMIT \? OFFSET \?/, [
      { id: 5466, status: 'paid', service_type: 'car-winching', created_at: ago(140), accepted_time: ago(139), started_at: ago(118), start_time: null, completed_at: ago(74), route_distance_km: 3.3, final_price: 1100, amount: null, estimated_price: null, payment_method: 'cash', payment_status: 'paid', sla_deadline: null, customer_name: 'Ganesh P', rating: 4, accepted_meta: JSON.stringify({ promisedAt: ago(127).toISOString() }), arrived_at: ago(120) },
    ]],
    [/SELECT COUNT\(\*\) AS n FROM service_requests sr/, [{ n: 1 }]],
  ]);
  const jobs = await getTechnicianJobs({ pool, technicianId: 42, status: 'done', days: 30 });
  assert.equal(jobs.data[0].lateMinutes, 7);
  assert.equal(jobs.data[0].workMinutes, 44);
  assert.equal(jobs.data[0].fare, 1100);
  assert.equal(jobs.data[0].rating, 4);
  assert.deepEqual(jobs.pagination, { page: 1, limit: 20, total: 1, totalPages: 1 });
  assert.match(pool.seen[0].sql, /sr\.completed_at IS NOT NULL/);
});

// ---------------------------------------------------------------- routes

function call(router, { method = 'GET', url, body = {} }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, body: data }); return this; },
    };
    router.handle({ method, url, body, headers: {}, query: {} }, res, () => resolve({ status: 404, body: null }));
  });
}

test('notes need text, are written as admin notes and reject bad ids', async () => {
  const recorded = [];
  const router = createAdminMonitorRouter({
    guard: (req, _res, next) => { req.adminEmail = 'ops@resqnow.org'; next(); },
    getPool: async () => ({}),
    record: async (event) => { recorded.push(event); return { ...event, at: 'now' }; },
  });
  assert.equal((await call(router, { method: 'POST', url: '/requests/5502/notes', body: { note: '  ' } })).status, 400);
  assert.equal((await call(router, { method: 'POST', url: '/requests/abc/notes', body: { note: 'x' } })).status, 400);
  const ok = await call(router, { method: 'POST', url: '/requests/5502/notes', body: { note: 'Called Arun, stuck at a level crossing' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(recorded[0], { requestId: 5502, eventType: 'admin_note', actorType: 'admin', actorId: 'ops@resqnow.org', description: 'Called Arun, stuck at a level crossing' });
});
