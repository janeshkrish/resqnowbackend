import { recordId } from "../models/identifiers.js";
import { istDayStart } from "./istTime.js";
import { normalizeRequestStatus } from "./requestStatusWorkflow.js";
import { titleForEvent } from "./requestEvents.js";

// What the admin Requests list, the Monitor panel, Replay and the technician record show.
// Everything here is read from the database, the live-tracking store and the shared ETA
// cache; nothing is invented. Values that are not recorded yet come back as null.

const ACTIVE_STATUSES = [
  "pending", "assigned", "technician_assigned", "accepted", "processing",
  "on-the-way", "on_the_way", "en-route", "en_route", "en_route_pickup",
  "arrived", "arrived_pickup", "service_started", "in-progress", "in_progress",
  "vehicle_loaded", "enroute_drop", "arrived_drop",
  "service_completed", "awaiting_payment", "payment_pending",
];
const DONE_STATUSES = ["completed", "paid", "closed"];
const STALE_GPS_MS = 2 * 60_000;

const PHASES = Object.freeze({
  pending: "finding", processing: "finding", assigned: "offered", technician_assigned: "offered",
  accepted: "accepted",
  "on-the-way": "on_the_way", on_the_way: "on_the_way", "en-route": "on_the_way", en_route: "on_the_way", en_route_pickup: "on_the_way",
  arrived: "arrived", arrived_pickup: "arrived",
  service_started: "working", "in-progress": "working", in_progress: "working", vehicle_loaded: "working",
  enroute_drop: "towing", arrived_drop: "working",
  service_completed: "payment_due", awaiting_payment: "payment_due", payment_pending: "payment_due",
  completed: "done", paid: "done", closed: "done",
  cancelled: "cancelled", rejected: "cancelled",
});

// Four steps, as the customer sees them: accepted, on the way, arrived, work done.
const STEPS = Object.freeze({
  finding: { done: 0, now: 0 }, offered: { done: 0, now: 0 }, accepted: { done: 1, now: 1 }, on_the_way: { done: 1, now: 1 },
  arrived: { done: 2, now: 2 }, working: { done: 3, now: 3 }, towing: { done: 3, now: 3 }, payment_due: { done: 4, now: -1 },
  done: { done: 4, now: -1 }, cancelled: { done: 0, now: -1 },
});

export function phaseOf(status) {
  const raw = String(status || "").trim().toLowerCase();
  const normalized = normalizeRequestStatus(raw) || raw;
  return PHASES[normalized] || PHASES[raw] || "finding";
}

export function stepsOf(phase) {
  return STEPS[phase] || STEPS.finding;
}

const toNumber = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const parseJson = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const round = (n, places = 1) => (n == null ? null : Math.round(n * 10 ** places) / 10 ** places);
const minutesBetween = (from, to) => {
  const a = from ? new Date(from).getTime() : NaN;
  const b = to ? new Date(to).getTime() : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60_000 : null;
};

/** "+91 98••• ••210" — enough to recognise, not enough to copy. */
export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 6) return digits ? "••••" : null;
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return `+91 ${local.slice(0, 2)}••• ••${local.slice(-3)}`;
}

export function haversineKm(a, b) {
  const lat1 = toNumber(a?.lat);
  const lng1 = toNumber(a?.lng);
  const lat2 = toNumber(b?.lat);
  const lng2 = toNumber(b?.lng);
  if ([lat1, lng1, lat2, lng2].some((n) => n == null)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const placeholders = (list) => list.map(() => "?").join(", ");

function money(row) {
  return toNumber(row.final_price) ?? toNumber(row.amount) ?? toNumber(row.estimated_price);
}

function latestBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row[key]);
    const prev = map.get(id);
    if (!prev || new Date(row.created_at || row.recorded_at || 0) >= new Date(prev.created_at || prev.recorded_at || 0)) map.set(id, row);
  }
  return map;
}

/** Last known technician position for a request: the live store first, history second. */
async function livePositions(pool, rows, runtime) {
  const result = new Map();
  const store = runtime?.store;
  await Promise.all(rows.map(async (row) => {
    if (!row.technician_id || !store || typeof store.getForRequest !== "function") return;
    try {
      const snap = await store.getForRequest(String(row.technician_id), String(row.id));
      if (snap && toNumber(snap.lat) != null && toNumber(snap.lng) != null) {
        result.set(String(row.id), {
          lat: Number(snap.lat), lng: Number(snap.lng),
          at: toIso(snap.recordedAt || snap.locationUpdatedAt || snap.receivedAt),
          speedMps: toNumber(snap.speed ?? snap.speedMps), heading: toNumber(snap.heading),
          source: "live",
        });
      }
    } catch {
      // The store is optional here; history below covers it.
    }
  }));
  const missing = rows.filter((row) => row.technician_id && !result.has(String(row.id))).map((row) => row.id);
  if (missing.length) {
    const [hist] = await pool.query(
      `SELECT h.service_request_id, h.latitude, h.longitude, h.recorded_at, h.speed_mps, h.heading_degrees
       FROM technician_location_history h
       JOIN (SELECT service_request_id, id FROM (SELECT service_request_id, id, ROW_NUMBER() OVER (PARTITION BY service_request_id ORDER BY captured_at DESC, id DESC) AS uuid_rank FROM technician_location_history
             WHERE service_request_id IN (${placeholders(missing)})) ranked_locations WHERE uuid_rank = 1) last ON last.id = h.id`,
      missing
    );
    for (const h of hist) {
      result.set(String(h.service_request_id), {
        lat: Number(h.latitude), lng: Number(h.longitude), at: toIso(h.recorded_at),
        speedMps: toNumber(h.speed_mps), heading: toNumber(h.heading_degrees), source: "history",
      });
    }
  }
  return result;
}

