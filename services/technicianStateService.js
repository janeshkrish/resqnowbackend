const ACTIVE_JOB_STATUSES = new Set([
  "assigned",
  "accepted",
  "processing",
  "on-the-way",
  "en-route",
  "arrived",
  "in_progress",
  "in-progress",
  "payment_pending",
]);

const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "cancelled",
  "rejected",
  "paid",
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

export async function markTechnicianReserved(connOrPool, technicianId, requestId) {
  const techId = toPositiveInt(technicianId);
  const jobId = toPositiveInt(requestId);
  if (!techId || !jobId) return false;

  await connOrPool.query(
    `UPDATE technicians
     SET is_available = FALSE,
         current_job_id = ?
     WHERE id = ?`,
    [jobId, techId]
  );
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
         WHEN is_active = TRUE AND current_job_id IS NULL THEN TRUE
         ELSE FALSE
       END
       WHERE id = ?`,
      [techId]
    );
    return true;
  }

  await connOrPool.query(
    `UPDATE technicians
     SET current_job_id = NULL,
         is_available = CASE
           WHEN is_active = TRUE THEN TRUE
           ELSE FALSE
         END
     WHERE id = ?`,
    [techId]
  );
  return true;
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
           'on-the-way',
           'en-route',
           'arrived',
           'in_progress',
           'in-progress',
           'payment_pending'
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
