import { recordId, isRecordId } from "../models/identifiers.js";
import { compactPaymentReceipt } from "../utils/paymentReference.js";
import { createAccountPaymentService } from "../services/accountPaymentService.js";
import { assertCashPayable, readCashIntent, createCashIntent, assertCashReceipt, publicCashIntent } from "../services/cashReceiptPolicy.js";
import { serviceSettlementKey, findCompletedServiceSettlement, assertRequestNotCancelled, settlementConflict } from "../services/servicePaymentSettlement.js";

import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getPool } from "../db.js";
import { verifyAdmin, verifyTechnician, verifyUser } from "../middleware/auth.js";
import { socketService } from "../services/socket.js";
import { generateInvoicePDF } from "../services/invoiceService.js";
import { sendInvoiceEmail } from "../services/mailer.js";
import {
    getPlatformPricingConfig,
    getSubscriptionPlanById,
    listSubscriptionPlans
} from "../services/platformPricing.js";
import { releaseTechnicianAvailability } from "../services/technicianStateService.js";
import { buildMarketplacePricingSnapshot, findReusablePendingOrder } from "../services/marketplacePaymentService.js";
import { creditTechnicianWalletForPayment } from "../services/marketplaceWalletService.js";
import {
    computeServiceRequestPaymentAmounts,
    buildServiceRequestPaymentDetails,
    resolveServiceRequestBillingBase,
    resolveServiceRequestTechnicianAmount,
} from "../services/serviceRequestPaymentService.js";
import {
    PAYMENT_LEDGER_STATUS,
    PAYMENT_TO_TECHNICIAN_STATUS,
} from "../models/marketplaceConstants.js";
import { isTowingServiceType } from "../services/towingServiceType.js";
import { recordRequestEvent } from "../services/requestEvents.js";
import { acceptedPricingSnapshot, hasAcceptedRequestPricing } from "../services/dispatchPricingService.js";

const router = express.Router();
const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "");
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "");
const RAZORPAY_WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET || RAZORPAY_KEY_SECRET || "");
const hasRazorpayConfig = Boolean(
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET &&
    !RAZORPAY_KEY_ID.includes("placeholder") &&
    !RAZORPAY_KEY_SECRET.includes("placeholder")
);

const razorpay = hasRazorpayConfig
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
    })
    : null;

const accountPayments = async () => createAccountPaymentService({
    pool: await getPool(), gateway: razorpay, keySecret: RAZORPAY_KEY_SECRET,
});
const accountPaymentError = (res, error) => res.status(error.statusCode || 503).json({
    error: error.statusCode ? error.message : "Payment could not be saved. Please retry confirmation.",
    code: error.code && error.statusCode ? error.code : "PAYMENT_STORAGE_UNAVAILABLE",
});

const ensureRazorpayConfigured = (res) => {
    if (hasRazorpayConfig) return true;
    res.status(503).json({
        error: "Payment gateway is not configured. Please contact support."
    });
    return false;
};

function sendDeprecatedPaymentRoute(res, replacementPath, details) {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Wed, 31 Dec 2026 23:59:59 GMT");
    return res.status(410).json({
        error: "This payment endpoint has been deprecated. Use the canonical /api/payments/* service-request flow instead.",
        deprecated: true,
        replacement: replacementPath,
        details,
    });
}

function paymentDiag(event, data = {}) {
    console.log("[PAYMENT_DIAG]", JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...data
    }));
}

const toPositiveMoney = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const safeParseObject = (value) => {
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const serializeServiceRequestRow = (row) =>
    row
        ? {
            ...row,
            isTowing: isTowingServiceType(row.service_type),
        }
        : null;

async function resolveTechnicianPaymentAmount({ requestRow, technicianProfile = null, connection = null }) {
    if (!requestRow?.technician_id) return null;
    return resolveServiceRequestTechnicianAmount(requestRow);
}

function ensureRequestAcceptedForPayment(res, requestRow) {
    if (hasAcceptedRequestPricing(requestRow) &&
        !["cancelled", "canceled", "rejected", "expired"].includes(String(requestRow?.status || "").toLowerCase())) {
        const base = resolveServiceRequestBillingBase(requestRow);
        const earning = resolveServiceRequestTechnicianAmount(requestRow);
        if (base == null || earning == null || base <= 0 || earning <= 0 || earning > base) {
            res.status(409).json({ code: "UNFUNDED_ACCEPTED_PRICE", error: "This recorded price cannot fund the technician's agreed earnings. Contact support to reconcile the request." });
            return false;
        }
        return true;
    }
    res.status(409).json({ error: "The service price is available only after a technician accepts the request.", code: "PRICE_NOT_ACCEPTED" });
    return false;
}

function paymentMatchesAcceptedPrice(requestRow, paymentRow) {
    const snapshot = acceptedPricingSnapshot(requestRow || {});
    if (!snapshot) return true; // Historical accepted jobs retain their recorded payment contract.
    return paymentRow?.base_amount != null && paymentRow?.technician_amount != null &&
        Math.abs(Number(paymentRow.base_amount) - snapshot.customer_base_amount) < 0.005 &&
        Math.abs(Number(paymentRow.technician_amount) - snapshot.technician_earning) < 0.005 &&
        String(paymentRow.currency || "INR").toUpperCase() === snapshot.currency;
}

function gatewayPaymentMismatch(paymentRow, gatewayPayment, { orderId, paymentId, requestRow = null, requireCaptured = true } = {}) {
    if (String(gatewayPayment?.order_id || "") !== String(orderId) ||
        String(gatewayPayment?.id || "") !== String(paymentId) ||
        String(paymentRow?.razorpay_order_id || "") !== String(orderId)) return "payment_order_mismatch";
    const gatewayAmount = Number(gatewayPayment?.amount);
    const storedAmount = Number(paymentRow?.amount);
    const checkoutFields = ["base_amount", "platform_fee", "payment_fee", "technician_amount"];
    if (checkoutFields.some(field => paymentRow?.[field] == null || !Number.isFinite(Number(paymentRow[field])) || Number(paymentRow[field]) < 0) ||
        !Number.isFinite(storedAmount) || storedAmount <= 0 || Number(paymentRow.technician_amount) <= 0 ||
        Number(paymentRow.technician_amount) > Number(paymentRow.base_amount) ||
        Math.round((Number(paymentRow.base_amount) + Number(paymentRow.platform_fee) + Number(paymentRow.payment_fee)) * 100) !== Math.round(storedAmount * 100)) return "invalid_checkout_contract";
    if (gatewayPayment?.amount == null || typeof gatewayPayment.amount === "boolean" ||
        !Number.isSafeInteger(gatewayAmount) || gatewayAmount <= 0 ||
        paymentRow?.amount == null || !Number.isFinite(storedAmount) || storedAmount <= 0 ||
        typeof gatewayPayment?.currency !== "string" || !gatewayPayment.currency.trim()) return "invalid_captured_price";
    if (gatewayAmount !== Math.round(storedAmount * 100)) return "captured_amount_mismatch";
    if (gatewayPayment.currency.toUpperCase() !== String(paymentRow.currency || "INR").toUpperCase()) return "captured_currency_mismatch";
    const requestId = String(paymentRow.service_request_id ?? "");
    const userId = String(paymentRow.user_id ?? "");
    const notedRequestId = gatewayPayment?.notes?.requestId ?? gatewayPayment?.notes?.request_id;
    const notedUserId = gatewayPayment?.notes?.userId ?? gatewayPayment?.notes?.user_id;
    if (!requestId || !userId ||
        (requestRow && (requestId !== String(requestRow.id) || userId !== String(requestRow.user_id))) ||
        (notedRequestId != null && String(notedRequestId) !== requestId) ||
        (notedUserId != null && String(notedUserId) !== userId)) return "payment_request_mismatch";
    const gatewayStatus = String(gatewayPayment.status || "").toLowerCase();
    const isCaptured = gatewayStatus === "captured" && gatewayPayment.captured !== false;
    if (requireCaptured && !isCaptured) return "payment_not_captured";
    if (!requireCaptured && !["authorized", "captured"].includes(gatewayStatus)) return "payment_not_successful";
    if (["paid", "completed"].includes(String(paymentRow.status || "").toLowerCase()) &&
        paymentRow.razorpay_payment_id && String(paymentRow.razorpay_payment_id) !== String(paymentId)) return "payment_id_mismatch";
    return null;
}

function paymentVerificationError(code, message) {
    return Object.assign(new Error(message), { statusCode: 409, code });
}

const normalizeCouponCode = (value) => String(value || "").trim().toUpperCase();

const toPercentOrZero = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(1, Math.max(0, parsed));
};

const isRequestAlreadyPaid = (requestRow) => {
    const status = String(requestRow?.status || "").toLowerCase();
    const paymentStatus = String(requestRow?.payment_status || "").toLowerCase();
    return ["paid", "completed"].includes(status) || ["paid", "completed"].includes(paymentStatus);
};

function getStoredDiscountOptions(requestRow) {
    const storedPercent = toPercentOrZero(requestRow?.applied_discount_percent);
    const storedAmount = Number(requestRow?.applied_discount_amount);
    if (Number.isFinite(storedAmount) && storedAmount > 0) {
        return {
            platformFeeDiscountAmount: storedAmount,
            platformFeeDiscountPercent: storedPercent,
        };
    }
    if (storedPercent > 0) {
        return {
            platformFeeDiscountPercent: storedPercent,
        };
    }
    return {};
}