async function cachedEtas(rows, runtime) {
  const result = new Map();
  const reader = runtime?.trafficEta?.readCachedEta;
  if (typeof reader !== "function") return result;
  await Promise.all(rows.map(async (row) => {
    try {
      const eta = await reader(String(row.id));
      if (eta && toNumber(eta.etaSeconds) != null) result.set(String(row.id), eta);
    } catch {
      // No cached ETA: the distance is shown instead.
    }
  }));
  return result;
}

function liveFields(row, position, eta, now) {
  const customer = { lat: toNumber(row.location_lat), lng: toNumber(row.location_lng) };
  const lastSeenAt = position?.at || null;
  const seenAgoMs = lastSeenAt ? now - new Date(lastSeenAt).getTime() : null;
  const straightKm = position ? haversineKm(position, customer) : null;
  const etaFresh = eta && (!eta.calculatedAt || now - new Date(eta.calculatedAt).getTime() < 10 * 60_000);
  return {
    lat: position?.lat ?? null,
    lng: position?.lng ?? null,
    heading: position?.heading ?? null,
    speedKmh: position?.speedMps == null ? null : round(position.speedMps * 3.6, 0),
    lastSeenAt,
    gpsStale: seenAgoMs != null && seenAgoMs > STALE_GPS_MS,
    etaSeconds: etaFresh ? Number(eta.etaSeconds) : null,
    etaCalculatedAt: etaFresh ? toIso(eta.calculatedAt) : null,
    trafficAware: Boolean(etaFresh && eta.trafficAware),
    distanceKm: etaFresh && toNumber(eta.distanceMeters) != null ? round(Number(eta.distanceMeters) / 1000, 1) : round(straightKm, 1),
    distanceSource: etaFresh && toNumber(eta.distanceMeters) != null ? "route" : straightKm == null ? null : "straight",
  };
}

const ALERT_LEVEL = { high: 3, critical: 3, medium: 2, low: 1 };

