import { buildDispatchPricingSnapshot, readDispatchPricingSnapshot } from './dispatchPricingService.js';

function unavailable(message, code = 'offer_unavailable') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

/** Persist an immutable quote before any socket, push, or list can advertise it. */
export async function createPricedDispatchOffer(pool, request, technician, options = {}) {
  const conn = options.connection || (pool.getConnection ? await pool.getConnection() : pool);
  const ownsTransaction = !options.connection && Boolean(pool.getConnection);
  try {
    if (ownsTransaction) await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM service_requests WHERE id = ? FOR UPDATE', [request.id]);
    const current = rows[0];
    const technicianId = Number(technician.id ?? technician.technician_id);
    const status = String(current?.status || '').toLowerCase();
    if (!current || !['pending', 'assigned'].includes(status) ||
        (current.technician_id != null && Number(current.technician_id) !== technicianId)) {
      throw unavailable('This request is no longer available for this technician.');
    }
    const snapshot = options.pricingSnapshot
      ? readDispatchPricingSnapshot(options.pricingSnapshot, { requestId: current.id, technicianId })
      : await buildDispatchPricingSnapshot({ request: current, technician, technicianId, connection: conn,
          ...(options.estimateEarning ? { estimateEarning: options.estimateEarning } : {}) });
    if (!snapshot) throw unavailable('No valid registered price is available for this offer.', 'pricing_unavailable');
    const expiresAt = options.expiresAt !== undefined ? options.expiresAt
      : new Date(Date.now() + (options.timeoutMs ?? 20_000));
    await conn.query("UPDATE dispatch_offers SET status = 'expired', expires_at = COALESCE(expires_at, NOW()) WHERE service_request_id = ? AND technician_id = ? AND status = 'pending'", [current.id, technicianId]);
    const [result] = await conn.query(
      "INSERT INTO dispatch_offers (service_request_id, technician_id, status, sent_at, expires_at, pricing_snapshot) VALUES (?, ?, 'pending', NOW(), ?, ?)",
      [current.id, technicianId, expiresAt, JSON.stringify(snapshot)]
    );
    if (!Number.isSafeInteger(Number(result.insertId)) || Number(result.insertId) <= 0) throw unavailable('The priced offer could not be saved.');
    if (ownsTransaction) await conn.commit();
    return { id: Number(result.insertId), technician_id: technicianId, pricing_snapshot: snapshot, expires_at: expiresAt };
  } catch (error) {
    if (ownsTransaction) await conn.rollback();
    throw error;
  } finally { if (ownsTransaction) conn.release(); }
}

/** Same earnings meaning in queue, fallback, direct booking, list and push payloads. */
export function dispatchOfferPricingFields(offer) {
  const snapshot = readDispatchPricingSnapshot(offer?.pricing_snapshot);
  if (!snapshot) throw unavailable('The saved offer price is invalid.', 'pricing_unavailable');
  return { offerId: Number(offer.id), offer_id: Number(offer.id),
    amount: snapshot.technician_earning, priceAmount: snapshot.technician_earning,
    technicianEstimatedEarning: snapshot.technician_earning,
    technician_estimated_earning: snapshot.technician_earning,
    estimatedEarnings: snapshot.technician_earning,
    earningsSource: snapshot.earnings_source, earningsBreakdown: snapshot.pricing_breakdown,
    pricingBreakdown: snapshot.pricing_breakdown, finalEstimatedPrice: snapshot.customer_total_amount,
    expiresAt: offer.expires_at ?? null };
}
