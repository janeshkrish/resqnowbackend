import { getPool } from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";
import { socketService } from "./socket.js";
import { closeRequestWithFinanceSync } from "./requestClosureService.js";

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
  const result = await closeRequestWithFinanceSync({
    requestId: parsedRequestId,
    status: closeStatus,
    reason: reason || "Closed by adminExtended override",
  });

  if (result.userId) {
    socketService.notifyUser(result.userId, "job:status_update", {
      requestId: parsedRequestId,
      status: result.status,
    });
  }

  if (result.technicianId) {
    socketService.notifyTechnician(result.technicianId, "job:status_update", {
      requestId: parsedRequestId,
      status: result.status,
    });
  }

  socketService.broadcast("admin:dispatch_override", {
    requestId: parsedRequestId,
    status: result.status,
    reason: reason || null,
    at: new Date().toISOString(),
  });
  socketService.broadcast("admin:request_status_updated", {
    requestId: parsedRequestId,
    status: result.status,
    previousStatus: result.previousStatus,
    at: new Date().toISOString(),
  });
  socketService.broadcast("admin:payment_update", {
    requestId: parsedRequestId,
    status: result.status,
    paymentRowsUpdated: result.paymentRowsUpdated,
    at: new Date().toISOString(),
  });
  socketService.broadcast("admin:analytics_update", {
    requestId: parsedRequestId,
    status: result.status,
    at: new Date().toISOString(),
  });

  return {
    requestId: parsedRequestId,
    status: result.status,
    previousStatus: result.previousStatus,
    paymentRowsUpdated: result.paymentRowsUpdated,
    alreadyTerminal: result.alreadyTerminal,
  };
}