function summarise(row, extras, now) {
  const phase = phaseOf(row.status);
  const steps = stepsOf(phase);
  const accepted = extras.accepted.get(String(row.id));
  const acceptedMeta = parseJson(accepted?.metadata, {}) || {};
  const arrived = extras.arrived.get(String(row.id));
  const alerts = (extras.alerts.get(String(row.id)) || [])
    .map((a) => ({ code: a.reason_code, text: a.reason_text, level: String(a.risk_level || "medium").toLowerCase(), since: toIso(a.first_detected_at), etaMinutes: toNumber(a.eta_minutes) }))
    .sort((a, b) => (ALERT_LEVEL[b.level] || 0) - (ALERT_LEVEL[a.level] || 0));
  const offers = extras.offers.get(String(row.id)) || { sent: 0, declined: 0, expired: 0, pending: 0, accepted: 0 };
  const live = row.technician_id && ["accepted", "on_the_way", "arrived", "working", "towing"].includes(phase)
    ? liveFields(row, extras.positions.get(String(row.id)), extras.etas.get(String(row.id)), now)
    : null;
  const promisedAt = acceptedMeta.promisedAt || toIso(row.sla_deadline);
  return {
    id: recordId(row.id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    status: row.status,
    phase,
    steps,
    serviceType: row.service_type,
    vehicleType: row.vehicle_type || null,
    vehicleModel: [row.vehicle_brand, row.vehicle_model].filter(Boolean).join(" ") || null,
    customer: { id: row.user_id == null ? null : recordId(row.user_id), name: row.contact_name || row.user_name || "Customer", phoneMasked: maskPhone(row.contact_phone || row.user_phone) },
    technician: row.technician_id
      ? { id: recordId(row.technician_id), name: row.technician_name || `Technician #${row.technician_id}`, rating: toNumber(row.technician_rating), serviceType: row.technician_service_type || null }
      : null,
    address: row.address || null,
    location: { lat: toNumber(row.location_lat), lng: toNumber(row.location_lng) },
    drop: row.drop_latitude == null ? null : { lat: toNumber(row.drop_latitude), lng: toNumber(row.drop_longitude), address: row.drop_address || null },
    fare: money(row),
    paymentMethod: row.payment_method || null,
    paymentStatus: row.payment_status || null,
    acceptedAt: toIso(row.accepted_time) || toIso(accepted?.created_at),
    promisedAt,
    promiseSource: acceptedMeta.promisedAt ? "accepted" : row.sla_deadline ? "sla" : null,
    arrivedAt: toIso(arrived?.created_at),
    workStartedAt: toIso(row.started_at) || toIso(row.start_time),
    completedAt: toIso(row.completed_at),
    search: { ...offers, startedAt: toIso(row.created_at) },
    alerts,
    live,
  };
}

async function loadExtras(pool, rows, runtime) {
  const ids = rows.map((r) => r.id);
  const empty = { accepted: new Map(), arrived: new Map(), alerts: new Map(), offers: new Map(), positions: new Map(), etas: new Map() };
  if (!ids.length) return empty;
  const [timeline] = await pool.query(
    `SELECT request_id, event_type, metadata, created_at FROM request_timeline
     WHERE request_id IN (${placeholders(ids)}) AND event_type IN ('accepted', 'arrived')`,
    ids
  );
  const [alerts] = await pool.query(
    `SELECT service_request_id, reason_code, reason_text, risk_level, eta_minutes, first_detected_at
     FROM job_monitoring_alerts WHERE is_active = 1 AND service_request_id IN (${placeholders(ids)})`,
    ids
  );
  const [offers] = await pool.query(
    `SELECT service_request_id, status, COUNT(*) AS n FROM dispatch_offers
     WHERE service_request_id IN (${placeholders(ids)}) GROUP BY service_request_id, status`,
    ids
  );
  const offerMap = new Map();
  for (const o of offers) {
    const key = String(o.service_request_id);
    const entry = offerMap.get(key) || { sent: 0, declined: 0, expired: 0, pending: 0, accepted: 0 };
    const n = Number(o.n) || 0;
    entry.sent += n;
    if (o.status === "rejected") entry.declined += n;
    else if (o.status === "expired") entry.expired += n;
    else if (o.status === "pending") entry.pending += n;
    else if (o.status === "accepted") entry.accepted += n;
    offerMap.set(key, entry);
  }
  const alertMap = new Map();
  for (const a of alerts) {
    const key = String(a.service_request_id);
    alertMap.set(key, [...(alertMap.get(key) || []), a]);
  }
  const [positions, etas] = await Promise.all([livePositions(pool, rows, runtime), cachedEtas(rows, runtime)]);
  return {
    accepted: latestBy(timeline.filter((t) => t.event_type === "accepted"), "request_id"),
    arrived: latestBy(timeline.filter((t) => t.event_type === "arrived"), "request_id"),
    alerts: alertMap,
    offers: offerMap,
    positions,
    etas,
  };
}

const REQUEST_COLUMNS = `
  sr.id, sr.user_id, sr.technician_id, sr.status, sr.service_type, sr.vehicle_type, sr.vehicle_model, sr.vehicle_brand,
  sr.address, sr.location_lat, sr.location_lng, sr.drop_address, sr.drop_latitude, sr.drop_longitude,
  sr.contact_name, sr.contact_phone, sr.amount, sr.final_price, sr.estimated_price, sr.payment_method, sr.payment_status,
  sr.created_at, sr.updated_at, sr.accepted_time, sr.started_at, sr.start_time, sr.completed_at, sr.cancelled_at,
  sr.cancellation_reason, sr.sla_deadline, sr.route_distance_km, sr.pricing_breakdown_json,
  u.full_name AS user_name, u.phone AS user_phone,
  t.name AS technician_name, t.rating AS technician_rating, t.service_type AS technician_service_type`;

/** GET /api/admin/monitor/live — every live request with its live line, and today's numbers. */
export async function getLiveRequests({ pool, runtime = null, now = Date.now() }) {
  const [rows] = await pool.query(
    `SELECT ${REQUEST_COLUMNS}
     FROM service_requests sr
     LEFT JOIN users u ON u.id = sr.user_id
     LEFT JOIN technicians t ON t.id = sr.technician_id
     WHERE LOWER(COALESCE(sr.status, '')) IN (${placeholders(ACTIVE_STATUSES)})
     ORDER BY sr.created_at DESC
     LIMIT 200`,
    ACTIVE_STATUSES
  );
  const extras = await loadExtras(pool, rows, runtime);
  const requests = rows.map((row) => summarise(row, extras, now));

  const startOfDay = new Date(istDayStart(now));
  const [[today]] = await pool.query(
    `SELECT
       SUM(CASE WHEN completed_at >= ? AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected') THEN 1 ELSE 0 END) AS completed,
       AVG(CASE WHEN created_at >= ? AND accepted_time IS NOT NULL THEN TIMESTAMPDIFF(SECOND, created_at, accepted_time) END) AS accept_seconds
     FROM service_requests
     WHERE created_at >= ? OR completed_at >= ?`,
    [startOfDay, startOfDay, startOfDay, startOfDay]
  );
  const [arrivals] = await pool.query(
    `SELECT a.request_id, a.created_at AS arrived_at, sr.accepted_time
     FROM request_timeline a JOIN service_requests sr ON sr.id = a.request_id
     WHERE a.event_type = 'arrived' AND a.created_at >= ?`,
    [startOfDay]
  );
  const arrivalMinutes = arrivals.map((a) => minutesBetween(a.accepted_time, a.arrived_at)).filter((m) => m != null && m >= 0);
  const needsAttention = requests.filter((r) => r.alerts.length || r.live?.gpsStale || (r.promisedAt && !r.arrivedAt && ["accepted", "on_the_way"].includes(r.phase) && new Date(r.promisedAt).getTime() < now)).length;
  return {
    generatedAt: new Date(now).toISOString(),
    kpis: {
      live: requests.length,
      finding: requests.filter((r) => r.phase === "finding" || r.phase === "offered").length,
      needsAttention,
      acceptSecondsToday: today?.accept_seconds == null ? null : Math.round(Number(today.accept_seconds)),
      arrivalMinutesToday: arrivalMinutes.length ? round(arrivalMinutes.reduce((a, b) => a + b, 0) / arrivalMinutes.length, 0) : null,
      arrivalsMeasuredToday: arrivalMinutes.length,
      completedToday: Number(today?.completed || 0),
    },
    requests,
  };
}

const ADMIN_ACTION_TITLES = {
  manualAssignTechnician: "Admin assigned a technician",
  assignRequest: "Admin assigned a technician",
  escalateRequest: "Admin widened the search",
  markHighPriority: "Marked high priority",
  closeRequest: "Admin closed the request",
  overridePricing: "Admin changed the fare",
  remind_technician: "Admin reminded the technician",
  call_technician: "Admin called the technician",
  reassign_request: "Admin reassigned the job",
};

/** The full story of one request, newest first: recorded events, offers, alerts and admin actions. */
export function buildTimeline({ request, timeline = [], offers = [], alerts = [], actions = [] }) {
  const items = [];
  const seen = new Set();
  for (const t of timeline) {
    const meta = parseJson(t.metadata, {}) || {};
    seen.add(t.event_type);
    items.push({
      at: toIso(t.created_at), kind: t.event_type, title: t.title || titleForEvent(t.event_type), description: t.description || null,
      actorType: t.actor_type || null, actorId: t.actor_id || null, meta, source: "timeline",
    });
  }
  // Older requests have no recorded events: their stored times stand in.
  const derived = [
    ["created", request.created_at, "Request sent"],
    ["accepted", request.accepted_time, "Accepted"],
    ["work_started", request.started_at || request.start_time, "Work started"],
    ["work_done", request.completed_at, "Work done"],
    ["cancelled", request.cancelled_at, "Cancelled"],
  ];
  for (const [kind, at, title] of derived) {
    if (at && !seen.has(kind)) items.push({ at: toIso(at), kind, title, description: kind === "cancelled" ? request.cancellation_reason || null : null, actorType: null, actorId: null, meta: {}, source: "stored" });
  }
  for (const o of offers) {
    items.push({ at: toIso(o.sent_at), kind: "offer", title: `Offered to ${o.technician_name || `technician #${o.technician_id}`}`, description: null, actorType: "system", actorId: null, meta: { technicianId: recordId(o.technician_id), result: o.status }, source: "offers" });
  }
  for (const a of alerts) {
    items.push({ at: toIso(a.first_detected_at), kind: "alert", title: a.reason_text || a.reason_code, description: a.resolved_at ? `Cleared ${toIso(a.resolved_at)}` : null, actorType: "system", actorId: null, meta: { code: a.reason_code, level: a.risk_level, active: Boolean(a.is_active) }, source: "alerts" });
  }
  const timelineAdminKinds = new Set(["technician_assigned", "escalated", "high_priority", "fare_overridden", "completed", "cancelled"]);
  for (const a of actions) {
    const meta = parseJson(a.metadata, {}) || {};
    const kind = String(a.action_type || "admin_action");
    if (["manualAssignTechnician", "escalateRequest", "markHighPriority", "closeRequest", "overridePricing"].includes(kind) && [...seen].some((s) => timelineAdminKinds.has(s))) continue;
    items.push({ at: toIso(a.created_at), kind: "admin_action", title: ADMIN_ACTION_TITLES[kind] || kind.replace(/[_-]+/g, " "), description: meta.note || meta.reason || null, actorType: "admin", actorId: a.admin_id || null, meta, source: "actions" });
  }
  return items.filter((i) => i.at).sort((a, b) => new Date(b.at) - new Date(a.at));
}

function billFrom(row) {
  const breakdown = parseJson(row.pricing_breakdown_json, {}) || {};
  const total = money(row);
  const base = toNumber(breakdown.baseAmount ?? breakdown.base_amount ?? breakdown.technicianAmount ?? breakdown.serviceCharge);
  const fee = toNumber(breakdown.platformFee ?? breakdown.platform_fee);
  return { total, base, platformFee: fee, paymentMethod: row.payment_method || null, paymentStatus: row.payment_status || null };
}

/** GET /api/admin/monitor/requests/:id — one request for the Monitor panel. */
export async function getRequestMonitor({ pool, requestId, runtime = null, now = Date.now() }) {
  const [rows] = await pool.query(
    `SELECT ${REQUEST_COLUMNS}, t.phone AS technician_phone, t.jobs_completed AS technician_jobs, t.latitude AS technician_lat, t.longitude AS technician_lng
     FROM service_requests sr
     LEFT JOIN users u ON u.id = sr.user_id
     LEFT JOIN technicians t ON t.id = sr.technician_id
     WHERE sr.id = ? LIMIT 1`,
    [requestId]
  );
  const row = rows[0];
  if (!row) return null;
  const extras = await loadExtras(pool, [row], runtime);
  const summary = summarise(row, extras, now);
  const [[timeline], [offers], [alerts], [actions], [trail], [customerCount]] = await Promise.all([
    pool.query(`SELECT event_type, status, title, description, actor_type, actor_id, metadata, created_at FROM request_timeline WHERE request_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`, [requestId]),
    pool.query(`SELECT o.technician_id, o.status, o.sent_at, o.expires_at, t.name AS technician_name FROM dispatch_offers o LEFT JOIN technicians t ON t.id = o.technician_id WHERE o.service_request_id = ? ORDER BY o.sent_at ASC, o.id ASC LIMIT 50`, [requestId]),
    pool.query(`SELECT reason_code, reason_text, risk_level, is_active, first_detected_at, resolved_at FROM job_monitoring_alerts WHERE service_request_id = ? ORDER BY first_detected_at DESC LIMIT 50`, [requestId]),
    pool.query(`SELECT admin_id, action_type, metadata, created_at FROM admin_actions_log WHERE source = 'action' AND target_type IN ('service_request', 'request') AND target_id = ? ORDER BY created_at DESC LIMIT 50`, [String(requestId)]).catch(() => [[]]),
    pool.query(`SELECT latitude, longitude, recorded_at FROM technician_location_history WHERE service_request_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 300`, [requestId]),
    row.user_id == null ? Promise.resolve([[{ n: 0 }]]) : pool.query(`SELECT COUNT(*) AS n FROM service_requests WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))`, [row.user_id, row.created_at, row.created_at, requestId]),
  ]);
  return {
    ...summary,
    customer: { ...summary.customer, phone: row.contact_phone || row.user_phone || null, requestNumber: Number(customerCount?.[0]?.n || 0) || null },
    technician: summary.technician
      ? { ...summary.technician, phone: row.technician_phone || null, phoneMasked: maskPhone(row.technician_phone), jobsCompleted: toNumber(row.technician_jobs) }
      : null,
    bill: billFrom(row),
    cancellationReason: row.cancellation_reason || null,
    timeline: buildTimeline({ request: row, timeline, offers, alerts, actions }),
    offers: offers.map((o) => ({ technicianId: recordId(o.technician_id), name: o.technician_name || `Technician #${o.technician_id}`, result: o.status, sentAt: toIso(o.sent_at) })),
    trail: trail.slice().reverse().map((p) => ({ lat: Number(p.latitude), lng: Number(p.longitude), at: toIso(p.recorded_at) })),
  };
}

/** GET /api/admin/monitor/requests/:id/replay — a finished job, start to end. */
export async function getRequestReplay({ pool, requestId }) {
  const detail = await getRequestMonitor({ pool, requestId });
  if (!detail) return null;
  const [points] = await pool.query(
    `SELECT latitude, longitude, recorded_at, speed_mps FROM technician_location_history WHERE service_request_id = ? ORDER BY recorded_at ASC, id ASC LIMIT 5000`,
    [requestId]
  );
  const trail = points.map((p) => ({ lat: Number(p.latitude), lng: Number(p.longitude), at: toIso(p.recorded_at), speedKmh: toNumber(p.speed_mps) == null ? null : round(Number(p.speed_mps) * 3.6, 0) }));
  let km = 0;
  for (let i = 1; i < trail.length; i++) km += haversineKm(trail[i - 1], trail[i]) || 0;
  const [reviews] = await pool.query(`SELECT rating, comment FROM reviews WHERE service_request_id = ? ORDER BY created_at DESC LIMIT 1`, [requestId]);
  const lateMinutes = detail.promisedAt && detail.arrivedAt ? round(minutesBetween(detail.promisedAt, detail.arrivedAt), 0) : null;
  return {
    ...detail,
    trail,
    summary: {
      promisedAt: detail.promisedAt,
      arrivedAt: detail.arrivedAt,
      lateMinutes,
      distanceKm: trail.length > 1 ? round(km, 1) : null,
      workMinutes: detail.workStartedAt && detail.completedAt ? round(minutesBetween(detail.workStartedAt, detail.completedAt), 0) : null,
      rating: reviews[0] ? toNumber(reviews[0].rating) : null,
      ratingComment: reviews[0]?.comment || null,
    },
  };
}

// ---------------------------------------------------------------- technician record

function isoWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d;
}

/** Arrival records for one technician: accepted → arrived, judged against the promise. */
async function arrivalRows(pool, technicianId, sinceDate) {
  const [rows] = await pool.query(
    `SELECT a.request_id, a.created_at AS arrived_at, sr.accepted_time, sr.service_type, sr.sla_deadline,
            (SELECT acc.metadata FROM request_timeline acc WHERE acc.request_id = a.request_id AND acc.event_type = 'accepted' ORDER BY acc.created_at DESC LIMIT 1) AS accepted_meta,
            (SELECT acc.created_at FROM request_timeline acc WHERE acc.request_id = a.request_id AND acc.event_type = 'accepted' ORDER BY acc.created_at DESC LIMIT 1) AS accepted_at
     FROM request_timeline a JOIN service_requests sr ON sr.id = a.request_id
     WHERE a.event_type = 'arrived' AND a.actor_id = ? AND a.created_at >= ?
     ORDER BY a.created_at DESC`,
    [String(technicianId), sinceDate]
  );
  return rows.map((r) => {
    const meta = parseJson(r.accepted_meta, {}) || {};
    const promisedAt = meta.promisedAt || toIso(r.sla_deadline);
    const late = promisedAt ? minutesBetween(promisedAt, r.arrived_at) : null;
    return {
      requestId: recordId(r.request_id),
      serviceType: r.service_type,
      acceptedAt: toIso(r.accepted_at) || toIso(r.accepted_time),
      arrivedAt: toIso(r.arrived_at),
      promisedAt,
      lateMinutes: late == null ? null : Math.max(0, Math.round(late)),
      minutesToArrive: minutesBetween(toIso(r.accepted_at) || toIso(r.accepted_time), r.arrived_at),
    };
  });
}

const ALERT_REASONS = {
  arrival_delay: "ETA past the deadline",
  sla_risk: "Close to the deadline",
  start_delay: "Not moving after accepting",
  gps_inactive: "GPS stopped updating",
  movement_stationary: "Stopped on the way",
  movement_away: "Moving away from the customer",
  progress_delay: "Work running long",
  scheduled_start_miss: "Missed a scheduled start",
};
export { ALERT_REASONS };

/** GET /api/admin/monitor/technicians/:id/record — the record's overview and reliability numbers. */
export async function getTechnicianRecord({ pool, technicianId, now = Date.now() }) {
  const [techRows] = await pool.query(
    `SELECT id, name, phone, service_type, status, is_available, is_logged_in, rating, jobs_completed, created_at, locality, district, address, last_seen_at
     FROM technicians WHERE id = ? LIMIT 1`,
    [technicianId]
  );
  const tech = techRows[0];
  if (!tech) return null;
  const since90 = new Date(now - 90 * 86_400_000);
  const since365 = new Date(now - 365 * 86_400_000);
  const weekStart = isoWeekStart(now);
  const twelveWeeksAgo = new Date(weekStart.getTime() - 11 * 7 * 86_400_000);
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const id = recordId(technicianId);

  const [
    [[jobs]], [weeks], [offerRows], [[current]], [reviewStats], [dist], [lowReviews], [[earnings]], [[dues]], [alertRows], [assignedEvents], [cancelEvents], [expiredDays],
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS completed FROM service_requests WHERE technician_id = ? AND completed_at IS NOT NULL AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected')`, [id]),
    pool.query(`SELECT completed_at FROM service_requests WHERE technician_id = ? AND completed_at >= ? AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'rejected')`, [id, twelveWeeksAgo]),
    pool.query(`SELECT status, COUNT(*) AS n FROM dispatch_offers WHERE technician_id = ? GROUP BY status`, [id]),
    pool.query(`SELECT id FROM service_requests WHERE technician_id = ? AND LOWER(COALESCE(status, '')) IN (${placeholders(ACTIVE_STATUSES)}) ORDER BY updated_at DESC LIMIT 1`, [id, ...ACTIVE_STATUSES]),
    pool.query(`SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE technician_id = ?`, [id]),
    pool.query(`SELECT ROUND(rating) AS stars, COUNT(*) AS n FROM reviews WHERE technician_id = ? GROUP BY ROUND(rating)`, [id]),
    pool.query(`SELECT r.service_request_id, r.rating, r.comment, r.created_at, u.full_name FROM reviews r LEFT JOIN users u ON u.id = r.user_id WHERE r.technician_id = ? AND r.rating <= 2 AND r.created_at >= ? ORDER BY r.created_at DESC LIMIT 5`, [id, new Date(now - 30 * 86_400_000)]),
    pool.query(
      `SELECT COALESCE(SUM(p.technician_amount), 0) AS total,
              COALESCE(SUM(CASE WHEN p.created_at >= ? THEN p.technician_amount ELSE 0 END), 0) AS month
       FROM payments p JOIN service_requests sr ON sr.id = p.service_request_id
       WHERE sr.technician_id = ? AND LOWER(COALESCE(p.status, '')) IN ('completed', 'paid', 'captured')`,
      [monthStart, id]
    ),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS owed FROM technician_dues WHERE technician_id = ? AND LOWER(COALESCE(status, 'pending')) = 'pending'`, [id]),
    pool.query(`SELECT reason_code, COUNT(DISTINCT service_request_id) AS n FROM job_monitoring_alerts WHERE technician_id = ? AND first_detected_at >= ? GROUP BY reason_code`, [id, since90]),
    pool.query(`SELECT request_id, metadata, created_at FROM request_timeline WHERE event_type = 'technician_assigned' AND created_at >= ? AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.previousTechnicianId')) = ?`, [since365, String(id)]),
    pool.query(`SELECT t.request_id, t.description, t.metadata, t.created_at, sr.service_type FROM request_timeline t LEFT JOIN service_requests sr ON sr.id = t.request_id WHERE t.event_type = 'cancelled' AND t.actor_type = 'user' AND t.created_at >= ? AND JSON_UNQUOTE(JSON_EXTRACT(t.metadata, '$.technicianId')) = ? ORDER BY t.created_at DESC`, [since365, String(id)]),
    pool.query(`SELECT DATE(sent_at) AS day, COUNT(*) AS n FROM dispatch_offers WHERE technician_id = ? AND status = 'expired' AND sent_at >= ? GROUP BY DATE(sent_at) HAVING COUNT(*) >= 3 ORDER BY day DESC LIMIT 3`, [id, new Date(now - 14 * 86_400_000)]),
  ]);

  const offers = { sent: 0, accepted: 0, declined: 0, expired: 0, pending: 0 };
  for (const o of offerRows) {
    const n = Number(o.n) || 0;
    offers.sent += n;
    if (o.status === "accepted") offers.accepted += n;
    else if (o.status === "rejected") offers.declined += n;
    else if (o.status === "expired") offers.expired += n;
    else offers.pending += n;
  }
  const answered = offers.accepted + offers.declined + offers.expired;

  const removed = assignedEvents.filter((e) => {
    const meta = parseJson(e.metadata, {}) || {};
    return recordId(meta.previousTechnicianId) === id && recordId(meta.technicianId) !== id;
  });

  const weekly = [];
  for (let i = 11; i >= 0; i--) {
    const start = new Date(weekStart.getTime() - i * 7 * 86_400_000);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    weekly.push({ weekStart: start.toISOString(), jobs: weeks.filter((w) => { const t = new Date(w.completed_at).getTime(); return t >= start.getTime() && t < end.getTime(); }).length });
  }

  const arrivals = await arrivalRows(pool, id, since365);
  const judged = arrivals.filter((a) => a.lateMinutes != null);
  const buckets = {
    onTime: judged.filter((a) => a.lateMinutes === 0).length,
    late1to5: judged.filter((a) => a.lateMinutes >= 1 && a.lateMinutes <= 5).length,
    late6to10: judged.filter((a) => a.lateMinutes >= 6 && a.lateMinutes <= 10).length,
    lateOver10: judged.filter((a) => a.lateMinutes > 10).length,
  };
  const toArrive = arrivals.map((a) => a.minutesToArrive).filter((m) => m != null && m >= 0);
  const lateThisWeek = judged.filter((a) => a.lateMinutes > 0 && new Date(a.arrivedAt) >= weekStart);

  const ratingCount = Number(reviewStats[0]?.n || 0);
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({ stars, count: Number(dist.find((d) => Number(d.stars) === stars)?.n || 0) }));

  const flags = [];
  if (lateThisWeek.length) {
    flags.push({ kind: "late", title: `${lateThisWeek.length} late arrival${lateThisWeek.length === 1 ? "" : "s"} this week`, text: lateThisWeek.slice(0, 3).map((a) => `#${a.requestId} by ${a.lateMinutes} min`).join(", "), tab: "reliability" });
  }
  for (const r of lowReviews.slice(0, 2)) {
    flags.push({ kind: "review", title: `A ${Number(r.rating)}-star review`, text: r.comment ? `“${String(r.comment).slice(0, 120)}” — ${r.full_name || "Customer"}, #${r.service_request_id}` : `${r.full_name || "Customer"}, #${r.service_request_id}, no comment`, at: toIso(r.created_at), tab: "reviews" });
  }
  for (const d of expiredDays) {
    flags.push({ kind: "expired", title: `Let ${Number(d.n)} offers expire on ${new Date(d.day).toDateString().slice(4, 10)}`, text: "Offers sent while on duty that got no answer.", tab: "reliability" });
  }

  return {
    technician: {
      id,
      name: tech.name,
      phone: tech.phone || null,
      phoneMasked: maskPhone(tech.phone),
      serviceType: tech.service_type || null,
      status: tech.status || null,
      onDuty: Boolean(Number(tech.is_logged_in)),
      available: Boolean(Number(tech.is_available)),
      currentRequestId: current?.id ? recordId(current.id) : null,
      place: tech.locality || tech.district || null,
      joinedAt: toIso(tech.created_at),
      lastSeenAt: toIso(tech.last_seen_at),
    },
    kpis: {
      jobsCompleted: Number(jobs?.completed || 0),
      jobsThisWeek: weekly[11].jobs,
      jobsLastWeek: weekly[10].jobs,
      offers,
      acceptanceRate: answered ? offers.accepted / answered : null,
      removedByAdmin: removed.length,
      customerCancelledAfterAccepting: cancelEvents.length,
      onTimeRate: judged.length ? buckets.onTime / judged.length : null,
      arrivalsJudged: judged.length,
      averageMinutesToArrive: toArrive.length ? round(toArrive.reduce((a, b) => a + b, 0) / toArrive.length, 0) : null,
      arrivalsMeasured: toArrive.length,
      rating: reviewStats[0]?.avg == null ? null : round(Number(reviewStats[0].avg), 2),
      ratingCount,
      lowRatings: distribution.filter((d) => d.stars <= 2).reduce((a, d) => a + d.count, 0),
      earnedThisMonth: Number(earnings?.month || 0),
      earnedTotal: Number(earnings?.total || 0),
      duesOwed: Number(dues?.owed || 0),
    },
    weekly,
    flags,
    reliability: {
      offers,
      removedByAdmin: removed.map((e) => ({ requestId: recordId(e.request_id), at: toIso(e.created_at) })),
      customerCancelled: cancelEvents.slice(0, 10).map((e) => ({ requestId: recordId(e.request_id), at: toIso(e.created_at), reason: e.description || null, serviceType: e.service_type || null })),
      arrivals: buckets,
      arrivalsJudged: judged.length,
      late: judged.filter((a) => a.lateMinutes > 0).slice(0, 10),
      alerts: Object.keys(ALERT_REASONS).map((code) => ({ code, label: ALERT_REASONS[code], count: Number(alertRows.find((a) => a.reason_code === code)?.n || 0) })),
      alertsSince: since90.toISOString(),
    },
    reviews: { average: reviewStats[0]?.avg == null ? null : round(Number(reviewStats[0].avg), 2), count: ratingCount, distribution },
  };
}

