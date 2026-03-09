import axios from "axios";
import { getPool } from "../db.js";
import { socketService } from "./socket.js";
import { jobDispatchService } from "./jobDispatchService.js";
import { releaseTechnicianAvailability } from "./technicianStateService.js";
import { MonitoringWorkerQueue } from "./monitoringWorkerQueue.js";

const GOOGLE_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";
const GOOGLE_MAPS_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || process.env.GMAPS_API_KEY || "").trim();

const ACTIVE_MONITORING_STATUSES = new Set([
  "assigned",
  "accepted",
  "processing",
  "in_progress",
  "in-progress",
  "service_started",
  "en-route",
  "on-the-way",
  "arrived",
  "payment_pending",
]);

const PRE_START_STATUSES = new Set(["accepted"]);
const MOVEMENT_STATUSES = new Set([
  "accepted",
  "processing",
  "in_progress",
  "in-progress",
  "service_started",
  "en-route",
  "on-the-way",
  "arrived",
]);
const PROGRESS_TRACKING_STATUSES = new Set([
  "processing",
  "service_started",
  "in_progress",
  "in-progress",
  "en-route",
  "on-the-way",
  "arrived",
]);

const DEFAULT_INTERVAL_MS = 45_000;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_API_BUDGET = 250;
const HISTORY_LOOKBACK_MINUTES = 90;
const MAX_HISTORY_POINTS_PER_REQUEST = 12;
const MANDATORY_SAFETY_BUFFER_MINUTES = 30;
const SCHEDULE_GRACE_MINUTES = 15;
const GPS_INACTIVITY_MINUTES = 8;
const SLA_WARNING_MINUTES = 20;
const PROGRESS_STALE_MINUTES = 20;

const etaCache = new Map();
let activeMonitorCyclePromise = null;
const monitorState = {
  timer: null,
  running: false,
  lastRunAt: null,
  lastError: null,
};

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesBetween(earlier, later) {
  if (!earlier || !later) return null;
  return (later.getTime() - earlier.getTime()) / 60000;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function round(value, precision = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** precision;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

function clampInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(parsed)));
}

function getMonitorIntervalMs() {
  return clampInterval(process.env.OPS_MONITOR_INTERVAL_MS || DEFAULT_INTERVAL_MS);
}

function getMonitorConcurrency() {
  const parsed = Number(process.env.OPS_MONITOR_CONCURRENCY || DEFAULT_CONCURRENCY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CONCURRENCY;
}

function getGoogleEtaBudget() {
  const parsed = Number(process.env.OPS_MONITOR_GOOGLE_ETA_BUDGET || DEFAULT_API_BUDGET);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_API_BUDGET;
}

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const aLat = toNumber(lat1);
  const aLng = toNumber(lng1);
  const bLat = toNumber(lat2);
  const bLng = toNumber(lng2);
  if (aLat == null || aLng == null || bLat == null || bLng == null) return null;

  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const p =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return R * (2 * Math.atan2(Math.sqrt(p), Math.sqrt(1 - p)));
}

function fallbackEtaMinutes(distanceKm) {
  const distance = toNumber(distanceKm);
  if (distance == null) return null;
  const avgSpeedKmPerHour = 28;
  return Math.max(2, (distance / avgSpeedKmPerHour) * 60);
}

function toCoordinatePair(lat, lng) {
  const parsedLat = toNumber(lat);
  const parsedLng = toNumber(lng);
  if (parsedLat == null || parsedLng == null) return null;
  return { lat: parsedLat, lng: parsedLng };
}

