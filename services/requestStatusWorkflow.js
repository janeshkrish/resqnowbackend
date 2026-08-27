import { isTowingServiceType } from "./towingServiceType.js";

export const TOWING_STATUS_FLOW = Object.freeze([
  "assigned",
  "accepted",
  "en_route_pickup",
  "arrived_pickup",
  "vehicle_loaded",
  "enroute_drop",
  "arrived_drop",
  "service_completed",
  "payment_pending",
  "closed",
]);

const TOWING_EVENTS_BY_STATUS = Object.freeze({
  vehicle_loaded: "vehicle_loaded",
  enroute_drop: "tow_started",
  arrived_drop: "arrived_drop",
  service_completed: "service_completed",
  payment_pending: "payment_pending",
  closed: "job_closed",
});

const BASE_STATUS_ALIASES = Object.freeze({
  requested: "pending",
  "service started": "service_started",
  "service-started": "service_started",
  on_the_way: "on-the-way",
  "on the way": "on-the-way",
  en_route: "en-route",
  "in_progress": "in-progress",
  "in progress": "in-progress",
  "payment-pending": "payment_pending",
  awaiting_payment: "awaiting_payment",
  "awaiting-payment": "awaiting_payment",
  "awaiting payment": "awaiting_payment",
  "en route pickup": "en_route_pickup",
  "en-route-pickup": "en_route_pickup",
  en_route_pickup: "en_route_pickup",
  arrived_pickup: "arrived_pickup",
  "arrived-pickup": "arrived_pickup",
  "arrived pickup": "arrived_pickup",
  vehicle_loaded: "vehicle_loaded",
  "vehicle-loaded": "vehicle_loaded",
  "vehicle loaded": "vehicle_loaded",
  tow_started: "enroute_drop",
  "tow-started": "enroute_drop",
  "tow started": "enroute_drop",
  start_tow: "enroute_drop",
  "start tow": "enroute_drop",
  en_route_drop: "enroute_drop",
  "en-route-drop": "enroute_drop",
  enroute_drop: "enroute_drop",
  "enroute drop": "enroute_drop",
  arrived_drop: "arrived_drop",
  "arrived-drop": "arrived_drop",
  "arrived drop": "arrived_drop",
  service_completed: "service_completed",
  "service-completed": "service_completed",
  "service completed": "service_completed",
  job_closed: "closed",
  "job-closed": "closed",
  closed: "closed",
});

const VALID_STATUSES = new Set([
  "pending",
  "assigned",
  "accepted",
  "processing",
  "service_started",
  "on-the-way",
  "en-route",
  "arrived",
  "in_progress",
  "in-progress",
  "awaiting_payment",
  "payment_pending",
  "completed",
  "cancelled",
  "rejected",
  "paid",
  "closed",
  ...TOWING_STATUS_FLOW,
]);

const ACTIVE_NON_TOWING_TRANSITIONS = Object.freeze({
  assigned: new Set(["accepted", "rejected", "cancelled"]),
  accepted: new Set(["en-route", "on-the-way", "service_started", "rejected", "cancelled"]),
  processing: new Set(["en-route", "on-the-way", "service_started", "cancelled"]),
  "on-the-way": new Set(["arrived", "service_started", "cancelled"]),
  "en-route": new Set(["arrived", "service_started", "cancelled"]),
  arrived: new Set(["service_started", "in-progress", "in_progress", "awaiting_payment", "payment_pending", "cancelled"]),
  service_started: new Set(["in-progress", "in_progress", "awaiting_payment", "payment_pending", "cancelled"]),
  "in-progress": new Set(["awaiting_payment", "payment_pending", "cancelled"]),
  in_progress: new Set(["awaiting_payment", "payment_pending", "cancelled"]),
  awaiting_payment: new Set(["payment_pending", "paid", "completed"]),
  payment_pending: new Set(["paid", "completed"]),
  paid: new Set(["completed"]),
});

const TOWING_LEGACY_STATUS_MAP = Object.freeze({
  "on-the-way": "en_route_pickup",
  "en-route": "en_route_pickup",
  service_started: "vehicle_loaded",
  arrived: "arrived_pickup",
  "in-progress": "enroute_drop",
  in_progress: "enroute_drop",
  awaiting_payment: "payment_pending",
  completed: "service_completed",
  paid: "closed",
});

