import { estimateTechnicianEarningForRequest } from "./technicianEarningsService.js";
import { computeServiceRequestPaymentAmounts, normalizeServiceRequestPaymentMode } from "./serviceRequestPaymentService.js";
import { isTowingServiceType } from "./towingServiceType.js";
import { roundMoney } from "../utils/money.js";

const isObject = (value) => value != null && typeof value === "object" && !Array.isArray(value);
const parseObject = (value) => {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return isObject(parsed) ? parsed : null; }
  catch { return null; }
};
const positiveId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const money = (value) => {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? roundMoney(amount) : null;
};
const registeredSources = new Set(["technician", "technician_fleet", "technician_pricing"]);
const ACCEPTED_STATUSES = new Set(["accepted", "processing", "on-the-way", "on_the_way", "en-route", "en_route",
  "arrived", "service_started", "in-progress", "in_progress", "awaiting_payment", "payment_pending", "completed",
  "paid", "closed", "en_route_pickup", "arrived_pickup", "vehicle_loaded", "enroute_drop", "arrived_drop", "service_completed"]);

function unavailable(message = "Registered technician pricing is unavailable for this request.") {
  const error = new Error(message);
  error.code = "pricing_unavailable";
  error.statusCode = 409;
  return error;
}

/** Build once before dispatch; never trust the provisional request amount for a new offer. */
export async function buildDispatchPricingSnapshot({ request, technician = null, technicianId = null,
  connection = null, estimateEarning = estimateTechnicianEarningForRequest } = {}) {
  const requestId = positiveId(request?.id ?? request?.request_id ?? request?.requestId);
  const resolvedTechnicianId = positiveId(technicianId ?? technician?.id ?? technician?.technician_id ?? request?.technician_id);
  if (!requestId || !resolvedTechnicianId) throw unavailable("Request and technician IDs are required for offer pricing.");
  let earning;
  try {
    earning = await estimateEarning({ request, technician, technicianId: resolvedTechnicianId, connection,
      requireRegisteredPricing: true });
  } catch (cause) {
    const error = unavailable();
    error.cause = cause;
    throw error;
  }
  const technicianEarning = money(earning?.amount);
  if (technicianEarning == null || technicianEarning <= 0 || !registeredSources.has(earning?.source) ||
      String(earning?.currency || "INR").toUpperCase() !== "INR") throw unavailable();

  const bookingBreakdown = parseObject(request?.pricing_breakdown_json ?? request?.pricingBreakdown) || {};
  const taxPercent = isTowingServiceType(request?.service_type ?? request?.serviceType)
    ? Number(bookingBreakdown.tax_percent ?? 0) : 0;
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 1) throw unavailable("The towing tax pricing rule is invalid.");
  const taxAmount = roundMoney(technicianEarning * taxPercent);
  const customerBase = roundMoney(technicianEarning + taxAmount);
  const paymentMode = normalizeServiceRequestPaymentMode(request?.payment_method ?? request?.paymentMethod ?? request?.payment_mode, "cash");
  const payment = computeServiceRequestPaymentAmounts(customerBase, { currency: "INR", paymentMode,
    platformFeeDiscountPercent: request?.applied_discount_percent,
    platformFeeDiscountAmount: request?.applied_discount_amount });
  const result = {
    version: 1, request_id: requestId, technician_id: resolvedTechnicianId, currency: "INR",
    technician_earning: technicianEarning, customer_base_amount: customerBase,
    customer_total_amount: payment.totalAmount, payment_mode: paymentMode,
    platform_fee: payment.platformFee, payment_fee: payment.paymentFee, discount_amount: payment.discountAmount,
    pricing_breakdown: { ...(parseObject(earning?.breakdown) || {}),
      service_type: request?.service_type ?? request?.serviceType,
      vehicle_type: request?.vehicle_type ?? request?.vehicleType,
      vehicle_subtype: request?.vehicle_subtype ?? request?.vehicleSubtype ?? null,
      tow_truck_type: request?.tow_truck_type ?? request?.towTruckType ?? null,
      tax_percent: taxPercent, tax_amount: taxAmount,
      technician_earning: technicianEarning, base_amount: customerBase,
      platform_fee: payment.platformFee, original_platform_fee: payment.originalPlatformFee,
      discount_amount: payment.discountAmount, payment_fee: payment.paymentFee,
      final_estimated_price: payment.totalAmount },
    earnings_source: earning.source, calculated_at: new Date().toISOString(),
  };
  if (!readDispatchPricingSnapshot(result, { requestId, technicianId: resolvedTechnicianId })) throw unavailable();
  return result;
}