function etaCacheKey(origin, destination) {
  return `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}>${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
}

function sweepEtaCache(now = Date.now()) {
  if (etaCache.size < 5000) return;
  for (const [key, value] of etaCache.entries()) {
    if (!value?.expiresAt || value.expiresAt <= now) {
      etaCache.delete(key);
    }
  }
  if (etaCache.size > 9000) {
    etaCache.clear();
  }
}

async function estimateEtaMinutes(context, origin, destination) {
  if (!origin || !destination) return null;
  const directDistance = haversineDistanceKm(origin.lat, origin.lng, destination.lat, destination.lng);
  const cachedKey = etaCacheKey(origin, destination);
  const cacheHit = etaCache.get(cachedKey);
  const now = Date.now();
  sweepEtaCache(now);

  if (cacheHit && cacheHit.expiresAt > now) {
    return cacheHit.minutes;
  }

  if (!GOOGLE_MAPS_API_KEY || context.googleCallsRemaining <= 0) {
    const fallback = fallbackEtaMinutes(directDistance);
    if (fallback != null) {
      etaCache.set(cachedKey, {
        minutes: fallback,
        expiresAt: now + 45_000,
      });
    }
    return fallback;
  }

  context.googleCallsRemaining -= 1;
  try {
    const params = {
      origins: `${origin.lat},${origin.lng}`,
      destinations: `${destination.lat},${destination.lng}`,
      departure_time: "now",
      key: GOOGLE_MAPS_API_KEY,
    };
    const { data } = await axios.get(GOOGLE_DISTANCE_MATRIX_URL, { params, timeout: 5000 });
    const seconds = Number(
      data?.rows?.[0]?.elements?.[0]?.duration_in_traffic?.value ??
      data?.rows?.[0]?.elements?.[0]?.duration?.value
    );
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error("Distance Matrix did not return duration.");
    }

    const minutes = seconds / 60;
    etaCache.set(cachedKey, {
      minutes,
      expiresAt: now + 45_000,
    });
    return minutes;
  } catch (_error) {
    const fallback = fallbackEtaMinutes(directDistance);
    if (fallback != null) {
      etaCache.set(cachedKey, {
        minutes: fallback,
        expiresAt: now + 30_000,
      });
    }
    return fallback;
  }
}

function riskForStartDelay(minutesLate) {
  return minutesLate >= 12 ? "red" : "yellow";
}

function riskForScheduleDelay(minutesLate) {
  return minutesLate >= 20 ? "red" : "yellow";
}

function formatDateTime(date) {
  if (!date) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function fetchActiveJobs(pool) {
  const statuses = Array.from(ACTIVE_MONITORING_STATUSES);
  const placeholders = statuses.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT
      sr.id AS request_id,
      sr.user_id,
      sr.technician_id,
      sr.service_type,
      sr.status,
      sr.address,
      sr.created_at,
      sr.updated_at,
      sr.accepted_time,
      sr.start_time,
      sr.started_at,
      sr.scheduled_time,
      sr.sla_deadline,
      COALESCE(sr.customer_location_lat, sr.location_lat) AS customer_lat,
      COALESCE(sr.customer_location_lng, sr.location_lng) AS customer_lng,
      t.name AS technician_name,
      t.phone AS technician_phone,
      COALESCE(t.current_lat, t.latitude) AS technician_lat,
      COALESCE(t.current_lng, t.longitude) AS technician_lng,
      t.last_location_update,
      t.acceptance_rate,
      t.rating,
      t.service_type AS technician_service_type,
      t.specialties,
      t.skill_set
     FROM service_requests sr
     LEFT JOIN technicians t ON t.id = sr.technician_id
     WHERE sr.technician_id IS NOT NULL
       AND sr.status IN (${placeholders})`,
    statuses
  );
  return rows || [];
}