async function evaluateWelcomeCouponForRequest({
    pool,
    userId,
    requestRow,
    pricingConfig,
    couponCode,
    preserveExistingApplied = false,
}) {
    const configuredCode = normalizeCouponCode(pricingConfig?.welcome_coupon_code);
    const providedCode = normalizeCouponCode(couponCode);
    const couponDiscountPercent = toPercentOrZero(pricingConfig?.welcome_coupon_discount_percent);
    const maxUsesPerUser = Math.max(
        0,
        Number.parseInt(String(pricingConfig?.welcome_coupon_max_uses_per_user || 0), 10) || 0
    );
    const couponActive =
        Boolean(pricingConfig?.welcome_coupon_active) &&
        Boolean(configuredCode) &&
        couponDiscountPercent > 0 &&
        maxUsesPerUser > 0;
    const requestId = recordId(requestRow?.id);

    const [completedRows] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM service_requests
         WHERE user_id = ?
           AND id <> ?
           AND (
             LOWER(COALESCE(payment_status, '')) IN ('completed', 'paid')
             OR LOWER(COALESCE(status, '')) IN ('paid', 'completed')
           )`,
        [userId, requestId]
    );
    const completedServicesCount = Number(completedRows?.[0]?.count || 0);

    let reservedCouponCount = 0;
    if (configuredCode) {
        const [reservedRows] = await pool.query(
            `SELECT COUNT(*) AS count
             FROM service_requests
             WHERE user_id = ?
               AND id <> ?
               AND LOWER(COALESCE(status, '')) <> 'cancelled'
               AND LOWER(COALESCE(payment_status, '')) NOT IN ('completed', 'paid')
               AND UPPER(COALESCE(applied_coupon_code, '')) = ?`,
            [userId, requestId, configuredCode]
        );
        reservedCouponCount = Number(reservedRows?.[0]?.count || 0);
    }

    const remainingEligibleUses = Math.max(
        0,
        maxUsesPerUser - completedServicesCount - reservedCouponCount
    );

    const existingAppliedCode = normalizeCouponCode(requestRow?.applied_coupon_code);
    const hasExistingCouponReservation =
        existingAppliedCode === configuredCode &&
        toPercentOrZero(requestRow?.applied_discount_percent) > 0 &&
        String(requestRow?.status || "").toLowerCase() !== "cancelled";

    let isApplied = false;
    let reason = null;

    if (!providedCode) {
        if (preserveExistingApplied && hasExistingCouponReservation && couponActive) {
            isApplied = true;
        }
    } else if (!couponActive) {
        reason = "This coupon is currently inactive.";
    } else if (providedCode !== configuredCode) {
        reason = "Invalid coupon code.";
    } else if (!hasExistingCouponReservation && remainingEligibleUses <= 0) {
        reason = `Coupon is valid only for your first ${maxUsesPerUser} paid services.`;
    } else {
        isApplied = true;
    }

    return {
        active: couponActive,
        configuredCode,
        providedCode,
        discountPercent: couponDiscountPercent,
        maxUsesPerUser,
        completedServicesCount,
        reservedCouponCount,
        remainingEligibleUses,
        hasExistingCouponReservation,
        isApplied,
        appliedCode: isApplied ? configuredCode : null,
        reason,
    };
}

async function buildServiceRequestPaymentQuote({
    pool,
    requestRow,
    pricingConfig,
    couponCode = "",
    preserveExistingApplied = false,
    paymentMode = "cash",
}) {
    const userId = recordId(requestRow?.user_id);
    const baseAmount = await resolveRequestBaseAmount(requestRow, pricingConfig);
    const coupon = await evaluateWelcomeCouponForRequest({
        pool,
        userId,
        requestRow,
        pricingConfig,
        couponCode,
        preserveExistingApplied,
    });

    const breakdown = computeServiceRequestPaymentAmounts(baseAmount, {
        currency: pricingConfig?.currency,
        paymentMode,
        platformFeeDiscountPercent: coupon.isApplied ? coupon.discountPercent : 0,
    });

    return {
        breakdown,
        coupon,
    };
}

async function resolveRequestBaseAmount(requestRow, pricingConfig) {
    const amount = resolveServiceRequestBillingBase(requestRow);
    if (amount == null || amount < 0) throw new Error("Accepted service price is missing; registered rates cannot be substituted at payment.");
    return amount;
}

function timingSafeEqualHex(left, right) {
    const a = Buffer.from(String(left || ""), "utf8");
    const b = Buffer.from(String(right || ""), "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

async function upsertPendingRazorpayPayment({
    pool,
    userId,
    requestId,
    orderId,
    breakdown,
    coupon = null,
    technicianAmount = null,
}) {
    const resolvedTechnicianAmount = toPositiveMoney(technicianAmount) ?? breakdown.baseAmount;
    const pricingSnapshot = { ...buildMarketplacePricingSnapshot({ breakdown, coupon }), technician_amount: resolvedTechnicianAmount };
    const [existing] = await pool.query(
        `SELECT id
         FROM payments
         WHERE service_request_id = ? AND razorpay_order_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [requestId, orderId]
    );

    if (existing.length > 0) {
        const [pendingUpdate] = await pool.execute(
            `UPDATE payments
             SET status = ?, currency = ?, amount = ?, base_amount = ?, platform_fee = ?, payment_fee = ?,
                 technician_amount = ?, is_settled = TRUE, payment_to_technician_status = ?, ledger_status = ?, pricing_snapshot = ?
             WHERE id = ? AND settlement_key IS NULL AND LOWER(TRIM(status)) NOT IN ('completed', 'paid')`,
            [
                "PENDING",
                breakdown.currency,
                breakdown.totalAmount,
                breakdown.baseAmount,
                breakdown.platformFee,
                breakdown.paymentFee,
                resolvedTechnicianAmount,
                PAYMENT_TO_TECHNICIAN_STATUS.pending,
                PAYMENT_LEDGER_STATUS.pending,
                JSON.stringify(pricingSnapshot),
                existing[0].id
            ]
        );
        if (pendingUpdate.affectedRows !== 1) throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'Checkout has already been settled.');
        return existing[0].id;
    }

    const [insertResult] = await pool.execute(
        `INSERT INTO payments (
            user_id,
            service_request_id,
            payment_method,
            status,
            currency,
            amount,
            base_amount,
            platform_fee,
            payment_fee,
            technician_amount,
            is_settled,
            payment_to_technician_status,
            ledger_status,
            pricing_snapshot,
            razorpay_order_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            requestId,
            "razorpay",
            "PENDING",
            breakdown.currency,
            breakdown.totalAmount,
            breakdown.baseAmount,
            breakdown.platformFee,
            breakdown.paymentFee,
            resolvedTechnicianAmount,
            true,
            PAYMENT_TO_TECHNICIAN_STATUS.pending,
            PAYMENT_LEDGER_STATUS.pending,
            JSON.stringify(pricingSnapshot),
            orderId
        ]
    );

    return insertResult.insertId;
}

async function markClientSideVerification({
    pool,
    requestId,
    orderId,
    paymentId,
    signature,
    requestRow = null,
}) {
    const [existing] = await pool.query(
        `SELECT *
         FROM payments
         WHERE service_request_id = ? AND razorpay_order_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [requestId, orderId]
    );

    // A signature binds gateway IDs, not a price. Without our persisted checkout
    // agreement there is no safe amount to reconstruct from today's request.
    if (existing.length === 0) {
        throw paymentVerificationError("PAYMENT_ORDER_NOT_FOUND", "The original checkout agreement is missing. Contact support to reconcile this payment.");
    }

    if (existing.length > 0) {
        const storedPayment = existing[0];
        if (!paymentMatchesAcceptedPrice(requestRow, storedPayment)) {
            const error = new Error("This payment order has an older service price. Create a new order for the accepted price.");
            error.statusCode = 409;
            error.code = "STALE_PAYMENT_QUOTE";
            throw error;
        }
        const gatewayPayment = await razorpay.payments.fetch(paymentId);
        const mismatch = gatewayPaymentMismatch(storedPayment, gatewayPayment,
            { orderId, paymentId, requestRow, requireCaptured: false });
        if (mismatch) throw paymentVerificationError(mismatch.toUpperCase(), "The gateway payment does not match the saved checkout agreement.");
        const recordedBreakdown = buildServiceRequestPaymentDetails({ paymentRow: storedPayment, fallbackPaymentMode: "upi" });
        const recordedTechnicianAmount = Number(storedPayment.technician_amount);
        const recordedSnapshot = safeParseObject(storedPayment.pricing_snapshot) ?? {
            ...buildMarketplacePricingSnapshot({ breakdown: recordedBreakdown }), technician_amount: recordedTechnicianAmount,
        };
        await pool.execute(
            `UPDATE payments
             SET status = ?, razorpay_payment_id = ?, razorpay_signature = ?, currency = ?, amount = ?, base_amount = ?,
                 platform_fee = ?, payment_fee = ?, technician_amount = ?, is_settled = TRUE, pricing_snapshot = ?, verified_at = NOW()
             WHERE id = ? AND settlement_key IS NULL AND LOWER(TRIM(status)) NOT IN ('completed', 'paid')`,
            [
                "PROCESSING",
                paymentId,
                signature,
                recordedBreakdown.currency,
                recordedBreakdown.totalAmount,
                recordedBreakdown.baseAmount,
                recordedBreakdown.platformFee,
                recordedBreakdown.paymentFee,
                recordedTechnicianAmount,
                JSON.stringify(recordedSnapshot),
                existing[0].id
            ]
        );
        return { id: existing[0].id, gatewayPayment };
    }
}

