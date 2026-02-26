import { getPool } from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";
import { socketService } from "./socket.js";

function adminExtendedParsePositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function adminExtendedNormalizeCloseStatus(value) {
  const normalized = String(value || "cancelled").trim().toLowerCase();
  return normalized === "completed" ? "completed" : "cancelled";
}

export async function adminExtendedForceAssign({ requestId, technicianId }) {
  const parsedRequestId = adminExtendedParsePositiveInt(requestId, "requestId");
  const parsedTechnicianId = adminExtendedParsePositiveInt(technicianId, "technicianId");

  const result = await jobDispatchService.acceptJob(parsedTechnicianId, parsedRequestId);
  return {
    requestId: parsedRequestId,
    technicianId: parsedTechnicianId,
    ...result,
  };
}

export async function adminExtendedReRouteSearchRadius({ requestId, radiusKm }) {
  const parsedRequestId = adminExtendedParsePositiveInt(requestId, "requestId");
  const parsedRadius = Number(radiusKm);
  const resolvedRadius = Number.isFinite(parsedRadius) && parsedRadius > 0 ? parsedRadius : null;

  const pool = await getPool();
  const [requestRows] = await pool.query(
    "SELECT * FROM service_requests WHERE id = ? LIMIT 1",
    [parsedRequestId]
  );
  if (requestRows.length === 0) {
    const error = new Error("Service request not found.");
    error.statusCode = 404;
    throw error;
  }

  const requestRow = requestRows[0];
  const candidates = await jobDispatchService.findTopTechnicians(requestRow, resolvedRadius);
  await jobDispatchService.dispatchJob(requestRow, candidates);

  return {
    requestId: parsedRequestId,
    radiusKm: resolvedRadius,
    candidatesFound: candidates.length,
    dispatchedCount: candidates.length,
  };
}

export async function adminExtendedManualCloseRequest({ requestId, status, reason }) {
  const parsedRequestId = adminExtendedParsePositiveInt(requestId, "requestId");
  const closeStatus = adminExtendedNormalizeCloseStatus(status);

  const pool = await getPool();
  const [requestRows] = await pool.query(
    `SELECT id, user_id, technician_id, status
     FROM service_requests
     WHERE id = ?
     LIMIT 1`,
    [parsedRequestId]
  );

  if (requestRows.length === 0) {
    const error = new Error("Service request not found.");
    error.statusCode = 404;
    throw error;
  }

  const existing = requestRows[0];
  const existingStatus = String(existing.status || "").toLowerCase();
  if (existingStatus === "completed" || existingStatus === "cancelled" || existingStatus === "paid") {
    return {
      requestId: parsedRequestId,
      status: existingStatus,
      alreadyTerminal: true,
    };
  }

  if (closeStatus === "completed") {
    await pool.execute(
      `UPDATE service_requests
       SET status = 'completed',
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [parsedRequestId]
    );
  } else {
    await pool.execute(
      `UPDATE service_requests
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancellation_reason = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [String(reason || "Closed by adminExtended override"), parsedRequestId]
    );
  }

  await pool.execute(
    `UPDATE dispatch_offers
     SET status = 'expired'
     WHERE service_request_id = ?
       AND status = 'pending'`,
    [parsedRequestId]
  );

  if (existing.user_id) {
    socketService.notifyUser(existing.user_id, "job:status_update", {
      requestId: parsedRequestId,
      status: closeStatus,
    });
  }

  if (existing.technician_id) {
    socketService.notifyTechnician(existing.technician_id, "job:status_update", {
      requestId: parsedRequestId,
      status: closeStatus,
    });
  }

  socketService.broadcast("admin:dispatch_override", {
    requestId: parsedRequestId,
    status: closeStatus,
    reason: reason || null,
    at: new Date().toISOString(),
  });

  return {
    requestId: parsedRequestId,
    status: closeStatus,
    alreadyTerminal: false,
  };
}