async function fetchExistingAlerts(pool, requestIds) {
  if (requestIds.length === 0) return new Map();
  const placeholders = requestIds.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT
       id,
       service_request_id,
       reason_code,
       risk_level
     FROM job_monitoring_alerts
     WHERE is_active = 1
       AND service_request_id IN (${placeholders})`,
    requestIds
  );

  const map = new Map();
  (rows || []).forEach((row) => {
    const requestId = Number(row.service_request_id);
    if (!map.has(requestId)) {
      map.set(requestId, []);
    }
    map.get(requestId).push(row);
  });
  return map;
}

async function fetchRecentLocationHistory(pool, requestIds) {
  if (requestIds.length === 0) return new Map();
  const placeholders = requestIds.map(() => "?").join(", ");
  const [rows] = await pool.query(
    `SELECT
       service_request_id,
       technician_id,
       latitude,
       longitude,
       captured_at
     FROM technician_location_history
     WHERE service_request_id IN (${placeholders})
       AND captured_at >= DATE_SUB(NOW(), INTERVAL ${HISTORY_LOOKBACK_MINUTES} MINUTE)
     ORDER BY service_request_id ASC, captured_at DESC`,
    requestIds
  );

  const map = new Map();
  (rows || []).forEach((row) => {
    const requestId = Number(row.service_request_id);
    if (!map.has(requestId)) {
      map.set(requestId, []);
    }
    const history = map.get(requestId);
    if (history.length < MAX_HISTORY_POINTS_PER_REQUEST) {
      history.push(row);
    }
  });
  return map;
}

async function resolveTerminalJobAlerts(pool) {
  await pool.query(
    `UPDATE job_monitoring_alerts a
     JOIN service_requests sr ON sr.id = a.service_request_id
     SET a.is_active = 0,
         a.resolved_at = NOW(),
         a.updated_at = NOW()
     WHERE a.is_active = 1
       AND sr.status IN ('completed', 'cancelled', 'paid', 'rejected')`
  );
}

function buildMonitoringContext() {
  return {
    now: new Date(),
    googleCallsRemaining: getGoogleEtaBudget(),
  };
}

async function evaluateJobExceptions(job, historyRows, context) {
  const alerts = [];
  const now = context.now;
  const status = normalizeStatus(job.status);
  const customer = toCoordinatePair(job.customer_lat, job.customer_lng);
  const technician = toCoordinatePair(job.technician_lat, job.technician_lng);

  const acceptedAt = toDate(job.accepted_time);
  const startedAt = toDate(job.start_time || job.started_at);
  const scheduledAt = toDate(job.scheduled_time);
  const slaDeadline = toDate(job.sla_deadline);
  const createdAt = toDate(job.created_at);
  const lastJobUpdateAt = toDate(job.updated_at);
  const lastLocationUpdateAt = toDate(job.last_location_update);
  const acceptedAtForDelay = acceptedAt || (status === "accepted" ? createdAt : null);

  let latestEtaMinutes = null;
  let latestEtaArrival = null;

  if (technician && customer) {
    latestEtaMinutes = await estimateEtaMinutes(context, technician, customer);
    if (latestEtaMinutes != null) {
      latestEtaArrival = new Date(now.getTime() + latestEtaMinutes * 60 * 1000);
    }
  }

  if (PRE_START_STATUSES.has(status) && acceptedAtForDelay && !startedAt) {
    const acceptedMinutes = minutesBetween(acceptedAtForDelay, now);
    if (acceptedMinutes != null && acceptedMinutes >= 3) {
      alerts.push({
        reasonCode: "start_delay",
        reasonText: "Technician accepted the job but has not started moving within 3 minutes.",
        riskLevel: riskForStartDelay(acceptedMinutes),
        etaMinutes: latestEtaMinutes,
        etaArrival: latestEtaArrival,
        slaDeadline,
        metadata: {
          acceptedAt: formatDateTime(acceptedAtForDelay),
          acceptedMinutes: round(acceptedMinutes, 1),
        },
      });
    }
  }

  let hasArrivalDelay = false;
  if (slaDeadline && latestEtaArrival && latestEtaArrival.getTime() > slaDeadline.getTime()) {
    const deltaMinutes = (latestEtaArrival.getTime() - slaDeadline.getTime()) / 60000;
    hasArrivalDelay = true;
    alerts.push({
      reasonCode: "arrival_delay",
      reasonText: "Predicted ETA exceeds the SLA deadline.",
      riskLevel: deltaMinutes >= 15 ? "red" : "yellow",
      etaMinutes: latestEtaMinutes,
      etaArrival: latestEtaArrival,
      slaDeadline,
      metadata: {
        minutesBeyondSla: round(deltaMinutes, 1),
      },
    });
  }

  if (slaDeadline && !hasArrivalDelay) {
    const remainingMinutes = minutesBetween(now, slaDeadline);
    if (remainingMinutes != null && remainingMinutes > 0 && remainingMinutes <= SLA_WARNING_MINUTES) {
      const etaUnknown = latestEtaMinutes == null;
      const etaExhaustsWindow = latestEtaMinutes != null && latestEtaMinutes >= Math.max(remainingMinutes - 2, 0);
      if (etaUnknown || etaExhaustsWindow) {
        alerts.push({
          reasonCode: "sla_risk",
          reasonText: "SLA deadline is approaching and current ETA leaves little margin.",
          riskLevel: remainingMinutes <= 8 ? "red" : "yellow",
          etaMinutes: latestEtaMinutes,
          etaArrival: latestEtaArrival,
          slaDeadline,
          metadata: {
            minutesRemaining: round(remainingMinutes, 1),
            etaMinutes: latestEtaMinutes != null ? round(latestEtaMinutes, 1) : null,
          },
        });
      }
    }
  }

  if (MOVEMENT_STATUSES.has(status)) {
    const minutesSinceLocation = lastLocationUpdateAt ? minutesBetween(lastLocationUpdateAt, now) : null;
    const minutesSinceAccepted = acceptedAtForDelay ? minutesBetween(acceptedAtForDelay, now) : null;
    const effectiveInactivityMinutes = minutesSinceLocation ?? minutesSinceAccepted;

    if (effectiveInactivityMinutes != null && effectiveInactivityMinutes >= GPS_INACTIVITY_MINUTES) {
      alerts.push({
        reasonCode: "gps_inactive",
        reasonText: "Technician GPS has not updated recently for this active job.",
        riskLevel: effectiveInactivityMinutes >= 15 ? "red" : "yellow",
        etaMinutes: latestEtaMinutes,
        etaArrival: latestEtaArrival,
        slaDeadline,
        metadata: {
          lastLocationUpdateAt: formatDateTime(lastLocationUpdateAt),
          inactivityMinutes: round(effectiveInactivityMinutes, 1),
        },
      });
    }
  }

  if (MOVEMENT_STATUSES.has(status) && customer && historyRows.length >= 2) {
    const latest = historyRows[0];
    const previous = historyRows[1];
    const latestPoint = toCoordinatePair(latest.latitude, latest.longitude);
    const previousPoint = toCoordinatePair(previous.latitude, previous.longitude);
    const latestCaptured = toDate(latest.captured_at);
    const previousCaptured = toDate(previous.captured_at);
    const minutesGap = minutesBetween(previousCaptured, latestCaptured) || 0;
    const movedKm = latestPoint && previousPoint
      ? haversineDistanceKm(previousPoint.lat, previousPoint.lng, latestPoint.lat, latestPoint.lng)
      : null;
    const previousDistToCustomer = previousPoint
      ? haversineDistanceKm(previousPoint.lat, previousPoint.lng, customer.lat, customer.lng)
      : null;
    const latestDistToCustomer = latestPoint
      ? haversineDistanceKm(latestPoint.lat, latestPoint.lng, customer.lat, customer.lng)
      : null;

    if (
      minutesGap >= 8 &&
      movedKm != null &&
      movedKm < 0.08 &&
      latestDistToCustomer != null &&
      latestDistToCustomer > 0.3
    ) {
      alerts.push({
        reasonCode: "movement_stationary",
        reasonText: "Technician appears stationary for too long while the job is active.",
        riskLevel: "red",
        etaMinutes: latestEtaMinutes,
        etaArrival: latestEtaArrival,
        slaDeadline,
        metadata: {
          movedKm: round(movedKm, 3),
          minutesGap: round(minutesGap, 1),
          distanceToCustomerKm: round(latestDistToCustomer, 2),
        },
      });
    }

    if (
      previousDistToCustomer != null &&
      latestDistToCustomer != null &&
      latestDistToCustomer - previousDistToCustomer > 0.25
    ) {
      alerts.push({
        reasonCode: "movement_away",
        reasonText: "Technician movement indicates the route is moving away from the customer.",
        riskLevel: "red",
        etaMinutes: latestEtaMinutes,
        etaArrival: latestEtaArrival,
        slaDeadline,
        metadata: {
          previousDistanceKm: round(previousDistToCustomer, 2),
          latestDistanceKm: round(latestDistToCustomer, 2),
        },
      });
    }
  }

  if (PROGRESS_TRACKING_STATUSES.has(status)) {
    const progressBaseTime = startedAt || acceptedAtForDelay || createdAt;
    const activeMinutes = progressBaseTime ? minutesBetween(progressBaseTime, now) : null;
    const staleMinutes = lastJobUpdateAt ? minutesBetween(lastJobUpdateAt, now) : null;
    if (activeMinutes != null && activeMinutes >= 60 && (staleMinutes == null || staleMinutes >= PROGRESS_STALE_MINUTES)) {
      alerts.push({
        reasonCode: "progress_delay",
        reasonText: "Job appears stalled with limited progress updates.",
        riskLevel: activeMinutes >= 90 ? "red" : "yellow",
        etaMinutes: latestEtaMinutes,
        etaArrival: latestEtaArrival,
        slaDeadline,
        metadata: {
          status,
          activeMinutes: round(activeMinutes, 1),
          staleMinutes: staleMinutes != null ? round(staleMinutes, 1) : null,
          lastJobUpdateAt: formatDateTime(lastJobUpdateAt),
        },
      });
    }
  }

  if (scheduledAt && !startedAt && customer && technician) {
    const travelMinutes = latestEtaMinutes ?? fallbackEtaMinutes(haversineDistanceKm(
      technician.lat,
      technician.lng,
      customer.lat,
      customer.lng
    ));
    if (travelMinutes != null) {
      const requiredStart = new Date(scheduledAt.getTime() - (travelMinutes + MANDATORY_SAFETY_BUFFER_MINUTES) * 60_000);
      const graceDeadline = new Date(requiredStart.getTime() + SCHEDULE_GRACE_MINUTES * 60_000);
      if (now.getTime() > graceDeadline.getTime()) {
        const lateByMinutes = (now.getTime() - graceDeadline.getTime()) / 60000;
        alerts.push({
          reasonCode: "scheduled_start_miss",
          reasonText: "Scheduled appointment start window is at risk because technician has not started on time.",
          riskLevel: riskForScheduleDelay(lateByMinutes),
          etaMinutes: latestEtaMinutes,
          etaArrival: latestEtaArrival,
          slaDeadline,
          metadata: {
            scheduledAt: formatDateTime(scheduledAt),
            requiredStart: formatDateTime(requiredStart),
            graceDeadline: formatDateTime(graceDeadline),
            lateByMinutes: round(lateByMinutes, 1),
          },
        });
      }
    }
  }

  return alerts.map((alert) => ({
    ...alert,
    requestId: Number(job.request_id),
    technicianId: Number(job.technician_id),
    customerLat: customer?.lat ?? null,
    customerLng: customer?.lng ?? null,
    technicianLat: technician?.lat ?? null,
    technicianLng: technician?.lng ?? null,
  }));
}

async function persistAlertsForJob(pool, job, alerts, existingAlerts, resolveQueue) {
  const reasonSet = new Set(alerts.map((alert) => alert.reasonCode));
  const existingByReason = new Map((existingAlerts || []).map((item) => [String(item.reason_code), item]));

  for (const alert of alerts) {
    const existing = existingByReason.get(alert.reasonCode);
    if (existing) {
      await pool.execute(
        `UPDATE job_monitoring_alerts
         SET risk_level = ?,
             reason_text = ?,
             eta_minutes = ?,
             eta_arrival = ?,
             sla_deadline = ?,
             technician_lat = ?,
             technician_lng = ?,
             customer_lat = ?,
             customer_lng = ?,
             metadata = ?,
             is_active = 1,
             last_detected_at = NOW(),
             resolved_at = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        [
          alert.riskLevel,
          alert.reasonText,
          alert.etaMinutes != null ? round(alert.etaMinutes, 2) : null,
          formatDateTime(alert.etaArrival),
          formatDateTime(alert.slaDeadline),
          alert.technicianLat,
          alert.technicianLng,
          alert.customerLat,
          alert.customerLng,
          JSON.stringify(alert.metadata || {}),
          existing.id,
        ]
      );
      continue;
    }

    const [insertResult] = await pool.execute(
      `INSERT INTO job_monitoring_alerts (
         service_request_id,
         technician_id,
         reason_code,
         reason_text,
         risk_level,
         eta_minutes,
         eta_arrival,
         sla_deadline,
         technician_lat,
         technician_lng,
         customer_lat,
         customer_lng,
         metadata,
         is_active,
         first_detected_at,
         last_detected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        Number(job.request_id),
        Number(job.technician_id),
        alert.reasonCode,
        alert.reasonText,
        alert.riskLevel,
        alert.etaMinutes != null ? round(alert.etaMinutes, 2) : null,
        formatDateTime(alert.etaArrival),
        formatDateTime(alert.slaDeadline),
        alert.technicianLat,
        alert.technicianLng,
        alert.customerLat,
        alert.customerLng,
        JSON.stringify(alert.metadata || {}),
      ]
    );

    const alertId = Number(insertResult?.insertId || 0);
    socketService.broadcast("admin:command_center_alert", {
      id: alertId || undefined,
      requestId: Number(job.request_id),
      technicianId: Number(job.technician_id),
      reasonCode: alert.reasonCode,
      reason: alert.reasonText,
      riskLevel: alert.riskLevel,
      etaMinutes: alert.etaMinutes != null ? round(alert.etaMinutes, 2) : null,
      at: new Date().toISOString(),
      message: `Potential Delay Detected - Job #${Number(job.request_id)}`,
    });
  }

  (existingAlerts || []).forEach((item) => {
    if (!reasonSet.has(String(item.reason_code))) {
      resolveQueue.push({
        id: Number(item.id),
        requestId: Number(job.request_id),
        reasonCode: String(item.reason_code),
      });
    }
  });
}

