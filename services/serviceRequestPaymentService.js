import { roundMoney } from "../utils/money.js";
import { acceptedPricingSnapshot } from "./dispatchPricingService.js";

export const SERVICE_REQUEST_PLATFORM_FEE_PERCENT = 0.1;
export const SERVICE_REQUEST_RAZORPAY_FEE = 2;

const COMPLETED_PAYMENT_STATUSES = new Set(["paid", "completed"]);

const toFiniteMoney = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : null;
};

const parsePaymentSnapshot = (value) => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

// A registered rate may change after acceptance. Billing must read the accepted
// agreement, or the recorded amounts for an historical job, never today's rates.
export function resolveServiceRequestBillingBase(requestRow) {
  const snapshot = acceptedPricingSnapshot(requestRow || {});
  return toFiniteMoney(snapshot?.customer_base_amount ?? requestRow?.amount ?? requestRow?.service_charge);
}

export function resolveServiceRequestTechnicianAmount(requestRow) {
  const snapshot = acceptedPricingSnapshot(requestRow || {});
  return toFiniteMoney(snapshot?.technician_earning ?? requestRow?.technician_estimated_earning ?? requestRow?.amount ?? requestRow?.service_charge);
}

const toPercent = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(1, Math.max(0, parsed));
};

const toBoolean = (value) => {
  if (typeof value === "boolean") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0;
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "yes", "y"].includes(normalized);
};

const isCompletedPayment = (requestRow, paymentRow) => {
  const requestPaymentStatus = String(requestRow?.payment_status || "").trim().toLowerCase();
  const requestStatus = String(requestRow?.status || "").trim().toLowerCase();
  const paymentStatus = String(paymentRow?.status || "").trim().toLowerCase();

  return (
    COMPLETED_PAYMENT_STATUSES.has(requestPaymentStatus) ||
    COMPLETED_PAYMENT_STATUSES.has(requestStatus) ||
    COMPLETED_PAYMENT_STATUSES.has(paymentStatus)
  );
};

export function normalizeServiceRequestPaymentMode(value, fallback = null) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "cash" || normalized === "cod") return "cash";
  if (["upi", "razorpay", "online", "card", "netbanking"].includes(normalized)) return "upi";
  return fallback;
}

export function computeServiceRequestPaymentAmounts(baseAmount, options = {}) {
  const safeBase = roundMoney(Math.max(0, Number(baseAmount) || 0));
  const paymentMode = normalizeServiceRequestPaymentMode(options?.paymentMode, "cash");
  const originalPlatformFee = roundMoney(safeBase * SERVICE_REQUEST_PLATFORM_FEE_PERCENT);
  const discountPercent = toPercent(options?.platformFeeDiscountPercent);
  const discountAmountByPercent = roundMoney(originalPlatformFee * discountPercent);
  const explicitDiscountAmount = toFiniteMoney(options?.platformFeeDiscountAmount);
  const discountAmount = roundMoney(
    Math.min(
      originalPlatformFee,
      Math.max(0, explicitDiscountAmount ?? discountAmountByPercent ?? 0)
    )
  );
  const platformFee = roundMoney(Math.max(0, originalPlatformFee - discountAmount));
  const razorpayFee = paymentMode === "upi" ? SERVICE_REQUEST_RAZORPAY_FEE : 0;
  const finalAmount = roundMoney(safeBase + platformFee + razorpayFee);

  return {
    currency: String(options?.currency || "INR").toUpperCase(),
    paymentMode,
    baseAmount: safeBase,
    platformFeePercent: SERVICE_REQUEST_PLATFORM_FEE_PERCENT,
    originalPlatformFee,
    discountAmount,
    platformFee,
    paymentFeePercent: 0,
    paymentFee: razorpayFee,
    razorpayFee,
    totalAmount: finalAmount,
    finalAmount,
  };
}