function buildInvoiceData({ invoiceId, request, breakdown, paymentId, orderId }) {
    return {
        invoiceId,
        orderId,
        requestId: request.id,
        customerName: request.customer_name || "Customer",
        customerPhone: request.customer_phone || "N/A",
        customerAddress: request.address || "N/A",
        pickupAddress: request.address || "N/A",
        dropAddress: request.drop_address || null,
        routeDistanceKm: request.route_distance_km == null ? null : Number(request.route_distance_km),
        estimatedDuration: request.estimated_duration == null ? null : Number(request.estimated_duration),
        pricingBreakdown: safeParseObject(request.pricing_breakdown_json),
        serviceType: request.service_type || "Roadside Assistance",
        vehicleType: request.vehicle_type || "Vehicle",
        technicianName: request.technician_name || "Assigned Technician",
        amount: breakdown.baseAmount,
        platformFee: breakdown.platformFee,
        paymentFee: breakdown.paymentFee,
        gst: 0,
        totalAmount: breakdown.totalAmount,
        paymentMethod: "razorpay",
        transactionId: paymentId || orderId
    };
}

async function sendInvoiceEmailFromDatabase({ pool, invoiceId, toEmail, invoiceData }) {
    if (!toEmail) return false;

    const [invoiceRows] = await pool.query(
        "SELECT invoice_pdf FROM invoices WHERE id = ? LIMIT 1",
        [invoiceId]
    );
    if (invoiceRows.length === 0 || !invoiceRows[0].invoice_pdf) {
        throw new Error(`Invoice PDF not found in DB for invoice id ${invoiceId}`);
    }

    await sendInvoiceEmail(toEmail, invoiceData, invoiceRows[0].invoice_pdf);
    await pool.execute("UPDATE invoices SET status = ? WHERE id = ?", ["EMAILED", invoiceId]);
    return true;
}

async function finalizeCapturedServicePayment({ orderId, paymentId, gatewayPayment }) {
    const pool = await getPool();
    const conn = await pool.getConnection();

    let result = {
        processed: false,
        duplicate: false,
        requestId: null,
        userId: null,
        technicianId: null,
        invoiceId: null,
        invoiceStatus: null,
        customerEmail: null,
        invoiceData: null,
        walletTransactionId: null,
    };

    try {
        await conn.beginTransaction();

        const [paymentRows] = await conn.query(
            `SELECT *
             FROM payments
             WHERE razorpay_order_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [orderId]
        );

        if (paymentRows.length === 0) {
            await conn.rollback();
            return {
                ...result,
                processed: false,
                duplicate: false,
                reason: "payment_row_not_found"
            };
        }

        let paymentRow = paymentRows[0];
        const requestId = recordId(paymentRow.service_request_id);
        if (!isRecordId(requestId)) {
            await conn.rollback();
            return {
                ...result,
                processed: false,
                duplicate: false,
                reason: "service_request_missing_on_payment"
            };
        }

        const [requestLocks] = await conn.query('SELECT id FROM service_requests WHERE id = ? FOR UPDATE', [requestId]);
        if (!requestLocks.length) {
            await conn.rollback();
            return { ...result, processed: false, reason: 'service_request_not_found' };
        }
        const [requestRows] = await conn.query(
            `SELECT sr.id, sr.user_id, sr.technician_id, sr.service_type, sr.vehicle_type, sr.amount, sr.service_charge,
                    sr.technician_estimated_earning, sr.pricing_snapshot, sr.accepted_time,
                    sr.address, sr.drop_address, sr.drop_latitude, sr.drop_longitude,
                    sr.route_distance_km, sr.estimated_duration, sr.route_metadata_json,
                    sr.pricing_breakdown_json, sr.estimated_price, sr.final_price,
                    sr.status, sr.payment_status,
                    sr.applied_coupon_code, sr.applied_discount_percent, sr.applied_discount_amount,
                    u.email AS customer_email, u.full_name AS customer_name, u.phone AS customer_phone,
                    t.name AS technician_name, t.pricing AS technician_pricing, t.service_costs AS technician_service_costs
             FROM service_requests sr
             JOIN users u ON u.id = sr.user_id
             LEFT JOIN technicians t ON t.id = sr.technician_id
             WHERE sr.id = ?
             LIMIT 1
             FOR UPDATE`,
            [requestId]
        );

        if (requestRows.length === 0) {
            await conn.rollback();
            return {
                ...result,
                processed: false,
                duplicate: false,
                reason: "service_request_not_found"
            };
        }

        const request = requestRows[0];
        assertRequestNotCancelled(request);
        // All financial finalizers lock request -> payment. The first lookup
        // only discovers the owner request; re-read the checkout under its lock.
        const [lockedPayments] = await conn.query(`SELECT * FROM payments WHERE razorpay_order_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [orderId]);
        if (lockedPayments.length !== 1 || String(lockedPayments[0].id) !== String(paymentRow.id) ||
            String(lockedPayments[0].service_request_id) !== String(request.id)) {
            throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'Checkout changed while confirming payment.');
        }
        paymentRow = lockedPayments[0];
        if (!hasAcceptedRequestPricing(request)) {
            await conn.rollback();
            return { ...result, processed: false, duplicate: false, reason: "request_not_accepted" };
        }
        if (!paymentMatchesAcceptedPrice(request, paymentRow)) {
            await conn.rollback();
            return { ...result, processed: false, duplicate: false, reason: "stale_payment_quote" };
        }
        const mismatch = gatewayPaymentMismatch(paymentRow, gatewayPayment, { orderId, paymentId, requestRow: request });
        if (mismatch) {
            await conn.rollback();
            return { ...result, processed: false, duplicate: false, reason: mismatch };
        }
        const settled = await findCompletedServiceSettlement(conn, requestId);
        if (settled && (String(settled.id) !== String(paymentRow.id) ||
            String(settled.payment_method).toLowerCase() === 'cash' || String(settled.razorpay_payment_id || '') !== String(paymentId))) {
            throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'This request has already been settled using another payment.');
        }
        if (!settled && isRequestAlreadyPaid(request)) {
            throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'The original payment records require reconciliation.');
        }
        const pricingConfig = await getPlatformPricingConfig();
        // The gateway captured an existing order. Its stored checkout amounts
        // remain authoritative even if coupon/profile fields changed meanwhile.
        const breakdown = buildServiceRequestPaymentDetails({ paymentRow, currency: pricingConfig?.currency, fallbackPaymentMode: "upi" });
        const resolvedTechnicianAmount = Number(paymentRow.technician_amount);
        const isTowingRequest = isTowingServiceType(request?.service_type);
        const paidRequestStatus = isTowingRequest ? "payment_pending" : "completed";

        const requestWasPaid = (
            ["paid", "completed"].includes(String(request.status || "").toLowerCase()) ||
            ["paid", "completed"].includes(String(request.payment_status || "").toLowerCase())
        );

        if (settled) {
            const [existingInvoices] = await conn.query(`SELECT id, status FROM invoices
                WHERE order_id = ? OR razorpay_payment_id = ?
                ORDER BY created_at DESC, id DESC LIMIT 2 FOR UPDATE`, [orderId, paymentId]);
            if (existingInvoices.length !== 1) throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'The original invoice requires reconciliation.');
            await conn.commit();
            return { ...result, processed: true, duplicate: true, requestId, userId: request.user_id,
                technicianId: request.technician_id || null, status: request.status,
                invoiceId: existingInvoices[0].id, invoiceStatus: existingInvoices[0].status,
                customerEmail: request.customer_email || null, amount: resolvedTechnicianAmount,
                walletTransactionId: settled.wallet_transaction_id || null,
                invoiceData: buildInvoiceData({ invoiceId: existingInvoices[0].id, request, breakdown, paymentId, orderId }) };
        }
        await conn.execute('UPDATE payments SET settlement_key = ? WHERE id = ?', [serviceSettlementKey(requestId), paymentRow.id]);
        await conn.execute(
            `UPDATE payments
             SET status = ?, currency = ?, amount = ?, base_amount = ?, platform_fee = ?, payment_fee = ?,
                 technician_amount = ?, is_settled = TRUE, razorpay_payment_id = ?, captured_at = NOW()
             WHERE id = ?`,
            [
                "completed",
                breakdown.currency,
                breakdown.totalAmount,
                breakdown.baseAmount,
                breakdown.platformFee,
                breakdown.paymentFee,
                resolvedTechnicianAmount,
                paymentId,
                paymentRow.id
            ]
        );

        await conn.execute(
            `UPDATE service_requests
             SET payment_status = ?, payment_method = ?, status = ?, amount = ?, final_price = ?, updated_at = NOW()
             WHERE id = ?`,
            ["paid", "razorpay", paidRequestStatus, breakdown.baseAmount, breakdown.totalAmount, requestId]
        );
        if (request.technician_id && !isTowingRequest) {
            await releaseTechnicianAvailability(conn, request.technician_id, requestId);
        }

        let invoiceId = null;
        let invoiceStatus = null;
        const [invoiceRows] = await conn.query(
            `SELECT id, status
             FROM invoices
             WHERE order_id = ? OR razorpay_payment_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1
             FOR UPDATE`,
            [orderId, paymentId]
        );

        if (invoiceRows.length > 0) {
            invoiceId = invoiceRows[0].id;
            invoiceStatus = invoiceRows[0].status || "GENERATED";

            await conn.execute(
                `UPDATE invoices
                 SET user_id = ?, order_id = ?, service_request_id = ?, technician_id = ?, razorpay_payment_id = ?, amount = ?,
                     platform_fee = ?, payment_fee = ?, technician_amount = ?, gst = ?, total_amount = ?
                 WHERE id = ?`,
                [
                    request.user_id,
                    orderId,
                    requestId,
                    request.technician_id || null,
                    paymentId,
                    breakdown.totalAmount,
                    breakdown.platformFee,
                    breakdown.paymentFee,
                    resolvedTechnicianAmount,
                    0,
                    breakdown.totalAmount,
                    invoiceId
                ]
            );
        } else {
            const provisionalInvoiceData = buildInvoiceData({
                invoiceId: 0,
                request,
                breakdown,
                paymentId,
                orderId
            });
            const invoicePdfBuffer = await generateInvoicePDF(provisionalInvoiceData);

            const [insertInvoiceResult] = await conn.execute(
                `INSERT INTO invoices (
                    user_id,
                    order_id,
                    razorpay_payment_id,
                    amount,
                    invoice_pdf,
                    status,
                    service_request_id,
                    technician_id,
                    platform_fee,
                    payment_fee,
                    technician_amount,
                    gst,
                    total_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    request.user_id,
                    orderId,
                    paymentId,
                    breakdown.totalAmount,
                    invoicePdfBuffer,
                    "GENERATED",
                    requestId,
                    request.technician_id || null,
                    breakdown.platformFee,
                    breakdown.paymentFee,
                    resolvedTechnicianAmount,
                    0,
                    breakdown.totalAmount
                ]
            );
            invoiceId = insertInvoiceResult.insertId;
            invoiceStatus = "GENERATED";
        }

        let walletCreditOutcome = {
            credited: false,
            duplicate: false,
            walletTransactionId: paymentRow.wallet_transaction_id || null,
        };
        if (request.technician_id) {
            walletCreditOutcome = await creditTechnicianWalletForPayment(conn, {
                technicianId: request.technician_id,
                paymentId: paymentRow.id,
                serviceRequestId: requestId,
                amount: resolvedTechnicianAmount,
                currency: breakdown.currency,
                description: `Marketplace service payment credited for request #${requestId}.`,
                idempotencyKey: `payment-credit:${paymentRow.id}`,
                metadata: {
                    orderId,
                    paymentId,
                    requestId,
                },
            });
        }

        if (request.technician_id && !requestWasPaid) {
            await conn.execute(
                `UPDATE technicians
                 SET jobs_completed = jobs_completed + 1,
                     total_earnings = total_earnings + ?
                 WHERE id = ?`,
                [resolvedTechnicianAmount, request.technician_id]
            );
        }

        await conn.commit();

        result = {
            processed: true,
            duplicate: requestWasPaid && String(paymentRow.status || "").toLowerCase() === "completed",
            requestId,
            userId: request.user_id,
            technicianId: request.technician_id || null,
            amount: resolvedTechnicianAmount,
            status: paidRequestStatus,
            invoiceId,
            invoiceStatus,
            customerEmail: request.customer_email || null,
            invoiceData: buildInvoiceData({
                invoiceId,
                request,
                breakdown,
                paymentId,
                orderId
            }),
            walletTransactionId: walletCreditOutcome.walletTransactionId || null,
        };

        return result;
    } catch (error) {
        try {
            await conn.rollback();
        } catch { }
        if (error.code === 'ER_DUP_ENTRY') throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'This request already has a financial settlement.');
        throw error;
    } finally {
        conn.release();
    }
}