async function resolveAlertsById(pool, resolveQueue) {
  if (!Array.isArray(resolveQueue) || resolveQueue.length === 0) return 0;
  const ids = Array.from(new Set(resolveQueue.map((entry) => Number(entry.id)).filter((id) => id > 0)));
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(", ");
  const [updateResult] = await pool.query(
    `UPDATE job_monitoring_alerts
     SET is_active = 0,
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE id IN (${placeholders})
       AND is_active = 1`,
    ids
  );

  resolveQueue.forEach((entry) => {
    socketService.broadcast("admin:command_center_alert_resolved", {
      requestId: entry.requestId,
      reasonCode: entry.reasonCode,
      at: new Date().toISOString(),
    });
  });

  return Number(updateResult?.affectedRows || 0);
}

async function executeOperationsCommandCenterCycle({ trigger = "scheduler" } = {}) {
  const pool = await getPool();
  const context = buildMonitoringContext();
  await resolveTerminalJobAlerts(pool);

  const jobs = await fetchActiveJobs(pool);
  if (jobs.length === 0) {
    monitorState.lastRunAt = new Date().toISOString();
    return {
      trigger,
      jobsScanned: 0,
      alertsResolved: 0,
      alertsDetected: 0,
      googleCallsRemaining: context.googleCallsRemaining,
    };
  }

  const requestIds = jobs.map((job) => Number(job.request_id)).filter((id) => Number.isInteger(id) && id > 0);
  const [historyByRequest, existingAlertsByRequest] = await Promise.all([
    fetchRecentLocationHistory(pool, requestIds),
    fetchExistingAlerts(pool, requestIds),
  ]);

  const resolveQueue = [];
  let alertsDetected = 0;
  const queue = new MonitoringWorkerQueue({ concurrency: getMonitorConcurrency() });
  const processingResult = await queue.process(jobs, async (job) => {
    const requestId = Number(job.request_id);
    const historyRows = historyByRequest.get(requestId) || [];
    const alerts = await evaluateJobExceptions(job, historyRows, context);
    const existingAlerts = existingAlertsByRequest.get(requestId) || [];

    if (alerts.length > 0) {
      alertsDetected += alerts.length;
    }
    await persistAlertsForJob(pool, job, alerts, existingAlerts, resolveQueue);
  });

  const alertsResolved = await resolveAlertsById(pool, resolveQueue);

  monitorState.lastRunAt = new Date().toISOString();
  socketService.broadcast("admin:command_center_cycle", {
    at: monitorState.lastRunAt,
    jobsScanned: jobs.length,
    alertsDetected,
    alertsResolved,
    trigger,
  });

  return {
    trigger,
    jobsScanned: jobs.length,
    alertsDetected,
    alertsResolved,
    workerFailures: processingResult.failed,
    workerErrors: processingResult.errors,
    googleCallsRemaining: context.googleCallsRemaining,
  };
}

