
import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getPool } from "../db.js";
import { verifyAdmin, verifyTechnician, verifyUser } from "../middleware/auth.js";
import { socketService } from "../services/socket.js";
import { generateInvoicePDF } from "../services/invoiceService.js";
import { sendInvoiceEmail } from "../services/mailer.js";
import {
    computePaymentAmounts,
    getPlatformPricingConfig,
    getSubscriptionPlanById,
    listSubscriptionPlans
} from "../services/platformPricing.js";
import { estimateRequestAmount, estimateRequestAmountAsync } from "../services/pricingEstimator.js";

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

const ensureRazorpayConfigured = (res) => {
    if (hasRazorpayConfig) return true;
    res.status(503).json({
        error: "Payment gateway is not configured. Please contact support."
    });
    return false;
};

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

const normalizeCouponCode = (value) => String(value || "").trim().toUpperCase();

const toPercentOrZero = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(1, Math.max(0, parsed));
};

const isRequestAlreadyPaid = (requestRow) => {
    const status = String(requestRow?.status || "").toLowerCase();
    const paymentStatus = String(requestRow?.payment_status || "").toLowerCase();
    return status === "paid" || paymentStatus === "completed";
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
    const requestId = Number(requestRow?.id);

    const [completedRows] = await pool.query(
        `SELECT COUNT(*) AS count
         FROM service_requests
         WHERE user_id = ?
           AND id <> ?
           AND (LOWER(COALESCE(payment_status, '')) = 'completed' OR LOWER(COALESCE(status, '')) = 'paid')`,
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
               AND LOWER(COALESCE(payment_status, '')) <> 'completed'
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
}) {
    const userId = Number(requestRow?.user_id);
    const baseAmount = await resolveRequestBaseAmount(requestRow, pricingConfig);
    const coupon = await evaluateWelcomeCouponForRequest({
        pool,
        userId,
        requestRow,
        pricingConfig,
        couponCode,
        preserveExistingApplied,
    });

    const breakdown = computePaymentAmounts(baseAmount, pricingConfig, {
        platformFeeDiscountPercent: coupon.isApplied ? coupon.discountPercent : 0,
    });

    return {
        breakdown,
        coupon,
    };
}

async function resolveRequestBaseAmount(requestRow, pricingConfig) {
    const technicianId = Number(requestRow?.technician_id);
    let technicianProfile = null;

    if (Number.isFinite(technicianId) && technicianId > 0) {
        if (
            requestRow?.technician_pricing != null ||
            requestRow?.technician_service_costs != null ||
            requestRow?.pricing != null ||
            requestRow?.service_costs != null
        ) {
            technicianProfile = {
                pricing: requestRow?.technician_pricing ?? requestRow?.pricing ?? null,
                service_costs: requestRow?.technician_service_costs ?? requestRow?.service_costs ?? null
            };
        } else {
            const pool = await getPool();
            const [techRows] = await pool.query(
                "SELECT pricing, service_costs FROM technicians WHERE id = ? LIMIT 1",
                [technicianId]
            );
            if (techRows.length > 0) {
                technicianProfile = techRows[0];
            }
        }
    }

    const techAmount = technicianProfile
        ? estimateRequestAmount(
            { service_type: requestRow?.service_type, vehicle_type: requestRow?.vehicle_type },
            technicianProfile
        )
        : null;
    if (techAmount != null) return techAmount;

    const direct = toPositiveMoney(requestRow?.amount ?? requestRow?.service_charge);
    if (direct != null) return direct;
    return estimateRequestAmountAsync(
        { service_type: requestRow?.service_type, vehicle_type: requestRow?.vehicle_type },
        null,
        pricingConfig
    );
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
    breakdown
}) {
    const [existing] = await pool.query(
        `SELECT id
         FROM payments
         WHERE service_request_id = ? AND razorpay_order_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [requestId, orderId]
    );

    if (existing.length > 0) {
        await pool.execute(
            `UPDATE payments
             SET status = ?, amount = ?, platform_fee = ?, technician_amount = ?, is_settled = TRUE
             WHERE id = ?`,
            ["PENDING", breakdown.totalAmount, breakdown.platformFee, breakdown.baseAmount, existing[0].id]
        );
        return existing[0].id;
    }

    const [insertResult] = await pool.execute(
        `INSERT INTO payments (
            user_id,
            service_request_id,
            payment_method,
            status,
            amount,
            platform_fee,
            technician_amount,
            is_settled,
            razorpay_order_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            requestId,
            "razorpay",
            "PENDING",
            breakdown.totalAmount,
            breakdown.platformFee,
            breakdown.baseAmount,
            true,
            orderId
        ]
    );

    return insertResult.insertId;
}