/** GET /api/admin/monitor/technicians/:id/jobs — the job history, newest first. */
export async function getTechnicianJobs({ pool, technicianId, page = 1, limit = 20, days = null, status = "all", search = "" }) {
  const where = ["sr.technician_id = ?"];
  const values = [recordId(technicianId)];
  if (days) {
    where.push("sr.created_at >= ?");
    values.push(new Date(Date.now() - Number(days) * 86_400_000));
  }
  if (status === "done") {
    where.push("sr.completed_at IS NOT NULL AND LOWER(COALESCE(sr.status, '')) NOT IN ('cancelled', 'rejected')");
  } else if (status === "active") {
    where.push(`LOWER(COALESCE(sr.status, '')) IN (${placeholders(ACTIVE_STATUSES)})`);
    values.push(...ACTIVE_STATUSES);
  } else if (status === "cancelled") {
    where.push("LOWER(COALESCE(sr.status, '')) IN ('cancelled', 'rejected')");
  }
  const term = String(search || "").trim().toLowerCase();
  if (term) {
    where.push("(CAST(sr.id AS CHAR) LIKE ? OR LOWER(COALESCE(sr.contact_name, u.full_name, '')) LIKE ?)");
    values.push(`%${term}%`, `%${term}%`);
  }
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows] = await pool.query(
    `SELECT sr.id, sr.status, sr.service_type, sr.created_at, sr.accepted_time, sr.started_at, sr.start_time, sr.completed_at,
            sr.route_distance_km, sr.final_price, sr.amount, sr.estimated_price, sr.payment_method, sr.payment_status, sr.sla_deadline,
            COALESCE(sr.contact_name, u.full_name) AS customer_name,
            (SELECT rating FROM reviews r WHERE r.service_request_id = sr.id ORDER BY r.created_at DESC LIMIT 1) AS rating,
            (SELECT metadata FROM request_timeline t WHERE t.request_id = sr.id AND t.event_type = 'accepted' ORDER BY t.created_at DESC LIMIT 1) AS accepted_meta,
            (SELECT created_at FROM request_timeline t WHERE t.request_id = sr.id AND t.event_type = 'arrived' ORDER BY t.created_at DESC LIMIT 1) AS arrived_at
     FROM service_requests sr LEFT JOIN users u ON u.id = sr.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY sr.created_at DESC
     LIMIT ? OFFSET ?`,
    [...values, Number(limit), offset]
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM service_requests sr LEFT JOIN users u ON u.id = sr.user_id WHERE ${where.join(" AND ")}`, values);
  return {
    data: rows.map((r) => {
      const meta = parseJson(r.accepted_meta, {}) || {};
      const promisedAt = meta.promisedAt || toIso(r.sla_deadline);
      const late = promisedAt && r.arrived_at ? minutesBetween(promisedAt, r.arrived_at) : null;
      return {
        id: recordId(r.id),
        createdAt: toIso(r.created_at),
        status: r.status,
        phase: phaseOf(r.status),
        serviceType: r.service_type,
        customer: r.customer_name || "Customer",
        distanceKm: toNumber(r.route_distance_km),
        promisedAt,
        arrivedAt: toIso(r.arrived_at),
        lateMinutes: late == null ? null : Math.max(0, Math.round(late)),
        workMinutes: (r.started_at || r.start_time) && r.completed_at ? Math.round(minutesBetween(r.started_at || r.start_time, r.completed_at)) : null,
        fare: money(r),
        paymentMethod: r.payment_method || null,
        paymentStatus: r.payment_status || null,
        rating: toNumber(r.rating),
      };
    }),
    pagination: { page: Number(page), limit: Number(limit), total: Number(count?.n || 0), totalPages: Math.max(1, Math.ceil(Number(count?.n || 0) / Number(limit))) },
  };
}

/** GET /api/admin/monitor/technicians/:id/reviews — every review, newest first. */
export async function getTechnicianReviews({ pool, technicianId, page = 1, limit = 20 }) {
  const offset = (Math.max(1, Number(page)) - 1) * Number(limit);
  const [rows] = await pool.query(
    `SELECT r.id, r.service_request_id, r.rating, r.comment, r.created_at, u.full_name, sr.service_type
     FROM reviews r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN service_requests sr ON sr.id = r.service_request_id
     WHERE r.technician_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [recordId(technicianId), Number(limit), offset]
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n FROM reviews WHERE technician_id = ?`, [recordId(technicianId)]);
  return {
    data: rows.map((r) => ({ id: recordId(r.id), requestId: r.service_request_id == null ? null : recordId(r.service_request_id), rating: toNumber(r.rating), comment: r.comment || null, createdAt: toIso(r.created_at), customer: r.full_name || "Customer", serviceType: r.service_type || null })),
    pagination: { page: Number(page), limit: Number(limit), total: Number(count?.n || 0), totalPages: Math.max(1, Math.ceil(Number(count?.n || 0) / Number(limit))) },
  };
}

export { ACTIVE_STATUSES, DONE_STATUSES, STALE_GPS_MS };
