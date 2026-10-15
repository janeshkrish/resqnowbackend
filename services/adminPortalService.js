import { ACTIVE_STATUSES, DONE_STATUSES, maskPhone, phaseOf } from "./adminMonitorService.js";
import { ADMIN_NOTIFICATION_TYPE_FILTER_VALUES } from "./adminNotificationTypes.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { istDayStart, istHour, istWeekday } from "./istTime.js";

// What the redesigned admin portal reads: Today, search, the request / technician / customer lists,
// reports and the smaller lookups. Every number comes from the database; nothing is invented.
// Day boundaries are Indian Standard Time, where the business runs.

const DAY = 86_400_000;
const IST = 330 * 60_000;
const placeholders = (list) => list.map(() => "?").join(", ");
const toMs = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const numOrNull = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const lower = (value) => String(value ?? "").trim().toLowerCase();
const parseJson = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const iso = (value) => {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
};
const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export { istDayStart, istHour, istWeekday };

const CANCELLED = ["cancelled", "rejected"];
const PAID_PAYMENT = ["completed", "captured", "paid", "success", "settled"];
const isDone = (status) => DONE_STATUSES.includes(lower(status));
const isCancelled = (status) => CANCELLED.includes(lower(status));
const isLive = (status) => ACTIVE_STATUSES.includes(lower(status));
const domainOf = (serviceType) => canonicalizeServiceDomain(String(serviceType || "").replace(/^(car|bike|ev|commercial)-/i, "")) || lower(serviceType) || "other";

// A query that may meet a table the database does not have yet answers with no rows.
async function rows(pool, sql, params = []) {
  try {
    const [result] = await pool.query(sql, params);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    if (/doesn't exist|no such table/i.test(String(error?.message || ""))) return [];
    throw error;
  }
}

/** Counts for the side bar: live jobs, open alerts, waiting applications, payout requests and open complaints. */
export async function getNavCounts({ pool }) {
  const [live, alerts, applications, payouts, complaints] = await Promise.all([
    rows(pool, `SELECT COUNT(*) AS n FROM service_requests WHERE LOWER(COALESCE(status, '')) IN (${placeholders(ACTIVE_STATUSES)})`, ACTIVE_STATUSES),
    rows(pool, "SELECT COUNT(*) AS n FROM job_monitoring_alerts WHERE is_active = 1"),
    rows(pool, "SELECT COUNT(*) AS n FROM technicians WHERE LOWER(COALESCE(status, 'pending')) = 'pending'"),
    rows(pool, "SELECT COUNT(*) AS n FROM withdrawal_requests WHERE LOWER(COALESCE(status, 'pending')) IN ('pending', 'processing')"),
    rows(pool, "SELECT COUNT(*) AS n FROM admin_complaints WHERE LOWER(COALESCE(status, 'open')) <> 'resolved'"),
  ]);
  return {
    live: num(live[0]?.n), alerts: num(alerts[0]?.n), applications: num(applications[0]?.n),
    payouts: num(payouts[0]?.n), complaints: num(complaints[0]?.n),
  };
}

/** GET /today — what is live, what needs a person, and how the day is going. */
export async function getToday({ pool, now = Date.now() }) {
  const dayStart = istDayStart(now);
  const weekAgo = dayStart - 7 * DAY;
  const sinceDayStart = now - dayStart;
  const [requests, payments, payouts, dues, technicians, alerts, pending, complaints] = await Promise.all([
    rows(pool, "SELECT id, status, service_type, created_at, completed_at, updated_at FROM service_requests WHERE created_at >= ?", [new Date(weekAgo)]),
    rows(pool, "SELECT payment_method, status, amount, technician_amount, created_at FROM payments WHERE created_at >= ?", [new Date(dayStart)]),
    rows(pool, `SELECT w.amount, w.created_at, t.name FROM withdrawal_requests w LEFT JOIN technicians t ON t.id = w.technician_id
                WHERE LOWER(COALESCE(w.status, 'pending')) IN ('pending', 'processing') ORDER BY w.created_at ASC`),
    rows(pool, "SELECT technician_id, amount FROM technician_dues WHERE LOWER(COALESCE(status, 'pending')) = 'pending'"),
    rows(pool, `SELECT id, name, is_active, is_available, current_job_id, current_lat, current_lng, latitude, longitude, last_seen_at
                FROM technicians WHERE LOWER(COALESCE(status, '')) = 'approved'`),
    rows(pool, `SELECT a.service_request_id, a.reason_code, a.reason_text, a.risk_level, a.first_detected_at,
                       sr.service_type, u.full_name AS customer_name, t.name AS technician_name
                FROM job_monitoring_alerts a
                LEFT JOIN service_requests sr ON sr.id = a.service_request_id
                LEFT JOIN users u ON u.id = sr.user_id
                LEFT JOIN technicians t ON t.id = a.technician_id
                WHERE a.is_active = 1 ORDER BY a.first_detected_at ASC LIMIT 20`),
    rows(pool, "SELECT id, name, created_at FROM technicians WHERE LOWER(COALESCE(status, 'pending')) = 'pending' ORDER BY created_at ASC"),
    rows(pool, "SELECT id, title, status, created_at FROM admin_complaints WHERE LOWER(COALESCE(status, 'open')) <> 'resolved' ORDER BY created_at DESC"),
  ]);

  const hours = Array.from({ length: 24 }, () => 0);
  const lastWeek = Array.from({ length: 24 }, () => 0);
  const mix = new Map();
  let completedToday = 0;
  let completedLastWeek = 0;
  let cancelledToday = 0;
  for (const row of requests) {
    const created = toMs(row.created_at);
    if (created == null) continue;
    if (created >= dayStart) {
      hours[istHour(created)] += 1;
      const domain = domainOf(row.service_type);
      mix.set(domain, (mix.get(domain) || 0) + 1);
      if (isCancelled(row.status)) cancelledToday += 1;
    } else if (created >= weekAgo && created < weekAgo + DAY) {
      lastWeek[istHour(created)] += 1;
    }
    const finished = toMs(row.completed_at);
    if (!isCancelled(row.status) && finished != null) {
      if (finished >= dayStart && finished <= now) completedToday += 1;
      else if (finished >= weekAgo && finished <= weekAgo + sinceDayStart) completedLastWeek += 1;
    }
  }

  const paid = payments.filter((row) => PAID_PAYMENT.includes(lower(row.status)));
  const cash = paid.filter((row) => lower(row.payment_method) === "cash");
  const online = paid.filter((row) => lower(row.payment_method) !== "cash");
  const sum = (list, key) => list.reduce((total, row) => total + num(row[key]), 0);
  const collected = sum(paid, "amount");
  const toTechnicians = sum(paid, "technician_amount");

  const onDuty = technicians.filter((row) => Boolean(Number(row.is_active)));
  const onJob = onDuty.filter((row) => row.current_job_id != null);
  const free = onDuty.filter((row) => row.current_job_id == null);
  const position = (row) => {
    const lat = numOrNull(row.current_lat) ?? numOrNull(row.latitude);
    const lng = numOrNull(row.current_lng) ?? numOrNull(row.longitude);
    return lat == null || lng == null ? null : { lat, lng };
  };

  const oldestPending = pending[0];
  const openOld = complaints.filter((row) => now - (toMs(row.created_at) ?? now) > DAY).length;
  return {
    generatedAt: new Date(now).toISOString(),
    completed: { today: completedToday, sameTimeLastWeek: completedLastWeek },
    cancelledToday,
    requestsToday: hours.reduce((a, b) => a + b, 0),
    requestsByHour: { today: hours, lastWeek, currentHour: istHour(now) },
    serviceMix: [...mix.entries()].map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count),
    money: {
      collected, payments: paid.length,
      online: { amount: sum(online, "amount"), count: online.length },
      cash: { amount: sum(cash, "amount"), count: cash.length },
      toTechnicians, toResqnow: Math.max(0, collected - toTechnicians),
      payoutsWaiting: { amount: sum(payouts, "amount"), count: payouts.length },
      cashDues: { amount: sum(dues, "amount"), technicians: new Set(dues.map((row) => String(row.technician_id))).size },
    },
    technicians: {
      approved: technicians.length, onDuty: onDuty.length, onJob: onJob.length, free: free.length,
      freePositions: free.map((row) => ({ id: row.id, name: row.name, position: position(row) })).filter((row) => row.position).slice(0, 300),
    },
    needs: {
      alerts: alerts.map((row) => ({
        requestId: row.service_request_id, code: row.reason_code, text: row.reason_text, level: row.risk_level,
        since: iso(row.first_detected_at), service: row.service_type, customer: row.customer_name || null, technician: row.technician_name || null,
      })),
      applications: { count: pending.length, oldest: oldestPending ? { id: oldestPending.id, name: oldestPending.name, since: iso(oldestPending.created_at) } : null },
      payouts: { count: payouts.length, amount: sum(payouts, "amount"), names: payouts.map((row) => row.name).filter(Boolean).slice(0, 3) },
      complaints: { count: complaints.length, olderThanDay: openOld, latest: complaints[0] ? { id: complaints[0].id, title: complaints[0].title } : null },
    },
  };
}

