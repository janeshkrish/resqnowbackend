import { recordId, isRecordId } from "../models/identifiers.js";
import { buildDispatchPricingSnapshot, readDispatchPricingSnapshot } from './dispatchPricingService.js';
import { getVehicleServicePolicy, evaluateVehicleServiceSupport, chargingCompatibility, loadChargingServiceProfiles } from './vehicleServiceCompatibility.js';

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
    const technicianId = recordId(technician.id ?? technician.technician_id);
    const status = String(current?.status || '').toLowerCase();
    if (!current || !['pending', 'assigned'].includes(status) ||
        (current.technician_id != null && recordId(current.technician_id) !== technicianId)) {
      throw unavailable('This request is no longer available for this technician.');
    }
    const policy = getVehicleServicePolicy(current);
    if (policy.family === 'ev' || policy.invalidCode) {
      let profile = technician;
      if (profile.vehicle_types == null) profile = (await conn.query('SELECT * FROM technicians WHERE id = ? LIMIT 1', [technicianId]))[0][0];
      if (profile) [profile] = await loadChargingServiceProfiles(conn, current, [profile]);
      const support = evaluateVehicleServiceSupport(current, profile);
      if (!support.eligible) throw unavailable('This technician does not support this vehicle and service combination.', support.code);
    }
    const charging = chargingCompatibility(current);
    if (!charging.eligible) throw unavailable('Choose a supported EV charging connector and vehicle brand.', charging.code);
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
    if (!isRecordId(recordId(result.insertId))) throw unavailable('The priced offer could not be saved.');
    if (ownsTransaction) await conn.commit();
    return { id: recordId(result.insertId), technician_id: technicianId, pricing_snapshot: snapshot, expires_at: expiresAt };
  } catch (error) {
    if (ownsTransaction) await conn.rollback();
    throw error;
  } finally { if (ownsTransaction) conn.release(); }
}

/** Same earnings meaning in queue, fallback, direct booking, list and push payloads. */
export function dispatchOfferPricingFields(offer) {
  const snapshot = readDispatchPricingSnapshot(offer?.pricing_snapshot);
  if (!snapshot) throw unavailable('The saved offer price is invalid.', 'pricing_unavailable');
  return { offerId: recordId(offer.id), offer_id: recordId(offer.id),
    amount: snapshot.technician_earning, priceAmount: snapshot.technician_earning,
    technicianEstimatedEarning: snapshot.technician_earning,
    technician_estimated_earning: snapshot.technician_earning,
    estimatedEarnings: snapshot.technician_earning,
    earningsSource: snapshot.earnings_source, earningsBreakdown: snapshot.pricing_breakdown,
    pricingBreakdown: snapshot.pricing_breakdown, finalEstimatedPrice: snapshot.customer_total_amount,
    expiresAt: offer.expires_at ?? null };
}