export async function runOperationsCommandCenterCycle({ trigger = "scheduler" } = {}) {
  if (activeMonitorCyclePromise) {
    return activeMonitorCyclePromise;
  }

  monitorState.running = true;
  activeMonitorCyclePromise = (async () => {
    try {
      const result = await executeOperationsCommandCenterCycle({ trigger });
      monitorState.lastError = null;
      return result;
    } catch (error) {
      monitorState.lastError = error?.message || "Command center monitor failed.";
      throw error;
    } finally {
      monitorState.running = false;
      activeMonitorCyclePromise = null;
    }
  })();

  return activeMonitorCyclePromise;
}

export function startOperationsCommandCenterMonitor() {
  if (monitorState.timer) return;

  const intervalMs = getMonitorIntervalMs();
  const tick = async () => {
    try {
      await runOperationsCommandCenterCycle({ trigger: "scheduler" });
    } catch (error) {
      console.error("[OperationsCommandCenter] monitor tick failed:", error?.message || error);
    }
  };

  monitorState.timer = setInterval(tick, intervalMs);
  void tick();
}

export function stopOperationsCommandCenterMonitor() {
  if (!monitorState.timer) return;
  clearInterval(monitorState.timer);
  monitorState.timer = null;
}

export function getOperationsCommandCenterMonitorState() {
  return {
    running: monitorState.running,
    intervalMs: getMonitorIntervalMs(),
    lastRunAt: monitorState.lastRunAt,
    lastError: monitorState.lastError,
  };
}