/** GET /search?q= — requests, customers, technicians and payments in one box. */
export async function search({ pool, q }) {
  const text = String(q || "").trim();
  if (text.length < 2 && !/^\d+$/.test(text)) return { query: text, requests: [], customers: [], technicians: [], payments: [] };
  const like = `%${text.toLowerCase().replace(/[%_]/g, "\\$&")}%`;
  const digits = text.replace(/\D/g, "");
  const phoneLike = digits.length >= 4 ? `%${digits}%` : "__no_phone__";
  const id = /^#?\d+$/.test(text) ? Number(text.replace("#", "")) : -1;
  const [requests, customers, technicians, payments, payouts] = await Promise.all([
    rows(pool, `SELECT sr.id, sr.status, sr.service_type, sr.vehicle_type, sr.vehicle_model, sr.address, sr.created_at,
                       COALESCE(sr.final_price, sr.amount, sr.estimated_price) AS fare,
                       u.full_name AS customer_name, t.name AS technician_name
                FROM service_requests sr LEFT JOIN users u ON u.id = sr.user_id LEFT JOIN technicians t ON t.id = sr.technician_id
                WHERE sr.id = ? OR LOWER(COALESCE(u.full_name, '')) LIKE ? OR REPLACE(COALESCE(sr.contact_phone, ''), ' ', '') LIKE ?
                   OR REPLACE(COALESCE(u.phone, ''), ' ', '') LIKE ? OR LOWER(COALESCE(t.name, '')) LIKE ?
                ORDER BY sr.created_at DESC LIMIT 6`, [id, like, phoneLike, phoneLike, like]),
    rows(pool, `SELECT u.id, u.full_name, u.email, u.phone, u.created_at, u.subscription,
                       (SELECT COUNT(*) FROM service_requests sr WHERE sr.user_id = u.id) AS requests
                FROM users u WHERE u.id = ? OR LOWER(COALESCE(u.full_name, '')) LIKE ? OR LOWER(COALESCE(u.email, '')) LIKE ?
                   OR REPLACE(COALESCE(u.phone, ''), ' ', '') LIKE ? ORDER BY u.created_at DESC LIMIT 5`, [id, like, like, phoneLike]),
    rows(pool, `SELECT id, name, proprietor_name, phone, status, is_active, current_job_id, service_type FROM technicians
                WHERE id = ? OR LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(proprietor_name, '')) LIKE ?
                   OR REPLACE(COALESCE(phone, ''), ' ', '') LIKE ? OR LOWER(COALESCE(email, '')) LIKE ? LIMIT 5`, [id, like, like, phoneLike, like]),
    rows(pool, `SELECT p.id, p.service_request_id, p.payment_method, p.status, p.amount, p.razorpay_payment_id, p.razorpay_order_id, p.created_at
                FROM payments p WHERE p.id = ? OR p.service_request_id = ? OR LOWER(COALESCE(p.razorpay_payment_id, '')) LIKE ?
                   OR LOWER(COALESCE(p.razorpay_order_id, '')) LIKE ? ORDER BY p.created_at DESC LIMIT 5`, [id, id, like, like]),
    rows(pool, `SELECT p.id, p.technician_id, p.amount, p.status, p.external_reference, p.destination_reference, p.processed_at, t.name AS technician_name
                FROM payouts p LEFT JOIN technicians t ON t.id = p.technician_id
                WHERE LOWER(COALESCE(p.external_reference, '')) LIKE ? OR LOWER(COALESCE(p.destination_reference, '')) LIKE ? LIMIT 5`, [like, like]),
  ]);
  return {
    query: text,
    requests: requests.map((row) => ({
      id: row.id, status: row.status, phase: phaseOf(row.status), service: row.service_type, vehicleType: row.vehicle_type, vehicleModel: row.vehicle_model,
      area: row.address || null, createdAt: iso(row.created_at), fare: numOrNull(row.fare), customer: row.customer_name || null, technician: row.technician_name || null,
    })),
    customers: customers.map((row) => ({ id: row.id, name: row.full_name, email: row.email, phoneMasked: maskPhone(row.phone), joinedAt: iso(row.created_at), plan: row.subscription || null, requests: num(row.requests) })),
    technicians: technicians.map((row) => ({ id: row.id, name: row.name, owner: row.proprietor_name || null, phoneMasked: maskPhone(row.phone), status: row.status, onDuty: Boolean(Number(row.is_active)), currentJobId: row.current_job_id ?? null, service: row.service_type })),
    payments: [
      ...payments.map((row) => ({ kind: "payment", id: row.id, requestId: row.service_request_id, method: row.payment_method, status: row.status, amount: numOrNull(row.amount), reference: row.razorpay_payment_id || row.razorpay_order_id || null, at: iso(row.created_at) })),
      ...payouts.map((row) => ({ kind: "payout", id: row.id, technicianId: row.technician_id, technician: row.technician_name || null, status: row.status, amount: numOrNull(row.amount), reference: row.external_reference || row.destination_reference || null, at: iso(row.processed_at) })),
    ],
  };
}

