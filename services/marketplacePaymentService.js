import { roundMoney } from "../utils/money.js";

export function buildMarketplacePricingSnapshot({ breakdown, coupon = null } = {}) {
  if (!breakdown) return null;
  return {
    currency: String(breakdown.currency || "INR").toUpperCase(),
    payment_mode: breakdown.paymentMode || breakdown.payment_mode || null,
    base_amount: roundMoney(breakdown.baseAmount || 0),
    platform_fee_percent: Number(breakdown.platformFeePercent || 0),
    original_platform_fee: roundMoney(breakdown.originalPlatformFee || 0),
    discount_amount: roundMoney(breakdown.discountAmount || 0),
    platform_fee: roundMoney(breakdown.platformFee || 0),
    payment_fee_percent: Number(breakdown.paymentFeePercent || 0),
    payment_fee: roundMoney(breakdown.paymentFee || 0),
    razorpay_fee: roundMoney(
      breakdown.razorpayFee ?? breakdown.paymentFee ?? 0
    ),
    total_amount: roundMoney(breakdown.totalAmount || 0),
    final_amount: roundMoney(
      breakdown.finalAmount ?? breakdown.totalAmount ?? 0
    ),
    coupon: coupon
      ? {
          applied_coupon_code: coupon.appliedCode || null,
          discount_percent: Number(coupon.discountPercent || 0),
        }
      : null,
  };
}

export async function findReusablePendingOrder(pool, { requestId, breakdown, maxAgeMinutes = 30 }) {
  const [rows] = await pool.query(
    `SELECT *
     FROM payments
     WHERE service_request_id = ?
       AND COALESCE(razorpay_payment_id, '') = ''
       AND LOWER(COALESCE(status, '')) IN ('pending', 'processing')
       AND COALESCE(razorpay_order_id, '') <> ''
       AND ABS(COALESCE(amount, 0) - ?) < 0.01
       AND ABS(COALESCE(platform_fee, 0) - ?) < 0.01
       AND ABS(COALESCE(payment_fee, 0) - ?) < 0.01
       AND ABS(COALESCE(base_amount, COALESCE(technician_amount, 0)) - ?) < 0.01
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
     ORDER BY id DESC
     LIMIT 1`,
    [
      requestId,
      roundMoney(breakdown.totalAmount || 0),
      roundMoney(breakdown.platformFee || 0),
      roundMoney(breakdown.paymentFee || 0),
      roundMoney(breakdown.baseAmount || 0),
      maxAgeMinutes,
    ]
  );
  return rows[0] || null;
}