export async function getActiveMonitoringAlerts() {
  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT
       a.id,
       a.service_request_id,
       a.technician_id,
       a.reason_code,
       a.reason_text,
       a.risk_level,
       a.eta_minutes,
       a.eta_arrival,
       a.sla_deadline,
       a.technician_lat,
       a.technician_lng,
       a.customer_lat,
       a.customer_lng,
       a.last_detected_at,
       a.first_detected_at,
       sr.service_type,
       sr.status AS request_status,
       sr.address,
       sr.updated_at,
       t.name AS technician_name,
       t.phone AS technician_phone,
       t.rating AS technician_rating,
       t.acceptance_rate
     FROM job_monitoring_alerts a
     JOIN service_requests sr ON sr.id = a.service_request_id
     LEFT JOIN technicians t ON t.id = a.technician_id
     WHERE a.is_active = 1
     ORDER BY
       CASE a.risk_level WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END,
       a.last_detected_at DESC`
  );

  const byRequest = new Map();
  (rows || []).forEach((row) => {
    const requestId = Number(row.service_request_id);
    if (!byRequest.has(requestId)) {
      byRequest.set(requestId, {
        requestId,
        jobId: requestId,
        serviceType: row.service_type,
        status: row.request_status,
        customerLocation: {
          address: row.address || "Unknown location",
          lat: toNumber(row.customer_lat),
          lng: toNumber(row.customer_lng),
        },
        technician: {
          id: Number(row.technician_id),
          name: row.technician_name || `Technician #${row.technician_id}`,
          phone: row.technician_phone || "",
          rating: toNumber(row.technician_rating),
          acceptanceRate: toNumber(row.acceptance_rate),
          currentLat: toNumber(row.technician_lat),
          currentLng: toNumber(row.technician_lng),
        },
        reasons: [],
        etaMinutes: null,
        etaArrival: row.eta_arrival || null,
        slaDeadline: row.sla_deadline || null,
        timeRemainingMs: row.sla_deadline ? new Date(row.sla_deadline).getTime() - Date.now() : null,
        riskLevel: row.risk_level || "yellow",
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
      });
    }

    const item = byRequest.get(requestId);
    item.reasons.push({
      id: Number(row.id),
      code: row.reason_code,
      text: row.reason_text,
      riskLevel: row.risk_level,
      lastDetectedAt: row.last_detected_at,
    });

    if (item.etaMinutes == null && toNumber(row.eta_minutes) != null) {
      item.etaMinutes = toNumber(row.eta_minutes);
    }
    if (!item.etaArrival && row.eta_arrival) {
      item.etaArrival = row.eta_arrival;
    }
    if (item.riskLevel !== "red" && row.risk_level === "red") {
      item.riskLevel = "red";
    }
  });

  return Array.from(byRequest.values());
}