async function processFinalizedServicePaymentNotifications(finalized, { paymentMethod = "razorpay" } = {}) {
    if (!finalized || !finalized.processed) return;
    const pool = await getPool();
    const status = finalized.status || "completed";

    if (finalized.invoiceId && finalized.customerEmail && finalized.invoiceStatus !== "EMAILED") {
        try {
            await sendInvoiceEmailFromDatabase({
                pool,
                invoiceId: finalized.invoiceId,
                toEmail: finalized.customerEmail,
                invoiceData: finalized.invoiceData
            });
        } catch (emailErr) {
            console.error("[Payments] Invoice email send failed:", emailErr);
        }
    }

    void recordRequestEvent({ requestId: finalized.requestId, eventType: "paid", status, actorType: "user", actorId: null, metadata: { paymentMethod } });
    socketService.notifyAdmins("admin:payment_update", {
        requestId: finalized.requestId,
        paymentMethod,
        status,
        at: new Date().toISOString()
    });

    if (finalized.technicianId) {
        socketService.notifyTechnician(finalized.technicianId, "job:status_update", {
            requestId: finalized.requestId,
            status,
            amount: finalized.amount ?? null,
        });
        socketService.notifyTechnician(finalized.technicianId, "job:list_update", {
            requestId: finalized.requestId,
            action: "updated"
        });
    }

    if (finalized.userId) {
        socketService.notifyUser(finalized.userId, "payment_completed", {
            requestId: finalized.requestId,
            status
        });
        socketService.notifyUser(finalized.userId, "job:status_update", {
            requestId: finalized.requestId,
            status
        });
    }
}

export async function razorpayWebhookHandler(req, res) {
    if (!RAZORPAY_WEBHOOK_SECRET) {
        return res.status(503).json({ error: "Razorpay webhook verification secret is not configured." });
    }

    const signature = req.headers["x-razorpay-signature"];
    const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

    const expected = crypto
        .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    if (!signature || !timingSafeEqualHex(signature, expected)) {
        paymentDiag("webhook_signature_invalid", { signaturePresent: Boolean(signature) });
        return res.status(401).json({ error: "Invalid webhook signature." });
    }

    let event;
    try {
        event = JSON.parse(rawBody.toString("utf8"));
    } catch (parseErr) {
        return res.status(400).json({ error: "Invalid webhook payload." });
    }

    const eventName = String(event?.event || "");
    if (eventName !== "payment.captured") {
        paymentDiag("webhook_ignored_event", { event: eventName });
        return res.status(200).json({ received: true, ignored: true, event: eventName });
    }

    const paymentEntity = event?.payload?.payment?.entity || {};
    const orderId = String(paymentEntity.order_id || "").trim();
    const paymentId = String(paymentEntity.id || "").trim();

    if (!orderId || !paymentId) {
        paymentDiag("webhook_missing_fields", { orderIdPresent: Boolean(orderId), paymentIdPresent: Boolean(paymentId) });
        return res.status(400).json({ error: "Missing order_id or payment_id in webhook payload." });
    }

    try {
        const finalized = await finalizeCapturedServicePayment({ orderId, paymentId, gatewayPayment: paymentEntity });
        if (!finalized.processed && finalized.reason === "payment_row_not_found") {
            const accountResult = await (await accountPayments()).finalizeCapturedOrder({ orderId, paymentId });
            if (accountResult.processed) return res.status(200).json({ received: true, ...accountResult });
        }

        if (!finalized.processed && finalized.reason) {
            paymentDiag("webhook_not_processed", { orderId, paymentId, reason: finalized.reason });
            return res.status(200).json({ received: true, processed: false, reason: finalized.reason });
        }

        await processFinalizedServicePaymentNotifications(finalized, { paymentMethod: "razorpay" });

        paymentDiag("webhook_payment_captured_processed", {
            orderId,
            paymentId,
            requestId: finalized.requestId,
            invoiceId: finalized.invoiceId,
            duplicate: finalized.duplicate
        });

        return res.status(200).json({ received: true, processed: true, duplicate: finalized.duplicate });
    } catch (err) {
        if (err.statusCode === 409) {
            paymentDiag("webhook_settlement_conflict", { orderId, paymentId, reason: err.code });
            return res.status(200).json({ received: true, processed: false, reason: err.code });
        }
        console.error("[Razorpay Webhook] Failed to process payment.captured:", err);
        paymentDiag("webhook_processing_failed", { orderId, paymentId, error: err?.message || String(err) });
        return res.status(500).json({ error: "Failed to process webhook." });
    }
}

/**
 * POST /api/payments/create-registration-order
 * Create a Razorpay order for technician registration fee.
 */
router.post("/create-registration-order", verifyTechnician, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const pricingConfig = await getPlatformPricingConfig();
        const order = await (await accountPayments()).createOrder({
            purpose: "registration", ownerId: req.technicianId,
            amountPaise: Math.round(pricingConfig.registration_fee * 100),
            currency: pricingConfig.currency || "INR",
        });
        return res.json({ success: true, order_id: order.id, amount: order.amount,
            currency: order.currency, key_id: RAZORPAY_KEY_ID });
    } catch (err) {
        return accountPaymentError(res, err);
    }
});

/** Verify a registration payment against its server-owned checkout. */
router.post("/verify-registration-payment", verifyTechnician, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const body = req.body || {};
        const result = await (await accountPayments()).verifyPayment({
            purpose: "registration", ownerId: req.technicianId, planCode: null,
            orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id,
            signature: body.razorpay_signature,
        });
        return res.json({ success: true, message: "Payment verified successfully.", duplicate: result.duplicate });
    } catch (err) {
        return accountPaymentError(res, err);
    }
});

/**
 * POST /api/payments/create-service-order
 * Create a Razorpay order for a service booking fee.
 */
