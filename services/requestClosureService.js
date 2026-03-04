import { getPool } from "../db.js";
import { releaseTechnicianAvailability } from "./technicianStateService.js";

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toPositiveRequestId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw createHttpError("requestId must be a positive integer.", 400);
  }
  return parsed;
}

function normalizeCloseStatus(value) {
  return String(value || "cancelled").trim().toLowerCase() === "completed"
    ? "completed"
    : "cancelled";
}

/**
 * Performs a status close/cancel flow atomically:
 * 1) update request status
 * 2) update payments status for completed/cancelled requests
 * 3) expire dispatch offers + release technician availability
 */
export async function closeRequestWithFinanceSync({ requestId, status, reason }) {
  const parsedRequestId = toPositiveRequestId(requestId);
  const closeStatus = normalizeCloseStatus(status);
  const closeReason = String(reason || "Closed by admin").trim() || "Closed by admin";

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [requestRows] = await conn.query(
      `SELECT id, user_id, technician_id, status
       FROM service_requests
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [parsedRequestId]
    );

    if (requestRows.length === 0) {
      throw createHttpError("Service request not found.", 404);
    }

    const existing = requestRows[0];
    const previousStatus = String(existing.status || "").toLowerCase();

    const alreadyInFinalState =
      (closeStatus === "cancelled" && previousStatus === "cancelled") ||
      (closeStatus === "completed" && (previousStatus === "completed" || previousStatus === "paid"));

    if (alreadyInFinalState) {
      const paymentStatus = closeStatus === "completed" ? "completed" : "cancelled";
      const paymentSettled = closeStatus === "completed";
      const [paymentUpdateResult] = await conn.execute(
        `UPDATE payments
         SET status = ?,
             is_settled = ?
         WHERE service_request_id = ?
           AND LOWER(COALESCE(status, '')) <> ?`,
        [paymentStatus, paymentSettled, parsedRequestId, paymentStatus]
      );
      await conn.commit();
      return {
        requestId: parsedRequestId,
        status: previousStatus,
        previousStatus,
        userId: existing.user_id || null,
        technicianId: existing.technician_id || null,
        paymentRowsUpdated: Number(paymentUpdateResult?.affectedRows || 0),
        alreadyTerminal: true,
      };
    }

    if (closeStatus === "completed") {
      if (previousStatus === "cancelled") {
        throw createHttpError("Cancelled request cannot be marked as completed.", 409);
      }

      await conn.execute(
        `UPDATE service_requests
         SET status = 'completed',
             completed_at = COALESCE(completed_at, NOW()),
             cancelled_at = NULL,
             cancellation_reason = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        [parsedRequestId]
      );
    } else {
      await conn.execute(
        `UPDATE service_requests
         SET status = 'cancelled',
             technician_id = NULL,
             cancelled_at = NOW(),
             cancellation_reason = ?,
             payment_status = 'cancelled',
             updated_at = NOW()
         WHERE id = ?`,
        [closeReason, parsedRequestId]
      );
    }

    const [offerUpdateResult] = await conn.execute(
      `UPDATE dispatch_offers
       SET status = 'expired'
       WHERE service_request_id = ?
         AND LOWER(COALESCE(status, '')) IN ('pending', 'accepted')`,
      [parsedRequestId]
    );

    const paymentStatus = closeStatus === "completed" ? "completed" : "cancelled";
    const paymentSettled = closeStatus === "completed";
    const [paymentUpdateResult] = await conn.execute(
      `UPDATE payments
       SET status = ?,
           is_settled = ?
       WHERE service_request_id = ?
         AND LOWER(COALESCE(status, '')) <> ?`,
      [paymentStatus, paymentSettled, parsedRequestId, paymentStatus]
    );
    const paymentRowsUpdated = Number(paymentUpdateResult?.affectedRows || 0);

    if (existing.technician_id) {
      await releaseTechnicianAvailability(conn, existing.technician_id, parsedRequestId);
    }

    await conn.commit();

    return {
      requestId: parsedRequestId,
      status: closeStatus,
      previousStatus,
      userId: existing.user_id || null,
      technicianId: existing.technician_id || null,
      paymentRowsUpdated,
      dispatchOffersUpdated: Number(offerUpdateResult?.affectedRows || 0),
      alreadyTerminal: false,
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