const REQUEST_TABS = {
  all: () => true,
  live: (row) => isLive(row.status),
  completed: (row) => isDone(row.status),
  cancelled: (row) => isCancelled(row.status),
  payment_due: (row) => ["service_completed", "awaiting_payment", "payment_pending"].includes(lower(row.status)),
  refunded: (row) => num(row.refunded_amount) > 0,
};

function arrivalOf(events) {
  const accepted = events.find((event) => event.event_type === "accepted");
  const arrived = events.find((event) => event.event_type === "arrived");
  const started = events.find((event) => event.event_type === "work_started");
  const done = events.find((event) => event.event_type === "work_done");
  const promisedAt = parseJson(accepted?.metadata, {})?.promisedAt || null;
  const arrivedAt = iso(arrived?.created_at);
  const lateMinutes = promisedAt && arrivedAt ? Math.round((Date.parse(arrivedAt) - Date.parse(promisedAt)) / 60_000) : null;
  const workMinutes = started && done ? Math.max(0, Math.round((toMs(done.created_at) - toMs(started.created_at)) / 60_000)) : null;
  return { promisedAt, arrivedAt, lateMinutes, workMinutes };
}

/** GET /requests — every request with its arrival against the promise, fare and payment; tab counts for the chosen dates. */
export async function listRequests({ pool, query = {}, now = Date.now() }) {
  const days = clampInt(query.days, 7, 1, 366);
  const from = query.from ? toMs(query.from) : istDayStart(now) - (days - 1) * DAY;
  const to = query.to ? toMs(query.to) + DAY : now + 60_000;
  const page = clampInt(query.page, 1, 1, 10_000);
  const limit = clampInt(query.limit, 20, 5, 100);
  const tab = REQUEST_TABS[query.tab] ? query.tab : "all";
  const where = ["sr.created_at >= ?", "sr.created_at < ?"];
  const params = [new Date(from), new Date(to)];
  if (query.service) { where.push("LOWER(COALESCE(sr.service_type, '')) LIKE ?"); params.push(`%${lower(query.service)}%`); }
  if (query.technicianId) { where.push("sr.technician_id = ?"); params.push(Number(query.technicianId)); }
  if (query.customerId) { where.push("sr.user_id = ?"); params.push(Number(query.customerId)); }
  if (query.search) {
    const text = String(query.search).trim();
    const like = `%${text.toLowerCase()}%`;
    const digits = text.replace(/\D/g, "");
    where.push(`(CAST(sr.id AS CHAR) = ? OR LOWER(COALESCE(u.full_name, '')) LIKE ? OR LOWER(COALESCE(t.name, '')) LIKE ?
                 OR LOWER(COALESCE(sr.address, '')) LIKE ? OR (? <> '' AND REPLACE(COALESCE(sr.contact_phone, u.phone, ''), ' ', '') LIKE ?))`);
    params.push(text.replace("#", ""), like, like, like, digits, `%${digits}%`);
  }
  const base = await rows(pool, `SELECT sr.id, sr.status, sr.service_type, sr.vehicle_type, sr.vehicle_model, sr.vehicle_brand, sr.address, sr.drop_address,
         sr.created_at, sr.completed_at, sr.payment_status, sr.payment_method AS request_payment_method,
         COALESCE(sr.final_price, sr.amount, sr.estimated_price) AS fare,
         sr.user_id, u.full_name AS customer_name, sr.technician_id, t.name AS technician_name, t.rating AS technician_rating,
         p.payment_method, p.status AS payment_state, p.amount AS paid_amount, p.technician_amount, p.refunded_amount
       FROM service_requests sr
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       LEFT JOIN payments p ON p.id = (SELECT MAX(p2.id) FROM payments p2 WHERE p2.service_request_id = sr.id)
       WHERE ${where.join(" AND ")}
       ORDER BY sr.created_at DESC
       LIMIT 5000`, params);
  const priorityRows = await rows(pool, "SELECT DISTINCT CAST(target_id AS UNSIGNED) AS id FROM admin_actions_log WHERE action_type IN ('markHighPriority', 'mark_high_priority')");
  const high = new Set(priorityRows.map((row) => Number(row.id)));
  let filtered = base;
  if (query.priority === "high") filtered = filtered.filter((row) => high.has(Number(row.id)));
  if (query.priority === "normal") filtered = filtered.filter((row) => !high.has(Number(row.id)));
  if (query.payment === "cash") filtered = filtered.filter((row) => lower(row.payment_method || row.request_payment_method) === "cash");
  if (query.payment === "online") filtered = filtered.filter((row) => (row.payment_method || row.request_payment_method) && lower(row.payment_method || row.request_payment_method) !== "cash");
  if (query.payment === "unpaid") filtered = filtered.filter((row) => !PAID_PAYMENT.includes(lower(row.payment_state)));
  const counts = Object.fromEntries(Object.entries(REQUEST_TABS).map(([key, test]) => [key, filtered.filter(test).length]));
  const inTab = filtered.filter(REQUEST_TABS[tab]);
  const pageRows = inTab.slice((page - 1) * limit, page * limit);
  const ids = pageRows.map((row) => row.id);
  const events = ids.length
    ? await rows(pool, `SELECT request_id, event_type, metadata, created_at FROM request_timeline WHERE request_id IN (${placeholders(ids)}) ORDER BY created_at ASC`, ids)
    : [];
  return {
    from: new Date(from).toISOString(), to: new Date(Math.min(to, now)).toISOString(),
    counts, total: inTab.length, page, limit, totalPages: Math.max(1, Math.ceil(inTab.length / limit)),
    rows: pageRows.map((row) => {
      const timeline = arrivalOf(events.filter((event) => Number(event.request_id) === Number(row.id)));
      const fare = numOrNull(row.fare);
      const technicianAmount = numOrNull(row.technician_amount);
      const paidAmount = numOrNull(row.paid_amount);
      return {
        id: row.id, status: row.status, phase: phaseOf(row.status), createdAt: iso(row.created_at), completedAt: iso(row.completed_at),
        service: row.service_type, vehicleType: row.vehicle_type, vehicleModel: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(" ") || null,
        area: row.address || null, drop: row.drop_address || null,
        customer: row.user_id ? { id: row.user_id, name: row.customer_name || null } : null,
        technician: row.technician_id ? { id: row.technician_id, name: row.technician_name || null, rating: numOrNull(row.technician_rating) } : null,
        ...timeline,
        fare, margin: paidAmount != null && technicianAmount != null ? Math.max(0, paidAmount - technicianAmount) : null,
        payment: {
          method: row.payment_method || row.request_payment_method || null, state: row.payment_state || row.payment_status || null,
          paid: PAID_PAYMENT.includes(lower(row.payment_state)), refunded: numOrNull(row.refunded_amount) || 0,
        },
        priority: high.has(Number(row.id)) ? "high" : "normal",
      };
    }),
  };
}