export function buildServiceRequestPaymentDetails({
  requestRow = null,
  paymentRow = null,
  baseAmount = null,
  currency = "INR",
  fallbackPaymentMode = null,
} = {}) {
  const acceptedSnapshot = acceptedPricingSnapshot(requestRow || {});
  const storedPaymentSnapshot = parsePaymentSnapshot(paymentRow?.pricing_snapshot);
  const resolvedBaseAmount =
    toFiniteMoney(
      acceptedSnapshot?.customer_base_amount ??
        paymentRow?.base_amount ??
        paymentRow?.baseAmount ??
        paymentRow?.technician_amount ??
        paymentRow?.technicianAmount ??
        requestRow?.base_amount ??
        requestRow?.baseAmount ??
        baseAmount ??
        requestRow?.amount ??
        requestRow?.service_charge ??
        requestRow?.serviceCharge
    ) ?? 0;

  const requestedMode = normalizeServiceRequestPaymentMode(
    paymentRow?.payment_method ??
      paymentRow?.paymentMethod ??
      paymentRow?.payment_mode ??
      paymentRow?.paymentMode ??
      requestRow?.payment_method ??
      requestRow?.paymentMethod ??
      requestRow?.payment_mode ??
      requestRow?.paymentMode ??
      acceptedSnapshot?.payment_mode,
    fallbackPaymentMode
  );

  const computed = computeServiceRequestPaymentAmounts(resolvedBaseAmount, {
    currency: paymentRow?.currency ?? requestRow?.currency ?? currency,
    paymentMode: requestedMode ?? "cash",
    platformFeeDiscountPercent: requestRow?.applied_discount_percent,
    platformFeeDiscountAmount: requestRow?.applied_discount_amount ??
      (requestRow?.applied_discount_percent != null ? null : acceptedSnapshot?.discount_amount),
  });
  const preservesSnapshotDiscount = acceptedSnapshot && computed.discountAmount === acceptedSnapshot.discount_amount;

  const explicitPlatformFee = toFiniteMoney(
    paymentRow?.platform_fee ??
      paymentRow?.platformFee ??
      (preservesSnapshotDiscount ? acceptedSnapshot.platform_fee : null) ??
      (acceptedSnapshot ? null : requestRow?.platform_fee) ??
      (acceptedSnapshot ? null : requestRow?.platformFee)
  );
  const explicitRazorpayFee = toFiniteMoney(
    paymentRow?.payment_fee ??
      paymentRow?.paymentFee ??
      paymentRow?.razorpay_fee ??
      paymentRow?.razorpayFee ??
      (acceptedSnapshot && requestedMode === acceptedSnapshot.payment_mode ? acceptedSnapshot.payment_fee : null) ??
      (acceptedSnapshot ? null : requestRow?.payment_fee) ??
      (acceptedSnapshot ? null : requestRow?.paymentFee) ??
      (acceptedSnapshot ? null : requestRow?.razorpay_fee) ??
      (acceptedSnapshot ? null : requestRow?.razorpayFee)
  );

  const paymentMode =
    requestedMode ??
    (explicitRazorpayFee != null && explicitRazorpayFee > 0 ? "upi" : fallbackPaymentMode);

  const platformFee = explicitPlatformFee ?? computed.platformFee;
  const originalPlatformFee = toFiniteMoney(storedPaymentSnapshot?.original_platform_fee) ?? computed.originalPlatformFee;
  const discountAmount = toFiniteMoney(storedPaymentSnapshot?.discount_amount) ??
    (paymentRow && explicitPlatformFee != null ? roundMoney(Math.max(0, originalPlatformFee - platformFee)) : computed.discountAmount);
  const razorpayFee =
    explicitRazorpayFee ?? (paymentMode === "upi" ? SERVICE_REQUEST_RAZORPAY_FEE : 0);
  const finalAmount =
    toFiniteMoney(
      paymentRow?.amount ??
        paymentRow?.final_amount ??
        paymentRow?.finalAmount ??
        (acceptedSnapshot ? null : requestRow?.final_amount) ??
        (acceptedSnapshot ? null : requestRow?.finalAmount)
    ) ?? roundMoney(resolvedBaseAmount + platformFee + razorpayFee);

  const isSettled = paymentRow ? toBoolean(paymentRow?.is_settled) : false;
  const dueAmount =
    paymentMode === "cash" && isCompletedPayment(requestRow, paymentRow) && !isSettled
      ? platformFee
      : 0;

  return {
    currency: computed.currency,
    paymentMode,
    payment_mode: paymentMode,
    baseAmount: resolvedBaseAmount,
    base_amount: resolvedBaseAmount,
    platformFeePercent: computed.platformFeePercent,
    platform_fee_percent: computed.platformFeePercent,
    originalPlatformFee,
    original_platform_fee: originalPlatformFee,
    discountAmount,
    discount_amount: discountAmount,
    platformFee,
    platform_fee: platformFee,
    paymentFeePercent: 0,
    payment_fee_percent: 0,
    paymentFee: razorpayFee,
    payment_fee: razorpayFee,
    razorpayFee,
    razorpay_fee: razorpayFee,
    totalAmount: finalAmount,
    total_amount: finalAmount,
    finalAmount,
    final_amount: finalAmount,
    dueAmount,
    due_amount: dueAmount,
    isSettled,
    is_settled: isSettled,
  };
}