router.post("/create-service-order", verifyUser, async (req, res) => {
    return sendDeprecatedPaymentRoute(
        res,
        "/api/payments/create-order",
        "Pass a concrete service request id in the request body: { requestId, couponCode? }."
    );
});

/**
 * POST /api/payments/verify-service-payment
 * Verify the payment signature for a service booking.
 */
router.post("/verify-service-payment", verifyUser, async (req, res) => {
    return sendDeprecatedPaymentRoute(
        res,
        "/api/payments/confirm",
        "Pass { requestId, razorpay_order_id, razorpay_payment_id, razorpay_signature }."
    );
});

/**
 * GET /api/payments/config
 * Public pricing/payment configuration used by frontend and mobile clients.
 */
router.get("/config", async (_req, res) => {
    try {
        const pricingConfig = await getPlatformPricingConfig();
        res.json({
            currency: pricingConfig.currency,
            platform_fee_percent: pricingConfig.platform_fee_percent,
            payment_fee_percent: pricingConfig.payment_fee_percent,
            welcome_coupon_code: pricingConfig.welcome_coupon_code,
            welcome_coupon_discount_percent: pricingConfig.welcome_coupon_discount_percent,
            welcome_coupon_max_uses_per_user: pricingConfig.welcome_coupon_max_uses_per_user,
            welcome_coupon_active: pricingConfig.welcome_coupon_active,
            registration_fee: pricingConfig.registration_fee,
            booking_fee: pricingConfig.booking_fee,
            pay_now_discount_percent: pricingConfig.pay_now_discount_percent,
            default_service_amount: pricingConfig.default_service_amount,
            service_base_prices: pricingConfig.service_base_prices,
            towing_pricing_rules: pricingConfig.towing_pricing_rules,
            subscription_plans: listSubscriptionPlans(pricingConfig),
        });
    } catch (err) {
        console.error("[Payments] Config fetch error:", err);
        res.status(500).json({ error: "Failed to fetch payment configuration." });
    }
});

// --- New endpoints for service_request payments ---

// Compute payment quote for a specific service request with optional coupon
router.post('/quote', verifyUser, async (req, res) => {
    try {
        const { requestId, couponCode, preserveExistingApplied, paymentMode } = req.body || {};
        const userId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [rows] = await pool.query(
            `SELECT id, user_id, amount, service_charge, service_type, vehicle_type, technician_id, status, payment_status,
                    drop_address, drop_latitude, drop_longitude, route_distance_km, estimated_duration, pricing_breakdown_json,
                    pricing_snapshot, accepted_time, technician_estimated_earning,
                    applied_coupon_code, applied_discount_percent, applied_discount_amount
             FROM service_requests
             WHERE id = ? AND user_id = ?
             LIMIT 1`,
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });

        const requestRow = rows[0];
        if (!ensureRequestAcceptedForPayment(res, requestRow)) return;
        if (isRequestAlreadyPaid(requestRow)) {
            return res.status(409).json({ error: 'Request already paid' });
        }

        const { breakdown, coupon } = await buildServiceRequestPaymentQuote({
            pool,
            requestRow,
            pricingConfig,
            couponCode,
            preserveExistingApplied: preserveExistingApplied !== false,
            paymentMode,
        });

        res.json({
            success: true,
            request_id: recordId(requestId),
            breakdown: {
                currency: breakdown.currency,
                payment_mode: breakdown.paymentMode,
                base_amount: breakdown.baseAmount,
                platform_fee_percent: breakdown.platformFeePercent,
                original_platform_fee: breakdown.originalPlatformFee,
                discount_amount: breakdown.discountAmount,
                platform_fee: breakdown.platformFee,
                payment_fee_percent: breakdown.paymentFeePercent,
                payment_fee: breakdown.paymentFee,
                razorpay_fee: breakdown.razorpayFee,
                total_amount: breakdown.totalAmount,
                final_amount: breakdown.finalAmount,
            },
            paymentMode: breakdown.paymentMode,
            razorpayFee: breakdown.razorpayFee,
            finalAmount: breakdown.finalAmount,
            coupon: {
                active: coupon.active,
                configured_code: coupon.configuredCode,
                entered_code: coupon.providedCode,
                applied_coupon_code: coupon.appliedCode,
                is_applied: coupon.isApplied,
                reason: coupon.reason,
                discount_percent: coupon.discountPercent,
                max_uses_per_user: coupon.maxUsesPerUser,
                completed_services_count: coupon.completedServicesCount,
                reserved_coupon_count: coupon.reservedCouponCount,
                remaining_eligible_uses: coupon.remainingEligibleUses,
            },
        });
    } catch (err) {
        console.error('Payment quote error:', err);
        res.status(500).json({ error: 'Failed to compute payment quote' });
    }
});

// Create order for a specific service request
router.post('/create-order', verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        console.log('PAYMENT REQUEST: create-order (body):', req.body);
        const { requestId, couponCode } = req.body || {};
        const userId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [rows] = await pool.query(
            `SELECT sr.id, sr.user_id, sr.amount, sr.service_charge, sr.service_type, sr.vehicle_type, sr.technician_id,
                    sr.technician_estimated_earning, sr.pricing_snapshot, sr.accepted_time, sr.status, sr.payment_status,
                    sr.drop_address, sr.drop_latitude, sr.drop_longitude, sr.route_distance_km, sr.estimated_duration,
                    sr.pricing_breakdown_json, sr.applied_coupon_code, sr.applied_discount_percent, sr.applied_discount_amount,
                    t.pricing AS technician_pricing, t.service_costs AS technician_service_costs
             FROM service_requests sr
             LEFT JOIN technicians t ON t.id = sr.technician_id
             WHERE sr.id = ? AND sr.user_id = ?`,
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
        if (isRequestAlreadyPaid(rows[0])) {
            return res.status(409).json({ error: 'Request already paid' });
        }

        const requestRow = rows[0];
        if (!ensureRequestAcceptedForPayment(res, requestRow)) return;
        const technicianAmount = await resolveTechnicianPaymentAmount({
            requestRow,
            technicianProfile: {
                id: requestRow.technician_id,
                pricing: requestRow.technician_pricing,
                service_costs: requestRow.technician_service_costs,
            },
            connection: pool,
        });
        const { breakdown, coupon } = await buildServiceRequestPaymentQuote({
            pool,
            requestRow,
            pricingConfig,
            couponCode,
            preserveExistingApplied: false,
            paymentMode: "upi",
        });

        if (coupon.providedCode && !coupon.isApplied) {
            return res.status(400).json({
                error: coupon.reason || "Coupon could not be applied.",
                coupon: {
                    active: coupon.active,
                    configured_code: coupon.configuredCode,
                    entered_code: coupon.providedCode,
                    reason: coupon.reason,
                    discount_percent: coupon.discountPercent,
                    remaining_eligible_uses: coupon.remainingEligibleUses,
                    max_uses_per_user: coupon.maxUsesPerUser,
                }
            });
        }

        const reusablePayment = await findReusablePendingOrder(pool, {
            requestId,
            breakdown,
        });

        if (reusablePayment?.razorpay_order_id) {
            await upsertPendingRazorpayPayment({
                pool,
                userId,
                requestId,
                orderId: reusablePayment.razorpay_order_id,
                breakdown,
                coupon,
                technicianAmount,
            });

            const [requestUpdate] = await pool.execute(
                `UPDATE service_requests
                 SET payment_method = ?,
                     payment_status = ?,
                     applied_coupon_code = ?,
                     applied_discount_percent = ?,
                     applied_discount_amount = ?
                 WHERE id = ? AND LOWER(COALESCE(payment_status, '')) NOT IN ('paid', 'completed')
                 AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled', 'rejected', 'expired')
                 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.service_request_id = service_requests.id
                    AND (p.settlement_key IS NOT NULL OR LOWER(TRIM(p.status)) IN ('completed', 'paid')))`,
                [
                    "razorpay",
                    "pending",
                    coupon.appliedCode || null,
                    coupon.isApplied ? coupon.discountPercent : 0,
                    breakdown.discountAmount,
                    requestId
                ]
            );

            if (requestUpdate.affectedRows !== 1) throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'Request changed or has already been settled.');
            return res.json({
                id: reusablePayment.razorpay_order_id,
                amount: Math.round(breakdown.totalAmount * 100),
                currency: breakdown.currency,
                receipt: compactPaymentReceipt(`receipt_${requestId}_reused`),
                status: String(reusablePayment.status || "pending").toLowerCase(),
                base_amount: breakdown.baseAmount,
                payment_mode: breakdown.paymentMode,
                original_platform_fee: breakdown.originalPlatformFee,
                discount_amount: breakdown.discountAmount,
                platform_fee: breakdown.platformFee,
                payment_fee_percent: breakdown.paymentFeePercent,
                payment_fee: breakdown.paymentFee,
                razorpay_fee: breakdown.razorpayFee,
                platform_fee_percent: breakdown.platformFeePercent,
                total_amount: breakdown.totalAmount,
                final_amount: breakdown.finalAmount,
                paymentMode: breakdown.paymentMode,
                razorpayFee: breakdown.razorpayFee,
                finalAmount: breakdown.finalAmount,
                coupon: {
                    applied_coupon_code: coupon.appliedCode,
                    is_applied: coupon.isApplied,
                    discount_percent: coupon.discountPercent,
                    remaining_eligible_uses: coupon.remainingEligibleUses,
                    max_uses_per_user: coupon.maxUsesPerUser,
                },
                key_id: RAZORPAY_KEY_ID,
                reused: true,
            });
        }

        const options = {
            amount: Math.round(breakdown.totalAmount * 100),
            currency: breakdown.currency,
            receipt: compactPaymentReceipt(`receipt_${requestId}_${Date.now()}`),
            payment_capture: 1,
            notes: {
                requestId: String(requestId),
                userId: String(userId),
                type: "service_request"
            }
        };

        const order = await razorpay.orders.create(options);
        console.log('PAYMENT ORDER CREATED:', order.id, 'for request', requestId, 'Total:', breakdown.totalAmount);
        paymentDiag("create_order_success", {
            requestId,
            userId,
            orderId: order.id,
            baseAmount: breakdown.baseAmount,
            originalPlatformFee: breakdown.originalPlatformFee,
            discountAmount: breakdown.discountAmount,
            platformFee: breakdown.platformFee,
            totalAmount: breakdown.totalAmount,
            platformFeePercent: breakdown.platformFeePercent,
            couponCode: coupon.appliedCode || null
        });

        await upsertPendingRazorpayPayment({
            pool,
            userId,
            requestId,
            orderId: order.id,
            breakdown,
            coupon,
            technicianAmount,
        });

        const [requestUpdate] = await pool.execute(
            `UPDATE service_requests
             SET payment_method = ?,
                 payment_status = ?,
                 applied_coupon_code = ?,
                 applied_discount_percent = ?,
                 applied_discount_amount = ?
             WHERE id = ? AND LOWER(COALESCE(payment_status, '')) NOT IN ('paid', 'completed')
                 AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled', 'rejected', 'expired')
                 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.service_request_id = service_requests.id
                    AND (p.settlement_key IS NOT NULL OR LOWER(TRIM(p.status)) IN ('completed', 'paid')))`,
            [
                "razorpay",
                "pending",
                coupon.appliedCode || null,
                coupon.isApplied ? coupon.discountPercent : 0,
                breakdown.discountAmount,
                requestId
            ]
        );

        if (requestUpdate.affectedRows !== 1) throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'Request changed or has already been settled.');
        // Return breakdown so frontend can display consistent info
        res.json({
            ...order,
            base_amount: breakdown.baseAmount,
            payment_mode: breakdown.paymentMode,
            original_platform_fee: breakdown.originalPlatformFee,
            discount_amount: breakdown.discountAmount,
            platform_fee: breakdown.platformFee,
            payment_fee_percent: breakdown.paymentFeePercent,
            payment_fee: breakdown.paymentFee,
            razorpay_fee: breakdown.razorpayFee,
            platform_fee_percent: breakdown.platformFeePercent,
            total_amount: breakdown.totalAmount,
            final_amount: breakdown.finalAmount,
            paymentMode: breakdown.paymentMode,
            razorpayFee: breakdown.razorpayFee,
            finalAmount: breakdown.finalAmount,
            coupon: {
                applied_coupon_code: coupon.appliedCode,
                is_applied: coupon.isApplied,
                discount_percent: coupon.discountPercent,
                remaining_eligible_uses: coupon.remainingEligibleUses,
                max_uses_per_user: coupon.maxUsesPerUser,
            },
            key_id: RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error('Create order error:', err);
        paymentDiag("create_order_failed", { requestId: req?.body?.requestId, userId: req?.user?.userId, error: err?.message || String(err) });
        res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to create payment order', ...(err.statusCode ? { code: err.code } : {}) });
    }
});