export async function getTechnicianTrackForRequest(requestId, limit = 80) {
  const parsedId = Number(requestId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    const error = new Error("requestId must be a positive integer.");
    error.statusCode = 400;
    throw error;
  }

  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.floor(parsedLimit), 10), 500) : 80;
  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT
       id,
       technician_id,
       service_request_id,
       latitude,
       longitude,
       captured_at
     FROM technician_location_history
     WHERE service_request_id = ?
     ORDER BY captured_at DESC
     LIMIT ?`,
    [parsedId, safeLimit]
  );

  const ordered = (rows || [])
    .slice()
    .reverse()
    .map((row) => ({
      id: Number(row.id),
      technicianId: Number(row.technician_id),
      requestId: Number(row.service_request_id),
      lat: toNumber(row.latitude),
      lng: toNumber(row.longitude),
      capturedAt: row.captured_at,
    }));

  return {
    requestId: parsedId,
    points: ordered,
  };
}

async function fetchRequestWithTechnician(requestId) {
  const parsedId = Number(requestId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    const error = new Error("requestId must be a positive integer.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT
       sr.*,
       t.name AS technician_name,
       t.phone AS technician_phone
     FROM service_requests sr
     LEFT JOIN technicians t ON t.id = sr.technician_id
     WHERE sr.id = ?
     LIMIT 1`,
    [parsedId]
  );

  if (!rows?.[0]) {
    const error = new Error("Service request not found.");
    error.statusCode = 404;
    throw error;
  }
  return rows[0];
}

export async function triggerTechnicianReminder({ requestId, adminId }) {
  const requestRow = await fetchRequestWithTechnician(requestId);
  if (!requestRow.technician_id) {
    const error = new Error("Request does not currently have an assigned technician.");
    error.statusCode = 409;
    throw error;
  }

  const payload = {
    requestId: Number(requestRow.id),
    message: `Reminder from Operations Command Center for Job #${Number(requestRow.id)}.`,
    at: new Date().toISOString(),
  };
  socketService.notifyTechnician(requestRow.technician_id, "command_center:reminder", payload);

  const pool = await getPool();
  await pool.execute(
    `INSERT INTO notifications (type, title, message, is_read)
     VALUES (?, ?, ?, 0)`,
    [
      "command_center_reminder",
      "Ops Reminder",
      `Admin ${String(adminId || "admin")} sent a reminder for job #${Number(requestRow.id)}.`,
    ]
  );

  return {
    success: true,
    requestId: Number(requestRow.id),
    technicianId: Number(requestRow.technician_id),
    technicianPhone: requestRow.technician_phone || "",
  };
}

