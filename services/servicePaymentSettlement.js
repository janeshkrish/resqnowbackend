import { recordId } from '../models/identifiers.js';

export const settlementConflict = (code, message) => Object.assign(new Error(message), { statusCode: 409, code });
export function serviceSettlementKey(requestId) {
  const id = recordId(requestId);
  if (!id) throw settlementConflict('INVALID_SERVICE_REQUEST', 'Invalid service request.');
  return `service-request:${id}`;
}

// Call after locking the request, on the same transaction connection. Legacy
// completed rows without a settlement key must also prevent another settlement.
export async function findCompletedServiceSettlement(conn, requestId) {
  const [rows] = await conn.query(`SELECT * FROM payments
    WHERE service_request_id = ? AND (LOWER(TRIM(status)) IN ('completed', 'paid') OR settlement_key IS NOT NULL)
    ORDER BY created_at DESC, id DESC LIMIT 2 FOR UPDATE`, [requestId]);
  if (rows.length > 1) throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'Multiple completed payments require reconciliation.');
  if (rows[0]?.settlement_key != null && (rows[0].settlement_key !== serviceSettlementKey(requestId) ||
      !['completed', 'paid'].includes(String(rows[0].status).trim().toLowerCase()))) {
    throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'The committed settlement state requires reconciliation.');
  }
  return rows[0] || null;
}

export function assertRequestNotCancelled(request) {
  if (['cancelled', 'canceled', 'rejected', 'expired'].includes(String(request.status || '').trim().toLowerCase())) {
    throw settlementConflict('REQUEST_NOT_PAYABLE', 'This request cannot be settled in its current state.');
  }
}