// Confirm/verify online payment for a request
router.post('/confirm', verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        console.log('PAYMENT REQUEST: confirm (body):', req.body);
        const { requestId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!requestId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const expected = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (expected !== razorpay_signature) {
            console.log('PAYMENT VERIFY FAILED: signature mismatch', { expected, supplied: razorpay_signature });
            paymentDiag("confirm_signature_mismatch", { requestId, userId: req.user.userId, razorpay_order_id, razorpay_payment_id });
            return res.status(400).json({ error: 'Invalid signature' });
        }

        const pool = await getPool();
        const authUserId = req.user.userId;
        const pricingConfig = await getPlatformPricingConfig();
        const [reqRows] = await pool.query(
            `SELECT sr.id, sr.amount, sr.service_charge, sr.service_type, sr.vehicle_type, sr.technician_id,
                    sr.technician_estimated_earning, sr.pricing_snapshot, sr.accepted_time, sr.user_id, sr.status, sr.payment_status,
                    sr.drop_address, sr.route_distance_km, sr.applied_coupon_code, sr.applied_discount_percent,
                    sr.applied_discount_amount, t.pricing AS technician_pricing, t.service_costs AS technician_service_costs
             FROM service_requests sr
             LEFT JOIN technicians t ON t.id = sr.technician_id
             WHERE sr.id = ? AND sr.user_id = ?
             LIMIT 1`,
            [requestId, authUserId]
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });

        const requestRow = reqRows[0];
        if (!ensureRequestAcceptedForPayment(res, requestRow)) return;
        if (isRequestAlreadyPaid(requestRow)) {
            return res.json({ success: true, alreadyPaid: true });
        }

        const verification = await markClientSideVerification({
            pool,
            requestId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            signature: razorpay_signature,
            requestRow,
        });

        await pool.execute(
            `UPDATE service_requests SET payment_method = ? WHERE id = ?
             AND LOWER(COALESCE(payment_status, '')) NOT IN ('paid', 'completed')
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.service_request_id = service_requests.id
                AND (p.settlement_key IS NOT NULL OR LOWER(TRIM(p.status)) IN ('completed', 'paid')))`,
            ["razorpay", requestId]
        );

        const finalized = String(verification.gatewayPayment.status || "").toLowerCase() === "captured"
            ? await finalizeCapturedServicePayment({ orderId: razorpay_order_id, paymentId: razorpay_payment_id, gatewayPayment: verification.gatewayPayment })
            : { processed: false, reason: "awaiting_capture" };

        if (finalized.processed) {
            await processFinalizedServicePaymentNotifications(finalized, { paymentMethod: "razorpay" });

            const [updatedRows] = await pool.query(
                "SELECT * FROM service_requests WHERE id = ? LIMIT 1",
                [requestId]
            );

            paymentDiag("confirm_payment_finalized", {
                requestId,
                userId: authUserId,
                orderId: razorpay_order_id,
                paymentId: razorpay_payment_id,
                duplicate: finalized.duplicate
            });

            return res.json({
                success: true,
                requestId,
                order_id: razorpay_order_id,
                payment_id: razorpay_payment_id,
                immediateFinalization: true,
                duplicate: finalized.duplicate,
                request: serializeServiceRequestRow(updatedRows[0]),
                message: "Payment verified and finalized successfully."
            });
        }

        paymentDiag("confirm_payment_acknowledged", {
            requestId,
            userId: authUserId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            finalizeReason: finalized.reason || "awaiting_webhook"
        });

        res.json({
            success: true,
            requestId,
            order_id: razorpay_order_id,
            payment_id: razorpay_payment_id,
            immediateFinalization: false,
            message: "Payment signature verified. Awaiting Razorpay webhook capture confirmation."
        });

    } catch (err) {
        console.error('Confirm payment error:', err);
        paymentDiag("confirm_payment_failed", { requestId: req?.body?.requestId, userId: req?.user?.userId, error: err?.message || String(err) });
        res.status(err.statusCode || 500).json({ error: err.statusCode === 409 ? err.message : 'Failed to confirm payment', ...(err.code ? { code: err.code } : {}) });
    }
});