/** Validate the stored contract without any database/profile lookup or repricing. */
export function readDispatchPricingSnapshot(value, { requestId, technicianId } = {}) {
  const snapshot = parseObject(value);
  if (!snapshot || snapshot.version !== 1 || snapshot.currency !== "INR" ||
      !registeredSources.has(snapshot.earnings_source) || !isObject(snapshot.pricing_breakdown) ||
      !["cash", "upi"].includes(snapshot.payment_mode)) return null;
  const storedRequestId = positiveId(snapshot.request_id);
  const storedTechnicianId = positiveId(snapshot.technician_id);
  if (!storedRequestId || !storedTechnicianId ||
      (requestId != null && positiveId(requestId) !== storedRequestId) ||
      (technicianId != null && positiveId(technicianId) !== storedTechnicianId) ||
      (snapshot.offer_id != null && !positiveId(snapshot.offer_id))) return null;
  if (typeof snapshot.calculated_at !== "string" || !Number.isFinite(Date.parse(snapshot.calculated_at))) return null;
  const fields = ["technician_earning", "customer_base_amount", "customer_total_amount", "platform_fee", "payment_fee", "discount_amount"];
  const normalized = Object.fromEntries(fields.map((key) => [key, money(snapshot[key])]));
  if (fields.some((key) => normalized[key] == null) || normalized.technician_earning <= 0) return null;
  const taxPercent = snapshot.pricing_breakdown.tax_percent ?? 0;
  if (typeof taxPercent === "boolean" || !Number.isFinite(Number(taxPercent)) || Number(taxPercent) < 0 || Number(taxPercent) > 1) return null;
  const taxAmount = money(snapshot.pricing_breakdown.tax_amount ?? 0);
  if (taxAmount == null || taxAmount !== roundMoney(normalized.technician_earning * Number(taxPercent)) ||
      normalized.customer_base_amount !== roundMoney(normalized.technician_earning + taxAmount) ||
      normalized.customer_total_amount !== roundMoney(normalized.customer_base_amount + normalized.platform_fee + normalized.payment_fee)) return null;
  // Validate recorded arithmetic, not today's fee rules: an accepted contract stays valid
  // when platform/payment fee configuration changes in a future release.
  const originalFee = money(snapshot.pricing_breakdown.original_platform_fee ??
    roundMoney(normalized.platform_fee + normalized.discount_amount));
  if (originalFee == null || normalized.discount_amount > originalFee ||
      normalized.platform_fee !== roundMoney(originalFee - normalized.discount_amount)) return null;
  for (const [key, expected] of Object.entries({ technician_earning: normalized.technician_earning,
    base_amount: normalized.customer_base_amount, final_estimated_price: normalized.customer_total_amount,
    platform_fee: normalized.platform_fee, payment_fee: normalized.payment_fee, discount_amount: normalized.discount_amount })) {
    if (snapshot.pricing_breakdown[key] != null && money(snapshot.pricing_breakdown[key]) !== expected) return null;
  }
  // Only return a detached value: a consumer cannot mutate a previously read offer.
  try { return { ...JSON.parse(JSON.stringify(snapshot)), ...normalized, request_id: storedRequestId, technician_id: storedTechnicianId }; }
  catch { return null; }
}

/** Assignment reserves a candidate; it is not technician acceptance. */
export function hasAcceptedRequestPricing(request = {}) {
  const status = String(request.status || "").trim().toLowerCase();
  if (["pending", "requested", "assigned", ""].includes(status)) return false;
  if (ACCEPTED_STATUSES.has(status)) return true;
  if (!["cancelled", "canceled", "rejected"].includes(status)) return false;
  return [request.accepted_time, request.acceptedTime, request.started_at, request.start_time]
    .some((value) => value != null && value !== "" && Number.isFinite(new Date(value).getTime()));
}

export function acceptedPricingSnapshot(request = {}) {
  if (!hasAcceptedRequestPricing(request)) return null;
  const technicianId = positiveId(request.technician_id ?? request.technicianId);
  const requestId = positiveId(request.id ?? request.request_id ?? request.requestId);
  if (!requestId) return null;
  // Cancellation releases the technician reservation but must retain the accepted
  // receipt in customer history. Active jobs still require a matching current owner.
  const historical = ["cancelled", "canceled", "rejected", "completed", "paid", "closed"]
    .includes(String(request.status || "").trim().toLowerCase());
  if (!technicianId && !historical) return null;
  return readDispatchPricingSnapshot(request.pricing_snapshot ?? request.pricingSnapshot,
    { requestId, ...(technicianId ? { technicianId } : {}) });
}

const moneyField = (key) => /amount|price|fee|earning|charge|discount|commission|pricing|quote/i.test(key) &&
  !["pricing_status", "pricing_finalized"].includes(key);

function routeOnlyQuote(value) {
  if (Array.isArray(value)) return value.map(routeOnlyQuote);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !moneyField(key))
    .map(([key, entry]) => [key, routeOnlyQuote(entry)]));
}

/** Customer-facing rows expose an agreed price only after actual technician acceptance. */
export function customerPricingView(row = {}) {
  const finalized = hasAcceptedRequestPricing(row);
  const output = { ...row };
  if (!finalized) {
    for (const key of Object.keys(output)) {
      if (["towingQuote", "towing_quote"].includes(key)) {
        output[key] = routeOnlyQuote(parseObject(output[key]) || {});
        continue;
      }
      if (moneyField(key) || /^(payment|payments|paymentDetails|payment_details|paymentSummary|payment_summary)$/.test(key)) delete output[key];
    }
  } else {
    const snapshot = acceptedPricingSnapshot(row);
    if (snapshot) {
      // Checkout can change payment fees or platform-fee discounts while the
      // technician's service price stays fixed. Prefer the server's receipt total.
      const customerTotal = [row.finalAmount, row.final_amount, row.final_price]
        .map(money).find((value) => value != null && value >= snapshot.customer_base_amount)
        ?? snapshot.customer_total_amount;
      Object.assign(output, { amount: snapshot.customer_base_amount, price: snapshot.customer_base_amount,
        service_charge: snapshot.customer_base_amount, final_price: customerTotal,
        estimated_price: customerTotal, technician_estimated_earning: snapshot.technician_earning,
        pricing_snapshot: snapshot, pricing_breakdown_json: snapshot.pricing_breakdown });
    }
  }
  output.pricing_status = finalized ? "confirmed" : "pending";
  output.pricing_finalized = finalized;
  return output;
}