export async function prepareTechnicianCall({ requestId }) {
  const requestRow = await fetchRequestWithTechnician(requestId);
  if (!requestRow.technician_id) {
    const error = new Error("Request does not currently have an assigned technician.");
    error.statusCode = 409;
    throw error;
  }
  return {
    requestId: Number(requestRow.id),
    technicianId: Number(requestRow.technician_id),
    technicianName: requestRow.technician_name || `Technician #${Number(requestRow.technician_id)}`,
    technicianPhone: requestRow.technician_phone || "",
  };
}

export async function reassignMonitoredRequest({ requestId, radiusKm = 35, maxCandidates = 5 }) {
  const requestRow = await fetchRequestWithTechnician(requestId);
  const pool = await getPool();
  const [technicianRows] = await pool.query("SELECT * FROM technicians");
  const { analysis } = jobDispatchService.analyzeTechnicians(requestRow, technicianRows, radiusKm);

  const currentTechnicianId = requestRow.technician_id == null ? null : Number(requestRow.technician_id);
  const ranked = analysis
    .filter((row) => row.eligible)
    .filter((row) => Number(row.technicianId) !== currentTechnicianId)
    .map((row) => {
      const source = technicianRows.find((item) => Number(item.id) === Number(row.technicianId)) || {};
      const acceptanceRate = Number(source.acceptance_rate ?? 0);
      const rating = Number(source.rating ?? 0);
      const distanceKm = Number(row.distanceKm ?? Number.POSITIVE_INFINITY);
      const reliabilityScore = Math.max(0, Math.min(1, acceptanceRate / 100)) * 0.6 + Math.max(0, Math.min(1, rating / 5)) * 0.4;
      const distanceScore = Number.isFinite(distanceKm) ? 1 / (1 + distanceKm) : 0;
      const totalScore = reliabilityScore * 0.6 + distanceScore * 0.4;
      return {
        ...source,
        distanceKm: Number.isFinite(distanceKm) ? round(distanceKm, 2) : null,
        acceptanceRate: Number.isFinite(acceptanceRate) ? round(acceptanceRate, 2) : 0,
        reliabilityScore: round(reliabilityScore * 100, 2),
        rankingScore: round(totalScore * 100, 2),
      };
    })
    .sort((left, right) => Number(right.rankingScore || 0) - Number(left.rankingScore || 0));

  const topCandidates = ranked.slice(0, Math.max(1, Math.min(Number(maxCandidates) || 5, 15)));
  if (topCandidates.length === 0) {
    return {
      success: false,
      requestId: Number(requestRow.id),
      candidatesFound: 0,
      message: "No eligible technicians found for reassignment.",
      candidates: [],
    };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lockedRows] = await conn.query(
      "SELECT id, technician_id FROM service_requests WHERE id = ? FOR UPDATE",
      [requestRow.id]
    );
    if (!lockedRows?.[0]) {
      const error = new Error("Service request not found.");
      error.statusCode = 404;
      throw error;
    }

    const prevTechnicianId = lockedRows[0].technician_id ? Number(lockedRows[0].technician_id) : null;
    await conn.execute(
      `UPDATE service_requests
       SET technician_id = NULL,
           status = 'pending',
           accepted_time = NULL,
           start_time = NULL,
           started_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [requestRow.id]
    );
    await conn.execute(
      `UPDATE dispatch_offers
       SET status = 'expired'
       WHERE service_request_id = ?
         AND LOWER(COALESCE(status, '')) IN ('pending', 'accepted')`,
      [requestRow.id]
    );

    if (prevTechnicianId) {
      await releaseTechnicianAvailability(conn, prevTechnicianId, requestRow.id);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await jobDispatchService.dispatchJob(requestRow, topCandidates);
  socketService.broadcast("admin:command_center_reassign", {
    requestId: Number(requestRow.id),
    candidates: topCandidates.map((candidate) => ({
      technicianId: Number(candidate.id),
      distanceKm: candidate.distanceKm,
      reliabilityScore: candidate.reliabilityScore,
      rankingScore: candidate.rankingScore,
    })),
    at: new Date().toISOString(),
  });

  return {
    success: true,
    requestId: Number(requestRow.id),
    candidatesFound: topCandidates.length,
    message: "Reassignment offers sent to nearby technicians.",
    candidates: topCandidates.map((candidate) => ({
      technicianId: Number(candidate.id),
      name: candidate.name,
      phone: candidate.phone || "",
      distanceKm: candidate.distanceKm,
      acceptanceRate: candidate.acceptanceRate,
      reliabilityScore: candidate.reliabilityScore,
      rankingScore: candidate.rankingScore,
    })),
  };
}