// Cash payment for a request
async function handleCashPayment(req, res, confirmReceipt = false) {
    try {
        console.log('PAYMENT REQUEST: cash (body):', req.body);
        const { couponCode } = req.body || {};
        const requestId = recordId(req.body?.requestId);
        const actorId = confirmReceipt ? req.technicianId : req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [reqRows] = await conn.query(
                `SELECT sr.id, sr.user_id, sr.amount, sr.service_charge, sr.service_type, sr.vehicle_type,
                        sr.technician_id, sr.technician_estimated_earning, sr.pricing_snapshot, sr.accepted_time, sr.status, sr.payment_status, sr.payment_method, sr.cash_payment_intent,
                        sr.address, sr.drop_address, sr.drop_latitude, sr.drop_longitude, sr.route_distance_km,
                        sr.estimated_duration, sr.pricing_breakdown_json, sr.applied_coupon_code,
                        sr.applied_discount_percent, sr.applied_discount_amount
                 FROM service_requests sr
                 WHERE sr.id = ? AND sr.${confirmReceipt ? 'technician_id' : 'user_id'} = ? FOR UPDATE`,
                [requestId, actorId]
            );
            if (reqRows.length === 0) { await conn.rollback(); return res.status(404).json({ error: 'Request not found' }); }
            const requestRow = reqRows[0];
            assertRequestNotCancelled(requestRow);
            const settled = await findCompletedServiceSettlement(conn, requestId);
            if (settled && (String(settled.payment_method).toLowerCase() !== 'cash' || String(settled.user_id) !== String(requestRow.user_id))) {
                throw settlementConflict('PAYMENT_SETTLEMENT_CONFLICT', 'This request has already been settled using another payment.');
            }
            const [cashInvoices] = await conn.query(`SELECT * FROM invoices
                WHERE service_request_id = ? AND razorpay_payment_id IS NULL AND LEFT(order_id, 5) = 'cash_'
                ORDER BY created_at DESC, id DESC LIMIT 2 FOR UPDATE`, [requestId]);
            if (settled) {
                if (confirmReceipt) {
                    const proof = safeParseObject(settled.pricing_snapshot)?.cashReceipt;
                    if (!proof) throw settlementConflict('CASH_RECEIPT_RECONCILIATION_REQUIRED', 'This historical cash receipt requires reconciliation.');
                    assertCashReceipt(proof, req.body || {}, actorId);
                }
                if (cashInvoices.length !== 1) throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'The original cash invoice requires reconciliation.');
                await conn.commit();
                return res.json({ success: true, alreadyPaid: true, payment_id: settled.id, invoice_id: cashInvoices[0].id,
                    request: serializeServiceRequestRow(requestRow) });
            }
            if (isRequestAlreadyPaid(requestRow) || cashInvoices.length) {
                throw settlementConflict('PAYMENT_RECONCILIATION_REQUIRED', 'The original payment records require reconciliation.');
            }
            if (!ensureRequestAcceptedForPayment(res, requestRow)) { await conn.rollback(); return; }
            assertCashPayable(requestRow);
            const respondPending = async (intent, reused = false) => {
                await conn.commit();
                socketService.notifyTechnician(requestRow.technician_id, 'job:status_update', { requestId, status: requestRow.status, cashReceiptPending: true });
                socketService.notifyUser(requestRow.user_id, 'job:status_update', { requestId, status: requestRow.status, cashReceiptPending: true });
                return res.json({ success: true, pendingReceipt: true, reused, cash_intent: publicCashIntent(intent),
                    request: serializeServiceRequestRow({ ...requestRow, payment_method: 'cash', cash_payment_intent: intent }) });
            };
            if (!confirmReceipt && requestRow.payment_method === 'cash') {
                let previous;
                try { previous = readCashIntent(requestRow); } catch { /* customer may replace a stale, unpaid intent */ }
                if (previous && String(previous.coupon.appliedCode || '') === String(couponCode || '').trim().toUpperCase()) return await respondPending(previous, true);
            }
            const receiptIntent = confirmReceipt ? readCashIntent(requestRow) : null;
            if (confirmReceipt) {
                if (String(requestRow.payment_method).toLowerCase() !== 'cash') throw settlementConflict('CASH_INTENT_STALE', 'Cash is no longer the selected payment method.');
                assertCashReceipt(receiptIntent, req.body || {}, actorId);
            }
            const technicianId = requestRow.technician_id;
            const userId = requestRow.user_id;
            const { breakdown, coupon } = receiptIntent || await buildServiceRequestPaymentQuote({
                pool: conn,
                requestRow,
                pricingConfig,
                couponCode,
                preserveExistingApplied: false,
                paymentMode: "cash",
            });

            if (coupon.providedCode && !coupon.isApplied) {
                await conn.rollback();
                return res.status(400).json({
                    error: coupon.reason || "Coupon could not be applied.",
                    coupon: {
                        active: coupon.active,
                        configured_code: coupon.configuredCode,
                        entered_code: coupon.providedCode,
                        reason: coupon.reason,
                        discount_percent: coupon.discountPercent,
                        remaining_eligible_uses: coupon.remainingEligibleUses,
                        max_uses_per_user: coupon.maxUsesPerUser,
                    }
                });
            }

            const techAmount = receiptIntent?.technicianAmount ?? await resolveTechnicianPaymentAmount({
                requestRow,
                technicianProfile: {
                    id: requestRow.technician_id,
                    pricing: requestRow.technician_pricing,
                    service_costs: requestRow.technician_service_costs,
                },
                connection: conn,
            }) ?? breakdown.baseAmount;
            if (!confirmReceipt) {
                const intent = createCashIntent(requestRow, { breakdown, coupon, technicianAmount: techAmount });
                await conn.execute(`UPDATE service_requests SET cash_payment_intent = ?, payment_method = ?,
                    applied_coupon_code = ?, applied_discount_percent = ?, applied_discount_amount = ?, updated_at = NOW() WHERE id = ?`,
                    [JSON.stringify(intent), 'cash', coupon.appliedCode || null, coupon.isApplied ? coupon.discountPercent : 0, breakdown.discountAmount, requestId]);
                return await respondPending(intent);
            }
            const cashReceipt = { intentId: receiptIntent.intentId, technicianId: actorId, amountPaise: receiptIntent.amountPaise,
                currency: receiptIntent.currency, receivedAt: new Date().toISOString() };
            const isTowingRequest = isTowingServiceType(requestRow?.service_type);
            const paidRequestStatus = isTowingRequest ? requestRow.status : "completed";

            await conn.execute(
                `UPDATE service_requests
                 SET payment_status = ?,
                     payment_method = ?,
                     status = ?,
                     amount = ?,
                     final_price = ?,
                     applied_coupon_code = ?,
                     applied_discount_percent = ?,
                     applied_discount_amount = ?,
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                    'paid',
                    'cash',
                    paidRequestStatus,
                    breakdown.baseAmount,
                    breakdown.totalAmount,
                    coupon.appliedCode || null,
                    coupon.isApplied ? coupon.discountPercent : 0,
                    breakdown.discountAmount,
                    requestId
                ]
            );
            if (technicianId && !isTowingRequest) {
                await releaseTechnicianAvailability(conn, technicianId, requestId);
            }
            console.log('REQUEST STATUS UPDATED:', { requestId, status: paidRequestStatus, amount: breakdown.baseAmount });

            const [cashPaymentResult] = await conn.execute(
                `INSERT INTO payments (
                    user_id, service_request_id, payment_method, status, currency, amount, base_amount,
                    platform_fee, payment_fee, technician_amount, is_settled,
                    payment_to_technician_status, ledger_status, pricing_snapshot, settlement_key
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    requestId,
                    'cash',
                    'completed',
                    breakdown.currency,
                    breakdown.totalAmount,
                    breakdown.baseAmount,
                    breakdown.platformFee,
                    breakdown.paymentFee,
                    techAmount,
                    false,
                    PAYMENT_TO_TECHNICIAN_STATUS.notApplicable,
                    PAYMENT_LEDGER_STATUS.skipped,
                    JSON.stringify({ ...buildMarketplacePricingSnapshot({ breakdown, coupon }), technician_amount: techAmount, cashReceipt }),
                    serviceSettlementKey(requestId),
                ]
            );

            const paymentId = cashPaymentResult.insertId;
            const [invResult] = await conn.execute(
                `INSERT INTO invoices (
                    user_id, order_id, razorpay_payment_id, amount, invoice_pdf, status,
                    service_request_id, technician_id, platform_fee, payment_fee, technician_amount, gst, total_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    `cash_${requestId}`,
                    null,
                    breakdown.totalAmount,
                    null,
                    "GENERATED",
                    requestId,
                    technicianId || null,
                    breakdown.platformFee,
                    breakdown.paymentFee,
                    techAmount,
                    0,
                    breakdown.totalAmount
                ]
            );

            const invoiceId = invResult.insertId;
            // generate PDF invoice and store bytes in DB (best effort)
            try {
                const invoiceData = {
                    invoiceId,
                    requestId,
                    customerName: "Customer",
                    customerPhone: "N/A",
                    customerAddress: reqRows[0].address || "N/A",
                    pickupAddress: reqRows[0].address || "N/A",
                    dropAddress: reqRows[0].drop_address || null,
                    routeDistanceKm: reqRows[0].route_distance_km == null ? null : Number(reqRows[0].route_distance_km),
                    estimatedDuration: reqRows[0].estimated_duration == null ? null : Number(reqRows[0].estimated_duration),
                    pricingBreakdown: safeParseObject(reqRows[0].pricing_breakdown_json),
                    serviceType: reqRows[0].service_type || "Roadside Assistance",
                    vehicleType: reqRows[0].vehicle_type || "Vehicle",
                    technicianName: "Assigned Technician",
                    amount: breakdown.baseAmount,
                    platformFee: breakdown.platformFee,
                    paymentFee: breakdown.paymentFee,
                    totalAmount: breakdown.totalAmount,
                    paymentMethod: "cash",
                    transactionId: `CASH_${requestId}`
                };
                const pdfBuffer = await generateInvoicePDF(invoiceData);
                await conn.execute('UPDATE invoices SET invoice_pdf = ? WHERE id = ?', [pdfBuffer, invoiceId]);
            } catch (pdfErr) {
                console.error('Invoice generation failed for cash:', pdfErr);
            }

            if (technicianId) {
                await conn.execute('UPDATE technicians SET jobs_completed = jobs_completed + 1 WHERE id = ?', [technicianId]);
            }

            await conn.commit();
            paymentDiag("cash_payment_success", {
                requestId,
                userId,
                technicianId,
                paymentMethod: "cash",
                originalPlatformFee: breakdown.originalPlatformFee,
                discountAmount: breakdown.discountAmount,
                totalAmount: breakdown.totalAmount,
                platformFee: breakdown.platformFee,
                technicianAmount: techAmount,
                couponCode: coupon.appliedCode || null
            });
            void recordRequestEvent({ requestId, eventType: "paid", status: paidRequestStatus, actorType: "technician", actorId, metadata: { paymentMethod: "cash", totalAmount: breakdown.totalAmount, intentId: receiptIntent.intentId } });
            socketService.notifyAdmins("admin:payment_update", {
                requestId,
                paymentMethod: "cash",
                status: paidRequestStatus,
                totalAmount: breakdown.totalAmount,
                at: new Date().toISOString()
            });

            if (technicianId) {
                const [pendingDueRows] = await pool.query(
                    `SELECT IFNULL(SUM(COALESCE(p.platform_fee, 0)), 0) AS total
                     FROM payments p
                     JOIN service_requests sr ON sr.id = p.service_request_id
                     WHERE sr.technician_id = ?
                       AND LOWER(COALESCE(p.payment_method, '')) = 'cash'
                       AND LOWER(COALESCE(p.status, '')) = 'completed'
                       AND COALESCE(p.is_settled, FALSE) = FALSE`,
                    [technicianId]
                );
                const pendingDues = Number(pendingDueRows?.[0]?.total || 0);
                socketService.notifyTechnician(technicianId, 'job:status_update', {
                    requestId,
                    status: paidRequestStatus,
                    amount: techAmount,
                });
                socketService.notifyTechnician(technicianId, 'job:list_update', { requestId, action: 'updated' });
                socketService.notifyTechnician(technicianId, 'technician:financials_update', {
                    pending_dues: Number.isFinite(pendingDues) ? pendingDues : 0,
                    at: new Date().toISOString(),
                });
            }
            socketService.notifyUser(userId, 'payment_completed', { requestId, status: paidRequestStatus });
            socketService.notifyUser(userId, 'job:status_update', { requestId, status: paidRequestStatus });

            const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
            res.json({ success: true, payment_id: paymentId, invoice_id: invoiceId, request: serializeServiceRequestRow(updatedRows[0]) });

        } catch (txErr) {
            await conn.rollback();
            console.error('Cash payment transaction error:', txErr);
            paymentDiag("cash_payment_tx_failed", { requestId, actorId, error: txErr?.message || String(txErr) });
            return res.status(txErr.statusCode || (txErr.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ error: txErr.statusCode ? txErr.message : 'Failed to process cash payment', ...(txErr.code ? { code: txErr.code } : {}) });
        } finally {
            conn.release();
        }

    } catch (err) {
        console.error('Cash payment error:', err);
        paymentDiag("cash_payment_failed", { requestId: req?.body?.requestId, userId: req?.user?.userId || req?.technicianId, error: err?.message || String(err) });
        res.status(500).json({ error: 'Failed to process cash payment' });
    }
}
router.post('/cash', verifyUser, (req, res) => handleCashPayment(req, res));
router.post('/cash/confirm', verifyTechnician, (req, res) => handleCashPayment(req, res, true));

// Admin diagnostics for payment pipeline by request
router.get('/diagnostics/overview', verifyAdmin, async (req, res) => {
    try {
        const limitRaw = Number(req.query.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const pool = await getPool();

        const [rows] = await pool.query(
            `SELECT
                p.id AS payment_id,
                p.service_request_id,
                p.payment_method,
                CASE
                  WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
                  ELSE p.status
                END AS payment_row_status,
                p.amount AS payment_total_amount,
                p.platform_fee,
                p.technician_amount,
                p.is_settled,
                p.created_at AS payment_created_at,
                p.razorpay_order_id,
                p.razorpay_payment_id,
                sr.status AS request_status,
                sr.payment_status AS request_payment_status,
                sr.payment_method AS request_payment_method,
                sr.amount AS request_base_amount,
                sr.service_type,
                sr.updated_at AS request_updated_at,
                u.full_name AS customer_name,
                u.email AS customer_email,
                t.name AS technician_name
            FROM payments p
            JOIN service_requests sr ON sr.id = p.service_request_id
            LEFT JOIN users u ON u.id = sr.user_id
            LEFT JOIN technicians t ON t.id = sr.technician_id
            ORDER BY p.created_at DESC
            LIMIT ?`,
            [limit]
        );

        const [statsRows] = await pool.query(
            `SELECT
                COUNT(*) AS total_payments,
                SUM(
                  CASE
                    WHEN LOWER(COALESCE(CASE WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled' ELSE p.status END, '')) = 'completed'
                      THEN 1
                    ELSE 0
                  END
                ) AS completed_payments,
                SUM(CASE WHEN p.payment_method = 'cash' THEN 1 ELSE 0 END) AS cash_payments,
                SUM(CASE WHEN p.payment_method = 'razorpay' THEN 1 ELSE 0 END) AS online_payments,
                IFNULL(
                  SUM(
                    CASE
                      WHEN LOWER(COALESCE(CASE WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled' ELSE p.status END, '')) = 'completed'
                        THEN p.amount
                      ELSE 0
                    END
                  ),
                  0
                ) AS gross_amount
            FROM payments p
            LEFT JOIN service_requests sr ON sr.id = p.service_request_id`
        );

        const records = rows.map((row) => {
            const checks = {
                request_paid_consistent: !(
                    ["paid", "completed"].includes(String(row.request_status || "").toLowerCase()) &&
                    !["paid", "completed"].includes(String(row.request_payment_status || "").toLowerCase())
                ),
                payment_method_consistent: !row.request_payment_method || String(row.request_payment_method) === String(row.payment_method)
            };
            return {
                ...row,
                isTowing: isTowingServiceType(row.service_type),
                checks,
            };
        });

        res.json({
            generatedAt: new Date().toISOString(),
            stats: statsRows[0] || {},
            records
        });
    } catch (err) {
        console.error("Payment diagnostics overview error:", err);
        res.status(500).json({ error: "Failed to fetch payment diagnostics overview." });
    }
});

// Admin diagnostics for payment pipeline by request
router.get('/diagnostics/request/:requestId', verifyAdmin, async (req, res) => {
    try {
        const requestId = req.params.requestId;
        const pool = await getPool();

        const [requestRows] = await pool.query(
            `SELECT id, user_id, technician_id, service_type, status, payment_status, payment_method, amount, created_at, updated_at
             FROM service_requests WHERE id = ? LIMIT 1`,
            [requestId]
        );
        if (requestRows.length === 0) {
            return res.status(404).json({ error: "Request not found" });
        }

        const [paymentRows] = await pool.query(
            `SELECT id, payment_method, status, amount, platform_fee, technician_amount, is_settled, created_at,
                    razorpay_order_id, razorpay_payment_id
             FROM payments
             WHERE service_request_id = ?
             ORDER BY created_at DESC`,
            [requestId]
        );

        const [invoiceRows] = await pool.query(
            `SELECT id, total_amount, status, (invoice_pdf IS NOT NULL) AS has_invoice_pdf, created_at
             FROM invoices
             WHERE service_request_id = ?
             ORDER BY created_at DESC`,
            [requestId]
        );

        const [dueRows] = await pool.query(
            `SELECT id, technician_id, amount, status, created_at
             FROM technician_dues
             WHERE service_request_id = ?
             ORDER BY created_at DESC`,
            [requestId]
        );

        const request = serializeServiceRequestRow(requestRows[0]);
        const latestPayment = paymentRows[0] || null;
        const latestInvoice = invoiceRows[0] || null;

        const checks = {
            request_exists: true,
            paid_status_consistent: !(
                ['paid', 'completed'].includes(String(request.status || '').toLowerCase()) &&
                !['paid', 'completed'].includes(String(request.payment_status || '').toLowerCase())
            ),
            payment_row_exists_if_paid: !(['paid', 'completed'].includes(String(request.status || '').toLowerCase()) && paymentRows.length === 0),
            invoice_exists_if_paid: !(['paid', 'completed'].includes(String(request.status || '').toLowerCase()) && invoiceRows.length === 0),
            invoice_pdf_present: !latestInvoice || !!latestInvoice.has_invoice_pdf,
            cash_due_record_present: !latestPayment || latestPayment.payment_method !== 'cash' || dueRows.length > 0,
        };

        res.json({
            requestId: String(requestId),
            generatedAt: new Date().toISOString(),
            request,
            payments: paymentRows,
            invoices: invoiceRows,
            technicianDues: dueRows,
            checks
        });
    } catch (err) {
        console.error("Payment diagnostics error:", err);
        res.status(500).json({ error: "Failed to fetch payment diagnostics." });
    }
});

// --- Subscription endpoints ---

/**
 * POST /api/payments/create-subscription-order
 */
router.post("/create-subscription-order", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const { planId } = req.body || {};
        if (typeof planId !== "string" || !planId) return res.status(400).json({ error: "Missing planId" });
        const pricingConfig = await getPlatformPricingConfig();
        const plan = getSubscriptionPlanById(planId, pricingConfig);
        if (!plan || plan.active === false) return res.status(400).json({ error: "Invalid or inactive planId" });
        const order = await (await accountPayments()).createOrder({
            purpose: "subscription", ownerId: req.user.userId, planCode: plan.id,
            amountPaise: Math.round(Number(plan.amount || 0) * 100), currency: pricingConfig.currency || "INR",
        });
        return res.json({ success: true, order_id: order.id, amount: order.amount,
            currency: order.currency, key_id: RAZORPAY_KEY_ID });
    } catch (err) {
        return accountPaymentError(res, err);
    }
});

/** Verify the saved plan and price, even if the current catalog has changed. */
router.post("/verify-subscription-payment", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const body = req.body || {};
        if (typeof body.planId !== "string" || !body.planId) return res.status(400).json({ error: "Missing planId" });
        const result = await (await accountPayments()).verifyPayment({
            purpose: "subscription", ownerId: req.user.userId, planCode: body.planId.trim().toLowerCase(),
            orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id,
            signature: body.razorpay_signature,
        });
        return res.json({ success: true, message: "Subscription verified successfully.", duplicate: result.duplicate });
    } catch (err) {
        return accountPaymentError(res, err);
    }
});

export default router;

