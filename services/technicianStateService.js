import { requiredTowTruckType, evaluateTowTruckCapability } from "./towTruckCapability.js";
import { getVehicleServicePolicy, evaluateVehicleServiceSupport, loadChargingServiceProfiles } from './vehicleServiceCompatibility.js';

const ACTIVE_JOB_STATUSES = new Set([
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
  "en_route_pickup",
  "arrived_pickup",
  "vehicle_loaded",
  "enroute_drop",
  "arrived_drop",
  "service_completed",
]);

const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "cancelled",
  "rejected",
  "paid",
  "closed",
  "expired",
]);

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function toPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(normalizeStatus(status));
}

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(normalizeStatus(status));
}

export class JobOwnershipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.statusCode = 409;
  }
}

export async function createRequestWithReservation(pool, sql, values, technicianId, { afterReserve } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock capacity before inserting an assigned row. Competing direct bookings
    // must not hold each other's new request rows while waiting for this lock.
    if (technicianId) {
      await conn.query("SELECT id FROM technicians WHERE id = ? FOR UPDATE", [technicianId]);
    }
    const [result] = await conn.execute(sql, values);
    if (technicianId) await markTechnicianReserved(conn, technicianId, result.insertId);
    if (afterReserve) await afterReserve(conn, result);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

// Call only on the connection used for the assignment transaction. The technician
// row is the serialization point for all requests competing for this capacity.
export async function markTechnicianReserved(connOrPool, technicianId, requestId, { alreadyOwned = false, request = null } = {}) {
  const techId = toPositiveInt(technicianId);
  const jobId = toPositiveInt(requestId);
  if (!techId || !jobId) return false;

  const [rows] = await connOrPool.query("SELECT * FROM technicians WHERE id = ? FOR UPDATE", [techId]);
  const technician = rows[0];
  if (!technician) throw new JobOwnershipError("technician_not_found", "Technician not found.");
  const pointer = toPositiveInt(technician.current_job_id);
  if (pointer && pointer !== jobId) {
    throw new JobOwnershipError("technician_busy", "You already have another active job.");
  }
  // Use a current locking read: an earlier pricing query may have established a
  // repeatable-read snapshot before a competing reservation committed.
  const [activeJobs] = await connOrPool.query(
    `SELECT id FROM service_requests
     WHERE technician_id = ? AND id <> ?
       AND LOWER(TRIM(COALESCE(status, ''))) IN (${[...ACTIVE_JOB_STATUSES].map(() => "?").join(",")})
     LIMIT 1 FOR UPDATE`,
    [techId, jobId, ...ACTIVE_JOB_STATUSES]
  );
  if (activeJobs.length) throw new JobOwnershipError("technician_busy", "You already have another active job.");
  if (!alreadyOwned && pointer !== jobId && (
    normalizeStatus(technician.status) !== "approved" || !Number(technician.is_active) || !Number(technician.is_available)
  )) {
    throw new JobOwnershipError("technician_unavailable", "Technician is not currently available.");
  }

  // Every assignment path shares this gate, including direct bookings and admin assignment.
  const job = request || (await connOrPool.query("SELECT * FROM service_requests WHERE id = ? LIMIT 1", [jobId]))[0][0];
  const requiredType = requiredTowTruckType(job);
  const continuingOwnedJob = alreadyOwned && Number(job?.technician_id) === techId &&
    isActiveJobStatus(job?.status) && normalizeStatus(job?.status) !== "assigned";
  const vehiclePolicy = getVehicleServicePolicy(job);
  if (!continuingOwnedJob && (vehiclePolicy.family === 'ev' || vehiclePolicy.invalidCode)) {
    const [profile] = await loadChargingServiceProfiles(connOrPool, job, [technician]);
    const support = evaluateVehicleServiceSupport(job, profile);
    if (!support.eligible) throw new JobOwnershipError(support.code, 'This technician does not support this vehicle and service combination.');
  }
  if (requiredType !== null && !continuingOwnedJob) {
    const [fleet] = await connOrPool.query(
      "SELECT vehicle_type, status FROM technician_fleet_vehicles WHERE technician_id = ? ORDER BY id FOR UPDATE",
      [techId]
    );
    const capability = evaluateTowTruckCapability(requiredType, fleet);
    if (capability.code) throw new JobOwnershipError(capability.code, capability.reason);
  }

  const [result] = await connOrPool.query(
    `UPDATE technicians
     SET is_available = FALSE,
         current_job_id = ?
     WHERE id = ? AND (current_job_id IS NULL OR current_job_id = ?)`,
    [jobId, techId, jobId]
  );
  if (Number(result.affectedRows) !== 1) throw new JobOwnershipError("technician_busy", "You already have another active job.");
  return true;
}

export async function releaseTechnicianAvailability(connOrPool, technicianId, requestId = null) {
  const techId = toPositiveInt(technicianId);
  if (!techId) return false;

  const jobId = toPositiveInt(requestId);
  if (jobId) {
    await connOrPool.query(
      "UPDATE technicians SET current_job_id = NULL WHERE id = ? AND current_job_id = ?",
      [techId, jobId]
    );
    await connOrPool.query(
      `UPDATE technicians
       SET is_available = CASE
         WHEN is_active = TRUE AND LOWER(COALESCE(status, '')) = 'approved' AND current_job_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM service_requests sr WHERE sr.technician_id = technicians.id
               AND sr.id <> ? AND LOWER(TRIM(COALESCE(sr.status, ''))) IN (${[...ACTIVE_JOB_STATUSES].map(() => "?").join(",")})
           ) THEN TRUE
         ELSE FALSE
       END
       WHERE id = ?`,
      [jobId, ...ACTIVE_JOB_STATUSES, techId]
    );
    return true;
  }

  // An event without a request ID cannot safely release an owner's reservation.
  return false;
}

export async function reconcileTechnicianAvailability(connOrPool) {
  await connOrPool.query(
    `UPDATE technicians t
     LEFT JOIN (
       SELECT sr.technician_id, MAX(sr.id) AS active_request_id
       FROM service_requests sr
       WHERE sr.technician_id IS NOT NULL
         AND LOWER(COALESCE(sr.status, '')) IN (
           'assigned',
           'accepted',
           'processing',
           'service_started',
           'on-the-way',
           'en-route',
           'arrived',
           'in_progress',
           'in-progress',
           'awaiting_payment',
           'payment_pending',
           'en_route_pickup',
           'arrived_pickup',
           'vehicle_loaded',
           'enroute_drop',
           'arrived_drop',
           'service_completed'
         )
       GROUP BY sr.technician_id
     ) active ON active.technician_id = t.id
     SET t.current_job_id = active.active_request_id,
         t.is_available = CASE
           WHEN LOWER(COALESCE(t.status, '')) = 'approved'
                AND t.is_active = TRUE
                AND active.active_request_id IS NULL THEN TRUE
           ELSE FALSE
         END`
  );
}
