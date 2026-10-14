import { getPool as defaultGetPool } from "../db.js";
import { socketService } from "./socket.js";
import { normalizeRequestStatus } from "./requestStatusWorkflow.js";

// Every change in a request's life is written to request_timeline and announced to admin
// screens at once. Writing here never throws: a missed timeline row must not fail a job.

const EVENT_BY_STATUS = Object.freeze({
  pending: "searching",
  assigned: "offered",
  accepted: "accepted",
  "on-the-way": "set_off",
  "en-route": "set_off",
  en_route_pickup: "set_off",
  arrived: "arrived",
  arrived_pickup: "arrived",
  service_started: "work_started",
  "in-progress": "work_started",
  in_progress: "work_started",
  vehicle_loaded: "vehicle_loaded",
  enroute_drop: "towing_started",
  arrived_drop: "arrived_drop",
  service_completed: "work_done",
  awaiting_payment: "work_done",
  payment_pending: "work_done",
  paid: "paid",
  completed: "paid",
  closed: "closed",
  cancelled: "cancelled",
  rejected: "declined",
});

const TITLES = Object.freeze({
  created: "Request sent",
  searching: "Searching again",
  offered: "Offered to a technician",
  accepted: "Accepted",
  set_off: "Set off",
  arrived: "Arrived",
  work_started: "Work started",
  vehicle_loaded: "Vehicle loaded",
  towing_started: "Towing to the drop",
  arrived_drop: "Reached the drop",
  work_done: "Work done",
  paid: "Paid",
  closed: "Closed",
  cancelled: "Cancelled",
  declined: "Declined the offer",
  reassigned: "Taken off the job",
  admin_note: "Note",
});

// The running server switches recording on (index.js). Handlers exercised directly by unit
// tests therefore write nothing unless a test passes its own pool.
let enabled = false;
export function enableRequestEvents(on = true) {
  enabled = Boolean(on);
}

/** The timeline event a request status belongs to, or null for statuses that are not a step. */
export function eventTypeForStatus(status) {
  const normalized = normalizeRequestStatus(status) || String(status || "").trim().toLowerCase();
  return EVENT_BY_STATUS[normalized] || null;
}

export function titleForEvent(eventType) {
  return TITLES[eventType] || String(eventType || "Update").replace(/_/g, " ");
}

/**
 * Writes one timeline row and tells admin screens. Returns the stored row, or null if it
 * could not be written. Resolves either way.
 */
export async function recordRequestEvent(
  { requestId, eventType, status = null, title = null, description = null, actorType = "system", actorId = null, metadata = null },
  deps = {}
) {
  if (!deps.getPool && !enabled) return null;
  const { getPool = defaultGetPool, notifyAdmins = (event, data) => socketService.notifyAdmins(event, data), now = () => new Date() } = deps;
  const id = Number(requestId);
  if (!Number.isInteger(id) || id <= 0 || !eventType) return null;
  const row = {
    requestId: id,
    eventType: String(eventType),
    status: status == null ? null : String(status),
    title: title || titleForEvent(eventType),
    description: description == null ? null : String(description).slice(0, 2000),
    actorType: String(actorType || "system"),
    actorId: actorId == null ? null : String(actorId),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    at: now().toISOString(),
  };
  try {
    const pool = await getPool();
    await pool.execute(
      `INSERT INTO request_timeline
        (request_id, event_type, status, title, description, actor_type, actor_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.requestId, row.eventType, row.status, row.title, row.description, row.actorType, row.actorId, JSON.stringify(row.metadata)]
    );
  } catch (error) {
    console.error("[RequestEvents] could not record", row.eventType, "for", row.requestId, error?.message || error);
    return null;
  }
  try {
    notifyAdmins("admin:request_event", row);
  } catch (error) {
    console.error("[RequestEvents] admin notify failed:", error?.message || error);
  }
  return row;
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

/**
 * The technician accepted: the promised arrival is fixed now, from the route between the
 * technician and the customer, so later arrival can be judged against it.
 */
export async function recordAcceptedEvent({ requestId, technicianId, from = null, to = null }, deps = {}) {
  if (!deps.getPool && !enabled) return null;
  const { getRoute = null, now = () => new Date() } = deps;
  let etaMinutes = null;
  let distanceKm = null;
  const valid = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  if (typeof getRoute === "function" && valid(from) && valid(to)) {
    try {
      const route = await withTimeout(Promise.resolve(getRoute({ points: [from, to], overview: "simplified" })), 5_000);
      const minutes = Number(route?.durationMinutes ?? route?.estimatedDuration);
      const km = Number(route?.distanceKm);
      if (Number.isFinite(minutes) && minutes >= 0) etaMinutes = Math.round(minutes * 10) / 10;
      if (Number.isFinite(km) && km >= 0) distanceKm = Math.round(km * 100) / 100;
    } catch {
      // No route: the job is still recorded, without a promise to judge it by.
    }
  }
  const acceptedAt = now();
  const promisedAt = etaMinutes == null ? null : new Date(acceptedAt.getTime() + Math.max(1, Math.ceil(etaMinutes)) * 60_000).toISOString();
  return recordRequestEvent({
    requestId,
    eventType: "accepted",
    status: "accepted",
    actorType: "technician",
    actorId: technicianId,
    metadata: { technicianId: technicianId == null ? null : String(technicianId), etaMinutes, distanceKm, promisedAt },
  }, { ...deps, now: () => acceptedAt });
}

/** A status change, as one timeline row. Statuses that are not a step are skipped. */
export function recordStatusChange({ requestId, status, previousStatus = null, actorType, actorId, metadata = {} }, deps) {
  const eventType = eventTypeForStatus(status);
  if (!eventType) return Promise.resolve(null);
  if (previousStatus && eventTypeForStatus(previousStatus) === eventType) return Promise.resolve(null);
  return recordRequestEvent({ requestId, eventType, status, actorType, actorId, metadata: { previousStatus, ...metadata } }, deps);
}
