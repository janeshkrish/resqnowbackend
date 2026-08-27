import { roundMoney } from "../utils/money.js";

export const SERVICE_REQUEST_PLATFORM_FEE_PERCENT = 0.1;
export const SERVICE_REQUEST_RAZORPAY_FEE = 2;

const COMPLETED_PAYMENT_STATUSES = new Set(["paid", "completed"]);

const toFiniteMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMoney(parsed) : null;
};

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
  const resolvedBaseAmount =
    toFiniteMoney(
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
      requestRow?.paymentMode,
    fallbackPaymentMode
  );

  const computed = computeServiceRequestPaymentAmounts(resolvedBaseAmount, {
    currency: paymentRow?.currency ?? requestRow?.currency ?? currency,
    paymentMode: requestedMode ?? "cash",
    platformFeeDiscountPercent: requestRow?.applied_discount_percent,
    platformFeeDiscountAmount: requestRow?.applied_discount_amount,
  });

  const explicitPlatformFee = toFiniteMoney(
    paymentRow?.platform_fee ??
      paymentRow?.platformFee ??
      requestRow?.platform_fee ??
      requestRow?.platformFee
  );
  const explicitRazorpayFee = toFiniteMoney(
    paymentRow?.payment_fee ??
      paymentRow?.paymentFee ??
      paymentRow?.razorpay_fee ??
      paymentRow?.razorpayFee ??
      requestRow?.payment_fee ??
      requestRow?.paymentFee ??
      requestRow?.razorpay_fee ??
      requestRow?.razorpayFee
  );

  const paymentMode =
    requestedMode ??
    (explicitRazorpayFee != null && explicitRazorpayFee > 0 ? "upi" : fallbackPaymentMode);

  const platformFee = explicitPlatformFee ?? computed.platformFee;
  const razorpayFee =
    explicitRazorpayFee ?? (paymentMode === "upi" ? SERVICE_REQUEST_RAZORPAY_FEE : 0);
  const finalAmount =
    toFiniteMoney(
      paymentRow?.amount ??
        paymentRow?.final_amount ??
        paymentRow?.finalAmount ??
        requestRow?.final_amount ??
        requestRow?.finalAmount
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
    originalPlatformFee: computed.originalPlatformFee,
    original_platform_fee: computed.originalPlatformFee,
    discountAmount: computed.discountAmount,
    discount_amount: computed.discountAmount,
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