/** GET /technicians — who is on a job, on duty or offline now, with the last 30 days' numbers. */
export async function listTechnicians({ pool, query = {}, now = Date.now() }) {
  const since = now - 30 * DAY;
  const dayStart = istDayStart(now);
  const [techs, jobs, offers, reviews, sessions, dues, alerts, notes] = await Promise.all([
    rows(pool, `SELECT t.id, t.name, t.proprietor_name, t.phone, t.status, t.is_active, t.is_available, t.current_job_id, t.last_seen_at,
                       t.specialties, t.service_type, t.vehicle_types, t.rating, t.created_at, t.locality, t.region, t.admin_hidden,
                       sr.status AS job_status, sr.service_type AS job_service
                FROM technicians t LEFT JOIN service_requests sr ON sr.id = t.current_job_id
                WHERE LOWER(COALESCE(t.status, '')) = 'approved'`),
    rows(pool, `SELECT technician_id, id, status FROM service_requests WHERE technician_id IS NOT NULL AND created_at >= ?`, [new Date(since)]),
    rows(pool, "SELECT technician_id, status FROM dispatch_offers WHERE sent_at >= ?", [new Date(since)]),
    rows(pool, "SELECT technician_id, AVG(rating) AS rating, COUNT(*) AS n FROM reviews GROUP BY technician_id"),
    rows(pool, "SELECT technician_id, login_at, COALESCE(logout_at, last_seen_at) AS ended_at, logout_at FROM technician_login_sessions WHERE COALESCE(logout_at, last_seen_at, login_at) >= ?", [new Date(dayStart)]),
    rows(pool, "SELECT technician_id, SUM(amount) AS amount FROM technician_dues WHERE LOWER(COALESCE(status, 'pending')) = 'pending' GROUP BY technician_id"),
    rows(pool, "SELECT technician_id, reason_code, reason_text FROM job_monitoring_alerts WHERE is_active = 1"),
    rows(pool, "SELECT technician_id, metadata FROM technician_admin_notes WHERE note_type = 'visibility' ORDER BY id ASC"),
  ]);
  const jobIds = jobs.map((row) => row.id);
  const events = jobIds.length
    ? await rows(pool, `SELECT request_id, event_type, metadata, created_at FROM request_timeline WHERE request_id IN (${placeholders(jobIds)}) AND event_type IN ('accepted', 'arrived')`, jobIds)
    : [];
  const visibility = new Map();
  for (const row of notes) visibility.set(String(row.technician_id), parseJson(row.metadata, {})?.isVisible !== false);
  const by = (list) => {
    const map = new Map();
    for (const row of list) {
      const key = String(row.technician_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };
  const jobsBy = by(jobs);
  const offersBy = by(offers);
  const sessionsBy = by(sessions);
  const eventsBy = new Map();
  for (const event of events) {
    const key = String(event.request_id);
    if (!eventsBy.has(key)) eventsBy.set(key, []);
    eventsBy.get(key).push(event);
  }
  const reviewMap = new Map(reviews.map((row) => [String(row.technician_id), row]));
  const dueMap = new Map(dues.map((row) => [String(row.technician_id), num(row.amount)]));
  const alertMap = new Map(alerts.map((row) => [String(row.technician_id), row]));

  const list = techs.map((tech) => {
    const key = String(tech.id);
    const done = (jobsBy.get(key) || []).filter((row) => isDone(row.status));
    let onTime = 0;
    let judged = 0;
    for (const job of done) {
      const timeline = arrivalOf(eventsBy.get(String(job.id)) || []);
      if (timeline.lateMinutes == null) continue;
      judged += 1;
      if (timeline.lateMinutes <= 0) onTime += 1;
    }
    const sent = offersBy.get(key) || [];
    const accepted = sent.filter((row) => lower(row.status) === "accepted").length;
    const seconds = (sessionsBy.get(key) || []).reduce((total, row) => {
      const start = Math.max(dayStart, toMs(row.login_at) ?? dayStart);
      const end = Math.min(now, row.logout_at ? toMs(row.logout_at) : now);
      return total + Math.max(0, end - start);
    }, 0);
    const onDuty = Boolean(Number(tech.is_active));
    const alert = alertMap.get(key);
    const hidden = tech.admin_hidden != null ? Boolean(Number(tech.admin_hidden)) : visibility.get(key) === false;
    const specialties = parseJson(tech.specialties, []);
    return {
      id: tech.id, name: tech.name, owner: tech.proprietor_name || null, phoneMasked: maskPhone(tech.phone), area: tech.locality || tech.region || null,
      services: (Array.isArray(specialties) && specialties.length ? specialties : [tech.service_type]).filter(Boolean),
      vehicles: Object.entries(parseJson(tech.vehicle_types, {}) || {}).filter(([, on]) => on).map(([vehicle]) => canonicalizeVehicleFamily(vehicle) || vehicle),
      now: tech.current_job_id != null
        ? { state: "on_job", jobId: tech.current_job_id, jobStatus: tech.job_status || null, jobService: tech.job_service || null, alert: alert ? { code: alert.reason_code, text: alert.reason_text } : null }
        : onDuty ? { state: "free" } : { state: "offline", lastSeenAt: iso(tech.last_seen_at) },
      hidden,
      jobs30: done.length,
      onTimeRate: judged ? onTime / judged : null,
      rating: reviewMap.get(key) ? Number(Number(reviewMap.get(key).rating).toFixed(2)) : numOrNull(tech.rating),
      reviews: num(reviewMap.get(key)?.n),
      acceptRate: sent.length ? accepted / sent.length : null,
      offers30: sent.length,
      onDutyTodayMinutes: Math.round(seconds / 60_000),
      dues: dueMap.get(key) || 0,
      joinedAt: iso(tech.created_at),
    };
  });
  const needsLook = (row) => Boolean(row.now.alert) || (row.acceptRate != null && row.offers30 >= 5 && row.acceptRate < 0.7)
    || (row.onTimeRate != null && row.onTimeRate < 0.85) || row.dues >= 1000;
  const tabs = {
    all: () => true, on_duty: (row) => row.now.state !== "offline", on_job: (row) => row.now.state === "on_job",
    offline: (row) => row.now.state === "offline", hidden: (row) => row.hidden, needs_look: needsLook,
  };
  const tab = tabs[query.tab] ? query.tab : "all";
  const text = lower(query.search);
  const service = lower(query.service);
  let filtered = list;
  if (text) filtered = filtered.filter((row) => [row.name, row.owner, row.phoneMasked, row.area, String(row.id)].some((value) => lower(value).includes(text)));
  if (service) filtered = filtered.filter((row) => row.services.some((value) => lower(value).includes(service)));
  const order = { on_job: 0, free: 1, offline: 2 };
  const shown = filtered.filter(tabs[tab]).sort((a, b) => order[a.now.state] - order[b.now.state] || b.jobs30 - a.jobs30);
  const page = clampInt(query.page, 1, 1, 1000);
  const limit = clampInt(query.limit, 20, 5, 100);
  return {
    counts: Object.fromEntries(Object.entries(tabs).map(([key, test]) => [key, filtered.filter(test).length])),
    total: shown.length, page, limit, totalPages: Math.max(1, Math.ceil(shown.length / limit)),
    rows: shown.slice((page - 1) * limit, page * limit).map((row) => ({ ...row, needsLook: needsLook(row) })),
  };
}

/** GET /customers — everyone, with their requests, spend, plan and anything live. */
export async function listCustomers({ pool, query = {}, now = Date.now() }) {
  const [users, stats, live, vehicles] = await Promise.all([
    rows(pool, "SELECT id, full_name, email, phone, created_at, subscription, status FROM users WHERE LOWER(COALESCE(role, 'user')) NOT IN ('admin')"),
    rows(pool, `SELECT sr.user_id, COUNT(*) AS requests, MAX(sr.created_at) AS last_at,
                       SUM(CASE WHEN LOWER(COALESCE(p.status, '')) IN (${placeholders(PAID_PAYMENT)}) THEN p.amount ELSE 0 END) AS spent,
                       SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('cancelled', 'rejected') THEN 1 ELSE 0 END) AS cancelled
                FROM service_requests sr LEFT JOIN payments p ON p.service_request_id = sr.id
                GROUP BY sr.user_id`, PAID_PAYMENT),
    rows(pool, `SELECT user_id, id FROM service_requests WHERE LOWER(COALESCE(status, '')) IN (${placeholders(ACTIVE_STATUSES)})`, ACTIVE_STATUSES),
    rows(pool, "SELECT user_id, type FROM user_vehicles"),
  ]);
  const statMap = new Map(stats.map((row) => [String(row.user_id), row]));
  const liveMap = new Map(live.map((row) => [String(row.user_id), row.id]));
  const vehicleMap = new Map();
  for (const row of vehicles) {
    const key = String(row.user_id);
    if (!vehicleMap.has(key)) vehicleMap.set(key, []);
    vehicleMap.get(key).push(canonicalizeVehicleFamily(row.type) || lower(row.type) || "car");
  }
  const monthStart = now - 30 * DAY;
  const list = users.map((user) => {
    const stat = statMap.get(String(user.id));
    const plan = user.subscription && lower(user.subscription) !== "free" ? user.subscription : null;
    return {
      id: user.id, name: user.full_name || null, email: user.email || null, phoneMasked: maskPhone(user.phone), joinedAt: iso(user.created_at),
      plan, status: user.status || null, vehicles: vehicleMap.get(String(user.id)) || [],
      requests: num(stat?.requests), cancelled: num(stat?.cancelled), spent: num(stat?.spent), lastRequestAt: iso(stat?.last_at),
      liveRequestId: liveMap.get(String(user.id)) ?? null,
    };
  });
  const tabs = {
    all: () => true, active: (row) => row.lastRequestAt && Date.parse(row.lastRequestAt) >= monthStart,
    members: (row) => Boolean(row.plan), live: (row) => row.liveRequestId != null,
  };
  const tab = tabs[query.tab] ? query.tab : "all";
  const text = lower(query.search);
  let filtered = list;
  if (text) {
    const digits = text.replace(/\D/g, "");
    filtered = filtered.filter((row) => [row.name, row.email, String(row.id)].some((value) => lower(value).includes(text))
      || (digits.length >= 4 && users.find((user) => user.id === row.id)?.phone?.replace(/\D/g, "").includes(digits)));
  }
  const shown = filtered.filter(tabs[tab]).sort((a, b) => (Date.parse(b.joinedAt || 0) || 0) - (Date.parse(a.joinedAt || 0) || 0));
  const page = clampInt(query.page, 1, 1, 10_000);
  const limit = clampInt(query.limit, 20, 5, 100);
  return {
    counts: Object.fromEntries(Object.entries(tabs).map(([key, test]) => [key, filtered.filter(test).length])),
    joinedThisMonth: list.filter((row) => row.joinedAt && Date.parse(row.joinedAt) >= monthStart).length,
    total: shown.length, page, limit, totalPages: Math.max(1, Math.ceil(shown.length / limit)),
    rows: shown.slice((page - 1) * limit, page * limit),
  };
}

/** GET /customers/:id — profile, the live request, past requests, payments, vehicles and notes. */
export async function getCustomer({ pool, customerId }) {
  const [user] = await rows(pool, "SELECT id, full_name, email, phone, created_at, subscription, status, firebase_uid, password_hash FROM users WHERE id = ? LIMIT 1", [customerId]);
  if (!user) return null;
  const [requests, payments, vehicles, notes, reviews] = await Promise.all([
    rows(pool, `SELECT sr.id, sr.status, sr.service_type, sr.vehicle_type, sr.vehicle_model, sr.created_at, sr.completed_at,
                       COALESCE(sr.final_price, sr.amount, sr.estimated_price) AS fare, t.id AS technician_id, t.name AS technician_name
                FROM service_requests sr LEFT JOIN technicians t ON t.id = sr.technician_id
                WHERE sr.user_id = ? ORDER BY sr.created_at DESC LIMIT 50`, [customerId]),
    rows(pool, `SELECT id, service_request_id, payment_method, status, amount, razorpay_payment_id, refunded_amount, created_at
                FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [customerId]),
    rows(pool, "SELECT id, type, make, model, license_plate, status FROM user_vehicles WHERE user_id = ? ORDER BY id ASC", [customerId]),
    rows(pool, "SELECT id, admin_id, note, created_at FROM admin_customer_notes WHERE user_id = ? ORDER BY id DESC LIMIT 50", [customerId]),
    rows(pool, "SELECT service_request_id, rating FROM reviews WHERE user_id = ?", [customerId]),
  ]);
  const ratingMap = new Map(reviews.map((row) => [String(row.service_request_id), num(row.rating)]));
  const paid = payments.filter((row) => PAID_PAYMENT.includes(lower(row.status)));
  const live = requests.find((row) => isLive(row.status));
  return {
    id: user.id, name: user.full_name || null, email: user.email || null, phoneMasked: maskPhone(user.phone), phone: user.phone || null, joinedAt: iso(user.created_at),
    plan: user.subscription && lower(user.subscription) !== "free" ? user.subscription : null, status: user.status || null,
    signsInWith: user.firebase_uid ? "phone" : user.password_hash ? "email" : "google",
    live: live ? { id: live.id, status: live.status, phase: phaseOf(live.status), service: live.service_type, technician: live.technician_name || null } : null,
    totals: {
      requests: requests.length, cancelled: requests.filter((row) => isCancelled(row.status)).length,
      spent: paid.reduce((total, row) => total + num(row.amount), 0), paidJobs: paid.length,
      ratingGiven: reviews.length ? Number((reviews.reduce((total, row) => total + num(row.rating), 0) / reviews.length).toFixed(1)) : null, ratings: reviews.length,
    },
    requests: requests.map((row) => ({
      id: row.id, status: row.status, phase: phaseOf(row.status), service: row.service_type, vehicleType: row.vehicle_type, vehicleModel: row.vehicle_model,
      createdAt: iso(row.created_at), fare: numOrNull(row.fare), technician: row.technician_id ? { id: row.technician_id, name: row.technician_name } : null,
      rating: ratingMap.get(String(row.id)) ?? null,
    })),
    payments: payments.map((row) => ({ id: row.id, requestId: row.service_request_id, method: row.payment_method, status: row.status, amount: numOrNull(row.amount), refunded: numOrNull(row.refunded_amount) || 0, reference: row.razorpay_payment_id || null, at: iso(row.created_at) })),
    vehicles: vehicles.map((row) => ({ id: row.id, type: canonicalizeVehicleFamily(row.type) || lower(row.type), make: row.make || null, model: row.model || null, plate: row.license_plate || null })),
    notes: notes.map((row) => ({ id: row.id, by: row.admin_id || "admin", text: row.note, at: iso(row.created_at) })),
  };
}

export async function addCustomerNote({ pool, customerId, note, adminId }) {
  const text = String(note || "").trim().slice(0, 2000);
  if (!text) return { error: "Write a note first." };
  const [user] = await rows(pool, "SELECT id FROM users WHERE id = ? LIMIT 1", [customerId]);
  if (!user) return { notFound: true };
  await pool.query("INSERT INTO admin_customer_notes (user_id, admin_id, note) VALUES (?, ?, ?)", [customerId, adminId || "admin", text]);
  return { ok: true };
}

/** GET /reports?days= — requests, drop-offs, busy hours, service mix and cancellations, against the period before. */
export async function getReports({ pool, days = 30, now = Date.now() }) {
  const span = clampInt(days, 30, 7, 365);
  const end = now;
  const start = istDayStart(now) - (span - 1) * DAY;
  const prevStart = start - span * DAY;
  const [requests, payments, offers, events] = await Promise.all([
    rows(pool, "SELECT id, status, service_type, cancellation_reason, created_at FROM service_requests WHERE created_at >= ?", [new Date(prevStart)]),
    rows(pool, "SELECT service_request_id, status, amount, technician_amount, created_at FROM payments WHERE created_at >= ?", [new Date(prevStart)]),
    rows(pool, "SELECT DISTINCT service_request_id FROM dispatch_offers WHERE sent_at >= ?", [new Date(start)]),
    rows(pool, "SELECT request_id, event_type, metadata, created_at FROM request_timeline WHERE created_at >= ? AND event_type IN ('accepted', 'arrived')", [new Date(start)]),
  ]);
  const current = requests.filter((row) => (toMs(row.created_at) ?? 0) >= start);
  const previous = requests.filter((row) => { const ms = toMs(row.created_at) ?? 0; return ms >= prevStart && ms < start; });
  const paidNow = payments.filter((row) => PAID_PAYMENT.includes(lower(row.status)) && (toMs(row.created_at) ?? 0) >= start);
  const paidBefore = payments.filter((row) => PAID_PAYMENT.includes(lower(row.status)) && (toMs(row.created_at) ?? 0) < start);
  const total = (list, key) => list.reduce((sum, row) => sum + num(row[key]), 0);

  const perDay = Array.from({ length: span }, (_, index) => ({ date: new Date(start + index * DAY + IST).toISOString().slice(0, 10), completed: 0, cancelled: 0, other: 0 }));
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const mix = new Map();
  const reasons = new Map();
  for (const row of current) {
    const ms = toMs(row.created_at);
    const index = Math.floor((ms - start) / DAY);
    if (perDay[index]) perDay[index][isDone(row.status) ? "completed" : isCancelled(row.status) ? "cancelled" : "other"] += 1;
    heat[istWeekday(ms)][istHour(ms)] += 1;
    const domain = domainOf(row.service_type);
    mix.set(domain, (mix.get(domain) || 0) + 1);
    if (isCancelled(row.status)) {
      const reason = String(row.cancellation_reason || "").trim() || "No reason given";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }
  const byRequest = new Map();
  for (const event of events) {
    const key = String(event.request_id);
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key).push(event);
  }
  const arrivals = [];
  for (const list of byRequest.values()) {
    const accepted = list.find((event) => event.event_type === "accepted");
    const arrived = list.find((event) => event.event_type === "arrived");
    if (accepted && arrived) arrivals.push((toMs(arrived.created_at) - toMs(accepted.created_at)) / 60_000);
  }
  const currentIds = new Set(current.map((row) => String(row.id)));
  const acceptedIds = new Set(events.filter((event) => event.event_type === "accepted").map((event) => String(event.request_id)));
  const arrivedIds = new Set(events.filter((event) => event.event_type === "arrived").map((event) => String(event.request_id)));
  const paidIds = new Set(paidNow.map((row) => String(row.service_request_id)));
  const count = (set) => [...set].filter((id) => currentIds.has(id)).length;
  const completed = current.filter((row) => isDone(row.status)).length;
  const cancelled = current.filter((row) => isCancelled(row.status)).length;
  const prevCancelled = previous.filter((row) => isCancelled(row.status)).length;
  return {
    days: span, from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    kpis: {
      requests: current.length, previousRequests: previous.length,
      completed, completedRate: current.length ? completed / current.length : null,
      averageArrivalMinutes: arrivals.length ? arrivals.reduce((a, b) => a + b, 0) / arrivals.length : null,
      collected: total(paidNow, "amount"), previousCollected: total(paidBefore, "amount"),
      margin: Math.max(0, total(paidNow, "amount") - total(paidNow, "technician_amount")),
      cancelledRate: current.length ? cancelled / current.length : null,
      previousCancelledRate: previous.length ? prevCancelled / previous.length : null,
    },
    perDay,
    funnel: [
      { step: "requested", count: current.length },
      { step: "offered", count: offers.filter((row) => currentIds.has(String(row.service_request_id))).length },
      { step: "accepted", count: count(acceptedIds) },
      { step: "arrived", count: count(arrivedIds) },
      { step: "completed", count: completed },
      { step: "paid", count: count(paidIds) },
    ],
    busyHours: heat,
    serviceMix: [...mix.entries()].map(([service, n]) => ({ service, count: n })).sort((a, b) => b.count - a.count),
    cancellations: { total: cancelled, reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count).slice(0, 8) },
  };
}

/** GET /services/stats — for each service: technicians offering it, prices on file and requests in 30 days. */
export async function getServiceStats({ pool, now = Date.now() }) {
  const [services, techs, pricing, requests] = await Promise.all([
    rows(pool, "SELECT id, service_name, service_slug, active FROM service_master ORDER BY id ASC"),
    rows(pool, "SELECT id, specialties, service_type FROM technicians WHERE LOWER(COALESCE(status, '')) = 'approved'"),
    rows(pool, "SELECT technician_id, service_id, pricing_json FROM technician_service_pricing"),
    rows(pool, "SELECT service_type FROM service_requests WHERE created_at >= ?", [new Date(now - 30 * DAY)]),
  ]);
  const requestCounts = new Map();
  for (const row of requests) requestCounts.set(domainOf(row.service_type), (requestCounts.get(domainOf(row.service_type)) || 0) + 1);
  return services.map((service) => {
    const domain = domainOf(service.service_slug || service.service_name);
    const offering = techs.filter((tech) => {
      const list = parseJson(tech.specialties, []);
      return [...(Array.isArray(list) ? list : []), tech.service_type].some((value) => domainOf(value) === domain);
    }).length;
    const prices = [];
    for (const row of pricing.filter((item) => Number(item.service_id) === Number(service.id))) {
      const json = parseJson(row.pricing_json, {}) || {};
      for (const [key, value] of Object.entries(json)) {
        if (/distance|free_km|km$/i.test(key) || !Number.isFinite(Number(value)) || typeof value === "boolean") continue;
        if (["service_domain", "vehicle_type", "vehicle_subtype", "vehicle_subtype_label"].includes(key)) continue;
        prices.push(Number(value));
      }
    }
    return {
      id: service.id, name: service.service_name, slug: service.service_slug, domain, active: Boolean(Number(service.active ?? 1)),
      technicians: offering, priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
      requests30: requestCounts.get(domain) || 0,
    };
  });
}

/** GET /prices/medians — the middle price of approved technicians for each service, vehicle type, type and field. */
export async function getPriceMedians({ pool }) {
  const list = await rows(pool, `SELECT p.service_id, p.pricing_json FROM technician_service_pricing p
                                 JOIN technicians t ON t.id = p.technician_id WHERE LOWER(COALESCE(t.status, '')) = 'approved'`);
  const groups = new Map();
  for (const row of list) {
    const json = parseJson(row.pricing_json, {}) || {};
    const vehicle = json.vehicle_type || "";
    const subtype = json.vehicle_subtype || "";
    for (const [field, value] of Object.entries(json)) {
      if (["service_domain", "vehicle_type", "vehicle_subtype", "vehicle_subtype_label"].includes(field)) continue;
      if (value === "" || value == null || !Number.isFinite(Number(value))) continue;
      const key = [row.service_id, vehicle, subtype, field].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Number(value));
    }
  }
  return [...groups.entries()].map(([key, values]) => {
    const [serviceId, vehicleType, subtype, field] = key.split("|");
    const sorted = values.sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    return { serviceId: Number(serviceId), vehicleType, subtype, field, median, technicians: sorted.length };
  });
}

/** GET /cash-dues — ResQNow's share of cash jobs, waiting to be collected, per technician. */
export async function getCashDues({ pool }) {
  const list = await rows(pool, `SELECT d.technician_id, t.name, t.phone, COUNT(*) AS jobs, SUM(d.amount) AS amount, MIN(d.created_at) AS oldest
                                 FROM technician_dues d LEFT JOIN technicians t ON t.id = d.technician_id
                                 WHERE LOWER(COALESCE(d.status, 'pending')) = 'pending'
                                 GROUP BY d.technician_id, t.name, t.phone ORDER BY amount DESC`);
  return list.map((row) => ({ technicianId: row.technician_id, name: row.name || null, phoneMasked: maskPhone(row.phone), jobs: num(row.jobs), amount: num(row.amount), oldest: iso(row.oldest) }));
}

/** GET /alerts/handled — alerts closed today, and what an admin did about each. */
export async function getHandledAlerts({ pool, now = Date.now() }) {
  const dayStart = istDayStart(now);
  const resolved = await rows(pool, `SELECT a.id, a.service_request_id, a.reason_code, a.reason_text, a.first_detected_at, a.resolved_at, t.name AS technician_name
                                     FROM job_monitoring_alerts a LEFT JOIN technicians t ON t.id = a.technician_id
                                     WHERE a.is_active = 0 AND a.resolved_at >= ? ORDER BY a.resolved_at DESC LIMIT 100`, [new Date(dayStart)]);
  const ids = [...new Set(resolved.map((row) => String(row.service_request_id)))];
  const actions = ids.length
    ? await rows(pool, `SELECT admin_id, action_type, target_id, metadata, created_at FROM admin_actions_log
                        WHERE target_type IN ('service_request', 'request') AND target_id IN (${placeholders(ids)}) AND created_at >= ? ORDER BY created_at ASC`, [...ids, new Date(dayStart)])
    : [];
  return resolved.map((row) => {
    const mine = actions.filter((action) => String(action.target_id) === String(row.service_request_id)
      && (toMs(action.created_at) ?? 0) >= (toMs(row.first_detected_at) ?? 0) && (toMs(action.created_at) ?? 0) <= (toMs(row.resolved_at) ?? now) + 60_000);
    return {
      id: row.id, requestId: row.service_request_id, code: row.reason_code, text: row.reason_text, technician: row.technician_name || null,
      flaggedAt: iso(row.first_detected_at), resolvedAt: iso(row.resolved_at),
      actions: mine.map((action) => ({ type: action.action_type, by: action.admin_id, at: iso(action.created_at) })),
    };
  });
}

const AUDIT_GROUPS = {
  requests: ["manualAssignTechnician", "forceAssign", "escalateRequest", "markHighPriority", "mark_high_priority", "manualCloseRequest", "overrideRequestPricing", "addInternalNote", "reRouteSearchRadius"],
  technicians: ["toggleTechnicianVisibility", "sendTechnicianLoginReminder", "adminNoteOnTechnician", "updateTechnicianProfile"],
  complaints: ["createComplaint", "assignComplaint", "resolveComplaint", "addComplaintInternalNote"],
  messages: ["systemAnnouncement", "technicianBroadcast", "emergencyMessage", "broadcastNotification"],
};

/** GET /audit — every recorded admin action, newest first, by group and date. */
export async function listAudit({ pool, query = {}, now = Date.now() }) {
  const days = clampInt(query.days, 7, 1, 366);
  const since = istDayStart(now) - (days - 1) * DAY;
  const list = await rows(pool, "SELECT id, admin_id, action_type, target_type, target_id, metadata, created_at FROM admin_actions_log WHERE created_at >= ? ORDER BY id DESC LIMIT 5000", [new Date(since)]);
  const groupOf = (type) => {
    const plain = String(type || "").replace(/^adminExtended\.[a-z]+\./i, "");
    return Object.entries(AUDIT_GROUPS).find(([, types]) => types.includes(plain))?.[0] || "other";
  };
  const text = lower(query.search);
  const enriched = list.map((row) => ({
    id: row.id, by: row.admin_id || "admin", type: String(row.action_type || "").replace(/^adminExtended\.[a-z]+\./i, ""), group: groupOf(row.action_type),
    targetType: row.target_type || null, targetId: row.target_id ?? null, metadata: parseJson(row.metadata, null), at: iso(row.created_at),
  }));
  const searched = text ? enriched.filter((row) => [row.type, row.targetId, JSON.stringify(row.metadata || {}), row.by].some((value) => lower(value).includes(text))) : enriched;
  const counts = { all: searched.length };
  for (const group of [...Object.keys(AUDIT_GROUPS), "other"]) counts[group] = searched.filter((row) => row.group === group).length;
  const group = query.group && counts[query.group] != null ? query.group : "all";
  const shown = group === "all" ? searched : searched.filter((row) => row.group === group);
  const page = clampInt(query.page, 1, 1, 10_000);
  const limit = clampInt(query.limit, 25, 5, 100);
  return { days, counts, total: shown.length, page, limit, totalPages: Math.max(1, Math.ceil(shown.length / limit)), rows: shown.slice((page - 1) * limit, page * limit) };
}

export async function markAllNotificationsRead({ pool }) {
  const values = [...ADMIN_NOTIFICATION_TYPE_FILTER_VALUES];
  await pool.query(`UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND LOWER(COALESCE(type, '')) IN (${placeholders(values)})`, values);
  return { ok: true };
}

/** GET /technicians/:id/payouts — the wallet, withdrawal requests and payouts of one technician. */
export async function getTechnicianPayouts({ pool, technicianId }) {
  const [wallet, requests, payouts, dues] = await Promise.all([
    rows(pool, "SELECT total_earned, withdrawable_balance, total_paid_out, on_hold_balance, last_transaction_at FROM technician_wallets WHERE technician_id = ? LIMIT 1", [technicianId]),
    rows(pool, "SELECT id, amount, status, upi_id, rejection_reason, external_reference, created_at, paid_at FROM withdrawal_requests WHERE technician_id = ? ORDER BY created_at DESC LIMIT 50", [technicianId]),
    rows(pool, "SELECT id, amount, status, payout_method, external_reference, destination_reference, processed_at, created_at FROM payouts WHERE technician_id = ? ORDER BY created_at DESC LIMIT 50", [technicianId]),
    rows(pool, "SELECT id, service_request_id, amount, status, created_at FROM technician_dues WHERE technician_id = ? ORDER BY created_at DESC LIMIT 50", [technicianId]),
  ]);
  const w = wallet[0] || {};
  return {
    wallet: { totalEarned: num(w.total_earned), withdrawable: num(w.withdrawable_balance), paidOut: num(w.total_paid_out), onHold: num(w.on_hold_balance), lastActivityAt: iso(w.last_transaction_at) },
    requests: requests.map((row) => ({ id: row.id, amount: num(row.amount), status: row.status, upi: row.upi_id || null, reason: row.rejection_reason || null, utr: row.external_reference || null, at: iso(row.created_at), paidAt: iso(row.paid_at) })),
    payouts: payouts.map((row) => ({ id: row.id, amount: num(row.amount), status: row.status, method: row.payout_method || null, utr: row.external_reference || null, to: row.destination_reference || null, at: iso(row.processed_at || row.created_at) })),
    dues: dues.map((row) => ({ id: row.id, requestId: row.service_request_id, amount: num(row.amount), status: row.status, at: iso(row.created_at) })),
  };
}

export const __test__ = { arrivalOf, domainOf, AUDIT_GROUPS };