export function normalizeRequestStatus(status) {
  if (!status && status !== 0) return null;
  const raw = String(status).trim().toLowerCase();
  const normalized = BASE_STATUS_ALIASES[raw] || raw;
  return VALID_STATUSES.has(normalized) ? normalized : null;
}

export function normalizeStatusForWorkflow(status, { serviceType = null, towing = null } = {}) {
  const normalized = normalizeRequestStatus(status);
  if (!normalized) return null;
  const isTowing = towing ?? isTowingServiceType(serviceType);
  if (!isTowing) return normalized;
  return TOWING_LEGACY_STATUS_MAP[normalized] || normalized;
}

export function isTerminalWorkflowStatus(status) {
  const normalized = normalizeRequestStatus(status);
  return ["completed", "cancelled", "rejected", "paid", "closed"].includes(normalized);
}

export function getTowingRealtimeEvent(status) {
  return TOWING_EVENTS_BY_STATUS[normalizeRequestStatus(status)] || null;
}

function isPaymentMarkedPaid(paymentStatus) {
  return ["paid", "completed"].includes(String(paymentStatus || "").trim().toLowerCase());
}

function validateTowingTransition({ currentStatus, nextStatus, paymentStatus }) {
  const current = normalizeStatusForWorkflow(currentStatus, { towing: true }) || "assigned";
  const next = normalizeStatusForWorkflow(nextStatus, { towing: true });
  if (!next) return { ok: false, reason: "Invalid towing status." };
  if (next === "cancelled" || next === "rejected") {
    return ["assigned", "accepted"].includes(current)
      ? { ok: true }
      : { ok: false, reason: `Cannot ${next} a towing request after ${current}.` };
  }
  if (!TOWING_STATUS_FLOW.includes(next)) {
    return { ok: false, reason: "Status is not part of the towing workflow." };
  }
  if (current === next) return { ok: true, idempotent: true };
  const currentIndex = TOWING_STATUS_FLOW.indexOf(current);
  const nextIndex = TOWING_STATUS_FLOW.indexOf(next);
  if (currentIndex === -1) {
    return { ok: false, reason: `Cannot move towing request from ${currentStatus || "unknown"} to ${next}.` };
  }
  if (nextIndex === currentIndex + 1) {
    if (next === "closed" && !isPaymentMarkedPaid(paymentStatus)) {
      return { ok: false, reason: "Payment must be completed before closing a towing request." };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Invalid towing status transition from ${current} to ${next}.`,
  };
}

function validateNonTowingTransition({ currentStatus, nextStatus }) {
  const current = normalizeRequestStatus(currentStatus) || "assigned";
  const next = normalizeRequestStatus(nextStatus);
  if (!next) return { ok: false, reason: "Invalid status." };
  if (current === next) return { ok: true, idempotent: true };
  if (["cancelled", "rejected"].includes(next)) {
    return ["pending", "assigned", "accepted"].includes(current)
      ? { ok: true }
      : { ok: false, reason: `Cannot ${next} a request after ${current}.` };
  }
  if (["completed", "paid", "closed"].includes(current)) {
    return { ok: false, reason: `Request is already ${current}.` };
  }
  const allowed = ACTIVE_NON_TOWING_TRANSITIONS[current];
  if (allowed?.has(next)) return { ok: true };
  return {
    ok: false,
    reason: `Invalid status transition from ${current} to ${next}.`,
  };
}

export function validateTechnicianStatusTransition({
  currentStatus,
  nextStatus,
  serviceType,
  paymentStatus,
}) {
  if (isTowingServiceType(serviceType)) {
    return validateTowingTransition({ currentStatus, nextStatus, paymentStatus });
  }
  return validateNonTowingTransition({ currentStatus, nextStatus });
}

export function mapRequestedTechnicianStatus({ requestedStatus, currentStatus, serviceType }) {
  const normalized = normalizeRequestStatus(requestedStatus);
  if (!normalized) return null;
  if (!isTowingServiceType(serviceType)) {
    return normalized === "completed" ? "awaiting_payment" : normalized;
  }

  const current = normalizeStatusForWorkflow(currentStatus, { towing: true });
  if (normalized === "completed") {
    return current === "arrived_drop" ? "service_completed" : normalizeStatusForWorkflow(normalized, { towing: true });
  }
  return normalizeStatusForWorkflow(normalized, { towing: true });
}