async function markClientSideVerification({
    pool,
    userId,
    requestId,
    orderId,
    paymentId,
    signature,
    breakdown
}) {
    const [existing] = await pool.query(
        `SELECT id
         FROM payments
         WHERE service_request_id = ? AND razorpay_order_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [requestId, orderId]
    );

    if (existing.length > 0) {
        await pool.execute(
            `UPDATE payments
             SET status = ?, razorpay_payment_id = ?, razorpay_signature = ?, amount = ?, platform_fee = ?, technician_amount = ?, is_settled = TRUE
             WHERE id = ?`,
            ["PROCESSING", paymentId, signature, breakdown.totalAmount, breakdown.platformFee, breakdown.baseAmount, existing[0].id]
        );
        return existing[0].id;
    }

    const [insertResult] = await pool.execute(
        `INSERT INTO payments (
            user_id,
            service_request_id,
            payment_method,
            status,
            amount,
            platform_fee,
            technician_amount,
            is_settled,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            requestId,
            "razorpay",
            "PROCESSING",
            breakdown.totalAmount,
            breakdown.platformFee,
            breakdown.baseAmount,
            true,
            orderId,
            paymentId,
            signature
        ]
    );

    return insertResult.insertId;
}

function buildInvoiceData({ invoiceId, request, breakdown, paymentId, orderId }) {
    return {
        invoiceId,
        orderId,
        requestId: request.id,
        customerName: request.customer_name || "Customer",
        customerPhone: request.customer_phone || "N/A",
        customerAddress: request.address || "N/A",
        serviceType: request.service_type || "Roadside Assistance",
        vehicleType: request.vehicle_type || "Vehicle",
        technicianName: request.technician_name || "Assigned Technician",
        amount: breakdown.baseAmount,
        platformFee: breakdown.platformFee,
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

async function finalizeCapturedServicePayment({ orderId, paymentId }) {
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
    };

    try {
        await conn.beginTransaction();

        const [paymentRows] = await conn.query(
            `SELECT *
             FROM payments
             WHERE razorpay_order_id = ?
             ORDER BY id DESC
             LIMIT 1
             FOR UPDATE`,
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

        const paymentRow = paymentRows[0];
        const requestId = Number(paymentRow.service_request_id);
        if (!Number.isFinite(requestId) || requestId <= 0) {
            await conn.rollback();
            return {
                ...result,
                processed: false,
                duplicate: false,
                reason: "service_request_missing_on_payment"
            };
        }

        const [requestRows] = await conn.query(
            `SELECT sr.id, sr.user_id, sr.technician_id, sr.service_type, sr.vehicle_type, sr.amount, sr.service_charge,
                    sr.address, sr.status, sr.payment_status,
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
        const pricingConfig = await getPlatformPricingConfig();
        const baseAmount = await resolveRequestBaseAmount(request, pricingConfig);
        const breakdown = computePaymentAmounts(
            baseAmount,
            pricingConfig,
            getStoredDiscountOptions(request)
        );

        const requestWasPaid = (
            String(request.status || "").toLowerCase() === "paid" ||
            String(request.payment_status || "").toLowerCase() === "completed"
        );

        await conn.execute(
            `UPDATE payments
             SET status = ?, amount = ?, platform_fee = ?, technician_amount = ?, is_settled = TRUE, razorpay_payment_id = ?
             WHERE id = ?`,
            ["completed", breakdown.totalAmount, breakdown.platformFee, breakdown.baseAmount, paymentId, paymentRow.id]
        );

        await conn.execute(
            `UPDATE service_requests
             SET payment_status = ?, payment_method = ?, status = ?, amount = ?
             WHERE id = ?`,
            ["completed", "razorpay", "paid", breakdown.baseAmount, requestId]
        );

        let invoiceId = null;
        let invoiceStatus = null;
        const [invoiceRows] = await conn.query(
            `SELECT id, status
             FROM invoices
             WHERE order_id = ? OR razorpay_payment_id = ?
             ORDER BY id DESC
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
                     platform_fee = ?, technician_amount = ?, gst = ?, total_amount = ?
                 WHERE id = ?`,
                [
                    request.user_id,
                    orderId,
                    requestId,
                    request.technician_id || null,
                    paymentId,
                    breakdown.totalAmount,
                    breakdown.platformFee,
                    breakdown.baseAmount,
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
                    technician_amount,
                    gst,
                    total_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                    breakdown.baseAmount,
                    0,
                    breakdown.totalAmount
                ]
            );
            invoiceId = insertInvoiceResult.insertId;
            invoiceStatus = "GENERATED";
        }

        if (request.technician_id && !requestWasPaid) {
            await conn.execute(
                `UPDATE technicians
                 SET jobs_completed = jobs_completed + 1,
                     total_earnings = total_earnings + ?
                 WHERE id = ?`,
                [breakdown.baseAmount, request.technician_id]
            );
        }

        await conn.commit();

        result = {
            processed: true,
            duplicate: requestWasPaid && String(paymentRow.status || "").toLowerCase() === "completed",
            requestId,
            userId: request.user_id,
            technicianId: request.technician_id || null,
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
        };

        return result;
    } catch (error) {
        try {
            await conn.rollback();
        } catch { }
        throw error;
    } finally {
        conn.release();
    }
}

async function processFinalizedServicePaymentNotifications(finalized, { paymentMethod = "razorpay" } = {}) {
    if (!finalized || !finalized.processed) return;
    const pool = await getPool();

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

    socketService.broadcast("admin:payment_update", {
        requestId: finalized.requestId,
        paymentMethod,
        status: "completed",
        at: new Date().toISOString()
    });

    if (finalized.technicianId) {
        socketService.notifyTechnician(finalized.technicianId, "job:status_update", {
            requestId: finalized.requestId,
            status: "paid"
        });
        socketService.notifyTechnician(finalized.technicianId, "job:list_update", {
            requestId: finalized.requestId,
            action: "updated"
        });
    }

    if (finalized.userId) {
        socketService.notifyUser(finalized.userId, "payment_completed", {
            requestId: finalized.requestId,
            status: "paid"
        });
        socketService.notifyUser(finalized.userId, "job:status_update", {
            requestId: finalized.requestId,
            status: "paid"
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
        let finalized = await finalizeCapturedServicePayment({ orderId, paymentId });

        // Backfill support: if no payment row exists yet, attempt to reconstruct it from Razorpay notes.
        if (!finalized.processed && finalized.reason === "payment_row_not_found") {
            const requestIdFromNotes = Number(paymentEntity?.notes?.requestId || paymentEntity?.notes?.request_id);
            const userIdFromNotes = Number(paymentEntity?.notes?.userId || paymentEntity?.notes?.user_id);

            if (Number.isFinite(requestIdFromNotes) && requestIdFromNotes > 0 && Number.isFinite(userIdFromNotes) && userIdFromNotes > 0) {
                const pool = await getPool();
                const pricingConfig = await getPlatformPricingConfig();
                const [reqRows] = await pool.query(
                    `SELECT amount, service_charge, service_type, vehicle_type, technician_id,
                            applied_coupon_code, applied_discount_percent, applied_discount_amount
                     FROM service_requests
                     WHERE id = ? AND user_id = ?
                     LIMIT 1`,
                    [requestIdFromNotes, userIdFromNotes]
                );

                if (reqRows.length > 0) {
                    const baseAmount = await resolveRequestBaseAmount(reqRows[0], pricingConfig);
                    const breakdown = computePaymentAmounts(
                        baseAmount,
                        pricingConfig,
                        getStoredDiscountOptions(reqRows[0])
                    );
                    await upsertPendingRazorpayPayment({
                        pool,
                        userId: userIdFromNotes,
                        requestId: requestIdFromNotes,
                        orderId,
                        breakdown
                    });
                    finalized = await finalizeCapturedServicePayment({ orderId, paymentId });
                }
            }
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
        const technicianId = req.technicianId;

        // Registration fee (e.g., ₹500)
        const pricingConfig = await getPlatformPricingConfig();
        const amount = Math.round(pricingConfig.registration_fee * 100); // Razorpay expects amount in paise

        const options = {
            amount: amount,
            currency: pricingConfig.currency || "INR",
            receipt: `reg_receipt_${technicianId}_${Date.now()}`,
        };

        const order = await razorpay.orders.create(options);

        // Save order ID to technician record
        const pool = await getPool();
        await pool.execute(
            "UPDATE technicians SET registration_order_id = ?, registration_payment_status = 'processing' WHERE id = ?",
            [order.id, technicianId]
        );

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error("[Payments] Create order error:", err);
        res.status(500).json({ error: "Failed to create payment order." });
    }
});

/**
 * POST /api/payments/verify-registration-payment
 * Verify the payment signature from Razorpay.
 */
router.post("/verify-registration-payment", verifyTechnician, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const technicianId = req.technicianId;
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;

        const generated_signature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        if (generated_signature === razorpay_signature) {
            // Payment verified
            const pool = await getPool();
            await pool.execute(
                "UPDATE technicians SET registration_payment_status = 'completed', registration_payment_id = ?, status = 'pending', is_active = FALSE, is_available = FALSE WHERE id = ?",
                [razorpay_payment_id, technicianId]
            );

            res.json({ success: true, message: "Payment verified successfully." });
        } else {
            res.status(400).json({ error: "Invalid payment signature." });
        }
    } catch (err) {
        console.error("[Payments] Verify payment error:", err);
        res.status(500).json({ error: "Payment verification failed." });
    }
});

/**
 * POST /api/payments/create-service-order
 * Create a Razorpay order for a service booking fee.
 */
router.post("/create-service-order", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const userId = req.user.userId;
        const { serviceType, vehicleType } = req.body;

        const pricingConfig = await getPlatformPricingConfig();
        const hasServiceHint = !!String(serviceType || "").trim() || !!String(vehicleType || "").trim();
        const matrixAmount = hasServiceHint
            ? await estimateRequestAmountAsync(
                { service_type: serviceType, vehicle_type: vehicleType },
                null,
                pricingConfig
            )
            : null;
        const resolvedAmount = Number.isFinite(Number(matrixAmount)) && Number(matrixAmount) > 0
            ? Number(matrixAmount)
            : Number(pricingConfig.booking_fee);
        const finalAmount = Math.round(resolvedAmount * 100);

        const options = {
            amount: finalAmount,
            currency: pricingConfig.currency || "INR",
            receipt: `service_receipt_${userId}_${Date.now()}`,
            notes: {
                userId,
                serviceType,
                vehicleType,
                resolvedAmount: String(resolvedAmount)
            }
        };

        const order = await razorpay.orders.create(options);

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error("[Payments] Create service order error:", err);
        res.status(500).json({ error: "Failed to create service payment order." });
    }
});

/**
 * POST /api/payments/verify-service-payment
 * Verify the payment signature for a service booking.
 */
router.post("/verify-service-payment", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;

        const generated_signature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        if (generated_signature === razorpay_signature) {
            res.json({ success: true, message: "Payment verified successfully." });
        } else {
            res.status(400).json({ error: "Invalid payment signature." });
        }
    } catch (err) {
        console.error("[Payments] Verify service payment error:", err);
        res.status(500).json({ error: "Payment verification failed." });
    }
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
            welcome_coupon_code: pricingConfig.welcome_coupon_code,
            welcome_coupon_discount_percent: pricingConfig.welcome_coupon_discount_percent,
            welcome_coupon_max_uses_per_user: pricingConfig.welcome_coupon_max_uses_per_user,
            welcome_coupon_active: pricingConfig.welcome_coupon_active,
            registration_fee: pricingConfig.registration_fee,
            booking_fee: pricingConfig.booking_fee,
            pay_now_discount_percent: pricingConfig.pay_now_discount_percent,
            default_service_amount: pricingConfig.default_service_amount,
            service_base_prices: pricingConfig.service_base_prices,
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
        const { requestId, couponCode, preserveExistingApplied } = req.body || {};
        const userId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [rows] = await pool.query(
            `SELECT id, user_id, amount, service_charge, service_type, vehicle_type, technician_id, status, payment_status,
                    applied_coupon_code, applied_discount_percent, applied_discount_amount
             FROM service_requests
             WHERE id = ? AND user_id = ?
             LIMIT 1`,
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });

        const requestRow = rows[0];
        if (isRequestAlreadyPaid(requestRow)) {
            return res.status(409).json({ error: 'Request already paid' });
        }

        const { breakdown, coupon } = await buildServiceRequestPaymentQuote({
            pool,
            requestRow,
            pricingConfig,
            couponCode,
            preserveExistingApplied: preserveExistingApplied !== false,
        });

        res.json({
            success: true,
            request_id: Number(requestId),
            breakdown: {
                currency: breakdown.currency,
                base_amount: breakdown.baseAmount,
                platform_fee_percent: breakdown.platformFeePercent,
                original_platform_fee: breakdown.originalPlatformFee,
                discount_amount: breakdown.discountAmount,
                platform_fee: breakdown.platformFee,
                total_amount: breakdown.totalAmount,
            },
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
            `SELECT id, user_id, amount, service_charge, service_type, vehicle_type, technician_id, status, payment_status,
                    applied_coupon_code, applied_discount_percent, applied_discount_amount
             FROM service_requests
             WHERE id = ? AND user_id = ?`,
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
        if (isRequestAlreadyPaid(rows[0])) {
            return res.status(409).json({ error: 'Request already paid' });
        }

        const requestRow = rows[0];
        const { breakdown, coupon } = await buildServiceRequestPaymentQuote({
            pool,
            requestRow,
            pricingConfig,
            couponCode,
            preserveExistingApplied: false,
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

        const options = {
            amount: Math.round(breakdown.totalAmount * 100),
            currency: breakdown.currency,
            receipt: `receipt_${requestId}_${Date.now()}`,
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
            breakdown
        });

        await pool.execute(
            `UPDATE service_requests
             SET payment_method = ?,
                 payment_status = ?,
                 applied_coupon_code = ?,
                 applied_discount_percent = ?,
                 applied_discount_amount = ?
             WHERE id = ?`,
            [
                "razorpay",
                "pending",
                coupon.appliedCode || null,
                coupon.isApplied ? coupon.discountPercent : 0,
                breakdown.discountAmount,
                requestId
            ]
        );

        // Return breakdown so frontend can display consistent info
        res.json({
            ...order,
            base_amount: breakdown.baseAmount,
            original_platform_fee: breakdown.originalPlatformFee,
            discount_amount: breakdown.discountAmount,
            platform_fee: breakdown.platformFee,
            platform_fee_percent: breakdown.platformFeePercent,
            total_amount: breakdown.totalAmount,
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
        res.status(500).json({ error: 'Failed to create payment order' });
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
            `SELECT id, amount, service_charge, service_type, vehicle_type, technician_id, user_id, status, payment_status,
                    applied_coupon_code, applied_discount_percent, applied_discount_amount
             FROM service_requests
             WHERE id = ? AND user_id = ?
             LIMIT 1`,
            [requestId, authUserId]
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });

        const requestRow = reqRows[0];
        if (isRequestAlreadyPaid(requestRow)) {
            return res.json({ success: true, alreadyPaid: true });
        }

        const baseAmount = await resolveRequestBaseAmount(requestRow, pricingConfig);
        const breakdown = computePaymentAmounts(
            baseAmount,
            pricingConfig,
            getStoredDiscountOptions(requestRow)
        );

        await markClientSideVerification({
            pool,
            userId: authUserId,
            requestId,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            signature: razorpay_signature,
            breakdown
        });

        await pool.execute(
            "UPDATE service_requests SET payment_method = ? WHERE id = ?",
            ["razorpay", requestId]
        );

        let finalized = await finalizeCapturedServicePayment({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id
        });

        if (!finalized.processed && finalized.reason === "payment_row_not_found") {
            await upsertPendingRazorpayPayment({
                pool,
                userId: authUserId,
                requestId,
                orderId: razorpay_order_id,
                breakdown
            });
            finalized = await finalizeCapturedServicePayment({
                orderId: razorpay_order_id,
                paymentId: razorpay_payment_id
            });
        }

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
                request: updatedRows[0] || null,
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
        res.status(500).json({ error: 'Failed to confirm payment' });
    }
});

// Cash payment for a request
router.post('/cash', verifyUser, async (req, res) => {
    try {
        console.log('PAYMENT REQUEST: cash (body):', req.body);
        const { requestId, couponCode } = req.body || {};
        const authUserId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [reqRows] = await pool.query(
            `SELECT id, user_id, amount, service_charge, service_type, vehicle_type, technician_id, status, payment_status,
                    applied_coupon_code, applied_discount_percent, applied_discount_amount
             FROM service_requests
             WHERE id = ? AND user_id = ?`,
            [requestId, authUserId]
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });
        if (isRequestAlreadyPaid(reqRows[0])) {
            return res.json({ success: true, alreadyPaid: true });
        }

        const requestRow = reqRows[0];
        const technicianId = requestRow.technician_id;
        const userId = requestRow.user_id;
        const { breakdown, coupon } = await buildServiceRequestPaymentQuote({
            pool,
            requestRow,
            pricingConfig,
            couponCode,
            preserveExistingApplied: false,
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

        const techAmount = breakdown.baseAmount;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            await conn.execute(
                `UPDATE service_requests
                 SET payment_status = ?,
                     payment_method = ?,
                     status = ?,
                     amount = ?,
                     applied_coupon_code = ?,
                     applied_discount_percent = ?,
                     applied_discount_amount = ?
                 WHERE id = ?`,
                [
                    'completed',
                    'cash',
                    'paid',
                    breakdown.baseAmount,
                    coupon.appliedCode || null,
                    coupon.isApplied ? coupon.discountPercent : 0,
                    breakdown.discountAmount,
                    requestId
                ]
            );
            console.log('REQUEST STATUS UPDATED:', { requestId, status: 'paid', amount: breakdown.baseAmount });

            await conn.execute(
                `INSERT INTO payments (user_id, service_request_id, payment_method, status, amount, platform_fee, technician_amount, is_settled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, requestId, 'cash', 'completed', breakdown.totalAmount, breakdown.platformFee, techAmount, false]
            );

            const [invResult] = await conn.execute(
                `INSERT INTO invoices (
                    user_id, order_id, razorpay_payment_id, amount, invoice_pdf, status,
                    service_request_id, technician_id, platform_fee, technician_amount, gst, total_amount
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    `cash_${requestId}_${Date.now()}`,
                    null,
                    breakdown.totalAmount,
                    null,
                    "GENERATED",
                    requestId,
                    technicianId || null,
                    breakdown.platformFee,
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
                    customerAddress: "N/A",
                    serviceType: reqRows[0].service_type || "Roadside Assistance",
                    vehicleType: reqRows[0].vehicle_type || "Vehicle",
                    technicianName: "Assigned Technician",
                    amount: breakdown.baseAmount,
                    platformFee: breakdown.platformFee,
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
            socketService.broadcast("admin:payment_update", {
                requestId,
                paymentMethod: "cash",
                status: "completed",
                totalAmount: breakdown.totalAmount,
                at: new Date().toISOString()
            });

            if (technicianId) {
                socketService.notifyTechnician(technicianId, 'job:status_update', { requestId, status: 'paid' });
                socketService.notifyTechnician(technicianId, 'job:list_update', { requestId, action: 'updated' });
            }
            socketService.notifyUser(userId, 'payment_completed', { requestId, status: 'paid' });
            socketService.notifyUser(userId, 'job:status_update', { requestId, status: 'paid' });

            const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
            res.json({ success: true, request: updatedRows[0] });

        } catch (txErr) {
            await conn.rollback();
            console.error('Cash payment transaction error:', txErr);
            paymentDiag("cash_payment_tx_failed", { requestId, userId: req.user.userId, error: txErr?.message || String(txErr) });
            return res.status(500).json({ error: 'Failed to process cash payment' });
        } finally {
            conn.release();
        }

    } catch (err) {
        console.error('Cash payment error:', err);
        paymentDiag("cash_payment_failed", { requestId: req?.body?.requestId, userId: req?.user?.userId, error: err?.message || String(err) });
        res.status(500).json({ error: 'Failed to process cash payment' });
    }
});

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
                p.status AS payment_row_status,
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
                SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed_payments,
                SUM(CASE WHEN p.payment_method = 'cash' THEN 1 ELSE 0 END) AS cash_payments,
                SUM(CASE WHEN p.payment_method = 'razorpay' THEN 1 ELSE 0 END) AS online_payments,
                IFNULL(SUM(CASE WHEN p.status = 'completed' THEN p.amount ELSE 0 END), 0) AS gross_amount
            FROM payments p`
        );

        const records = rows.map((row) => {
            const checks = {
                request_paid_consistent: !(String(row.request_status) === "paid" && String(row.request_payment_status) !== "completed"),
                payment_method_consistent: !row.request_payment_method || String(row.request_payment_method) === String(row.payment_method)
            };
            return { ...row, checks };
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
            `SELECT id, user_id, technician_id, status, payment_status, payment_method, amount, created_at, updated_at
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

        const request = requestRows[0];
        const latestPayment = paymentRows[0] || null;
        const latestInvoice = invoiceRows[0] || null;

        const checks = {
            request_exists: true,
            paid_status_consistent: !(['paid'].includes(String(request.status)) && String(request.payment_status) !== 'completed'),
            payment_row_exists_if_paid: !(['paid'].includes(String(request.status)) && paymentRows.length === 0),
            invoice_exists_if_paid: !(['paid'].includes(String(request.status)) && invoiceRows.length === 0),
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
        const userId = req.user.userId;
        const { planId } = req.body;
        if (!planId) {
            return res.status(400).json({ error: "Missing planId" });
        }

        const pricingConfig = await getPlatformPricingConfig();
        const plan = getSubscriptionPlanById(planId, pricingConfig);
        if (!plan || plan.active === false) {
            return res.status(400).json({ error: "Invalid or inactive planId" });
        }

        const amount = Math.round(Number(plan.amount || 0) * 100);
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: "Selected plan does not require online payment" });
        }

        const options = {
            amount,
            currency: pricingConfig.currency || "INR",
            receipt: `sub_${planId}_${userId}_${Date.now()}`,
            notes: {
                userId,
                planId,
                planAmount: String(plan.amount),
                type: "subscription"
            }
        };

        const order = await razorpay.orders.create(options);

        res.json({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: RAZORPAY_KEY_ID
        });
    } catch (err) {
        console.error("[Payments] Create subscription order error:", err);
        res.status(500).json({ error: "Failed to create subscription order." });
    }
});

/**
 * POST /api/payments/verify-subscription-payment
 */
router.post("/verify-subscription-payment", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const userId = req.user.userId;
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            planId
        } = req.body;
        if (!planId) {
            return res.status(400).json({ error: "Missing planId" });
        }

        const pricingConfig = await getPlatformPricingConfig();
        const plan = getSubscriptionPlanById(planId, pricingConfig);
        if (!plan || plan.active === false) {
            return res.status(400).json({ error: "Invalid or inactive planId" });
        }

        const generated_signature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        console.log("[Debug] Subscription Verification:", {
            secret_exists: true,
            secret_len: RAZORPAY_KEY_SECRET.length,
            generated: generated_signature,
            received: razorpay_signature,
            input: razorpay_order_id + "|" + razorpay_payment_id
        });

        if (generated_signature === razorpay_signature) {
            // Payment verified
            // Update user subscription in database
            const pool = await getPool();

            try {
                // Map planId to db enum if necessary (e.g. 'basic' matches db enum)
                // Assuming table 'users' has column 'subscription'
                await pool.execute(
                    "UPDATE users SET subscription = ? WHERE id = ?",
                    [planId, userId]
                );
            } catch (dbErr) {
                console.error("[Payments] Subscription DB Update Error:", dbErr);
                return res.status(500).json({ error: "Database update failed during subscription verification." });
            }

            // Access to AuthContext update happens on frontend, but we ensure DB is correct here.

            res.json({
                success: true,
                message: "Subscription verified successfully."
            });
        } else {
            res.status(400).json({ error: "Invalid payment signature." });
        }
    } catch (err) {
        console.error("[Payments] Verify subscription payment error:", err);
        res.status(500).json({ error: "Payment verification failed." });
    }
});


export default router;

