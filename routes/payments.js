
import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getPool } from "../db.js";
import { verifyAdmin, verifyTechnician, verifyUser } from "../middleware/auth.js";
import { socketService } from "../services/socket.js";
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
const hasRazorpayConfig = Boolean(
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET &&
    !RAZORPAY_KEY_ID.includes("placeholder") &&
    !RAZORPAY_KEY_SECRET.includes("placeholder")
);

// Initialize Razorpay
// Note: These should be in your .env file
const razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: RAZORPAY_KEY_SECRET || 'secret_placeholder',
});

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

/**
 * POST /api/payments/create-registration-order
 * Create a Razorpay order for technician registration fee.
 */
router.post("/create-registration-order", verifyTechnician, async (req, res) => {
    try {
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
            key_id: process.env.RAZORPAY_KEY_ID
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
        const technicianId = req.technicianId;
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;

        const secret = process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder';
        const generated_signature = crypto
            .createHmac("sha256", secret)
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
            key_id: process.env.RAZORPAY_KEY_ID
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
        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = req.body;

        const secret = process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder';
        const generated_signature = crypto
            .createHmac("sha256", secret)
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

// Create order for a specific service request
router.post('/create-order', verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        console.log('PAYMENT REQUEST: create-order (body):', req.body);
        const { requestId } = req.body;
        const userId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [rows] = await pool.query(
            'SELECT amount, service_charge, service_type, vehicle_type, technician_id, status, payment_status FROM service_requests WHERE id = ? AND user_id = ?',
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found' });
        if (rows[0].payment_status === 'completed' || rows[0].status === 'paid') {
            return res.status(409).json({ error: 'Request already paid' });
        }

        const baseAmount = await resolveRequestBaseAmount(rows[0], pricingConfig);
        const breakdown = computePaymentAmounts(baseAmount, pricingConfig);

        const options = {
            amount: Math.round(breakdown.totalAmount * 100),
            currency: breakdown.currency,
            receipt: `receipt_${requestId}_${Date.now()}`,
            payment_capture: 1
        };

        const order = await razorpay.orders.create(options);
        console.log('PAYMENT ORDER CREATED:', order.id, 'for request', requestId, 'Total:', breakdown.totalAmount);
        paymentDiag("create_order_success", {
            requestId,
            userId,
            orderId: order.id,
            baseAmount: breakdown.baseAmount,
            platformFee: breakdown.platformFee,
            totalAmount: breakdown.totalAmount,
            platformFeePercent: breakdown.platformFeePercent
        });

        // Return breakdown so frontend can display consistent info
        res.json({
            ...order,
            base_amount: breakdown.baseAmount,
            platform_fee: breakdown.platformFee,
            platform_fee_percent: breakdown.platformFeePercent,
            total_amount: breakdown.totalAmount,
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
        const pricingConfig = await getPlatformPricingConfig();
        const authUserId = req.user.userId;
        const [reqRows] = await pool.query(
            `SELECT sr.amount, sr.service_charge, sr.vehicle_type, sr.technician_id, sr.user_id, sr.service_type, sr.address, 
                    sr.status, sr.payment_status,
                    u.email as customer_email, u.full_name as customer_name, u.phone as customer_phone, 
                    t.name as technician_name
             FROM service_requests sr 
             JOIN users u ON sr.user_id = u.id 
             LEFT JOIN technicians t ON sr.technician_id = t.id
             WHERE sr.id = ? AND sr.user_id = ?`,
            [requestId, authUserId]
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });

        const invDetails = reqRows[0];
        if (invDetails.payment_status === 'completed' || invDetails.status === 'paid') {
            return res.json({ success: true, alreadyPaid: true });
        }
        const baseAmount = await resolveRequestBaseAmount(invDetails, pricingConfig);
        const technicianId = invDetails.technician_id;
        const userId = invDetails.user_id;

        const breakdown = computePaymentAmounts(baseAmount, pricingConfig);
        const techAmount = breakdown.baseAmount;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            await conn.execute(
                "UPDATE service_requests SET payment_status = ?, payment_method = ?, status = ?, amount = ? WHERE id = ?",
                ['completed', 'razorpay', 'paid', breakdown.baseAmount, requestId]
            );
            console.log('REQUEST STATUS UPDATED:', { requestId, status: 'paid', amount: breakdown.baseAmount });

            await conn.execute(
                `INSERT INTO payments (user_id, service_request_id, payment_method, status, amount, platform_fee, technician_amount, is_settled, razorpay_order_id, razorpay_payment_id, razorpay_signature)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, requestId, 'razorpay', 'completed', breakdown.totalAmount, breakdown.platformFee, techAmount, true, razorpay_order_id, razorpay_payment_id, razorpay_signature]
            );

            const [invResult] = await conn.execute(
                `INSERT INTO invoices (service_request_id, user_id, technician_id, amount, platform_fee, technician_amount, gst, total_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [requestId, userId, technicianId || null, breakdown.baseAmount, breakdown.platformFee, techAmount, 0, breakdown.totalAmount]
            );

            const invoiceId = invResult.insertId;
            let pdfPath = '';

            // Generate Invoice PDF
            try {
                const fs = await import('fs');
                const { generateInvoicePDF } = await import('../services/invoiceService.js');

                // Construct invoice data object
                const invoiceData = {
                    invoiceId: invoiceId,
                    requestId: requestId,
                    customerName: invDetails.customer_name,
                    customerPhone: invDetails.customer_phone,
                    customerAddress: invDetails.address,
                    serviceType: invDetails.service_type,
                    technicianName: invDetails.technician_name,
                    amount: breakdown.baseAmount,
                    platformFee: breakdown.platformFee,
                    totalAmount: breakdown.totalAmount,
                    paymentMethod: 'Razorpay',
                    transactionId: razorpay_payment_id
                };

                pdfPath = await generateInvoicePDF(invoiceData);
                await conn.execute('UPDATE invoices SET pdf_path = ? WHERE id = ?', [pdfPath, invoiceId]);

                // Send Email
                if (invDetails.customer_email) {
                    console.log(`Sending invoice email to: ${invDetails.customer_email}`);
                    const pdfBuffer = fs.readFileSync(pdfPath);
                    const { sendInvoiceEmail } = await import('../services/mailer.js');
                    await sendInvoiceEmail(invDetails.customer_email, invoiceData, pdfBuffer);
                    console.log('Invoice email sent successfully');
                }

            } catch (err) {
                console.error('Invoice generation/email failed:', err);
                // Non-critical failure, continue
            }

            if (technicianId) {
                await conn.execute('UPDATE technicians SET jobs_completed = jobs_completed + 1, total_earnings = total_earnings + ? WHERE id = ?', [techAmount, technicianId]);
            }

            await conn.commit();
            paymentDiag("confirm_payment_success", {
                requestId,
                userId,
                technicianId,
                paymentMethod: "razorpay",
                totalAmount: breakdown.totalAmount,
                platformFee: breakdown.platformFee,
                technicianAmount: techAmount
            });
            socketService.broadcast("admin:payment_update", {
                requestId,
                paymentMethod: "razorpay",
                status: "completed",
                totalAmount: breakdown.totalAmount,
                at: new Date().toISOString()
            });

            // Notify parties
            if (technicianId) socketService.notifyTechnician(technicianId, 'job:status_update', { requestId, status: 'paid' });
            socketService.notifyUser(userId, 'payment_completed', { requestId, status: 'paid' });
            socketService.notifyUser(userId, 'job:status_update', { requestId, status: 'paid' });

            const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
            res.json({ success: true, request: updatedRows[0] });

        } catch (txErr) {
            await conn.rollback();
            console.error('Confirm payment transaction error:', txErr);
            paymentDiag("confirm_payment_tx_failed", { requestId, userId: req.user.userId, error: txErr?.message || String(txErr) });
            return res.status(500).json({ error: 'Payment confirmation failed' });
        } finally {
            conn.release();
        }

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
        const { requestId } = req.body;
        const authUserId = req.user.userId;
        if (!requestId) return res.status(400).json({ error: 'requestId is required' });

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [reqRows] = await pool.query(
            'SELECT amount, service_charge, service_type, vehicle_type, technician_id, user_id, status, payment_status FROM service_requests WHERE id = ? AND user_id = ?',
            [requestId, authUserId]
        );
        if (reqRows.length === 0) return res.status(404).json({ error: 'Request not found' });
        if (reqRows[0].payment_status === 'completed' || reqRows[0].status === 'paid') {
            return res.json({ success: true, alreadyPaid: true });
        }

        const baseAmount = await resolveRequestBaseAmount(reqRows[0], pricingConfig);
        const technicianId = reqRows[0].technician_id;
        const userId = reqRows[0].user_id;

        const breakdown = computePaymentAmounts(baseAmount, pricingConfig);
        const techAmount = breakdown.baseAmount;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            await conn.execute(
                "UPDATE service_requests SET payment_status = ?, payment_method = ?, status = ?, amount = ? WHERE id = ?",
                ['completed', 'cash', 'paid', breakdown.baseAmount, requestId]
            );
            console.log('REQUEST STATUS UPDATED:', { requestId, status: 'paid', amount: breakdown.baseAmount });

            await conn.execute(
                `INSERT INTO payments (user_id, service_request_id, payment_method, status, amount, platform_fee, technician_amount, is_settled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, requestId, 'cash', 'completed', breakdown.totalAmount, breakdown.platformFee, techAmount, false]
            );

            const [invResult] = await conn.execute(
                `INSERT INTO invoices (service_request_id, user_id, technician_id, amount, platform_fee, technician_amount, gst, total_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [requestId, userId, technicianId || null, breakdown.baseAmount, breakdown.platformFee, techAmount, 0, breakdown.totalAmount]
            );

            const invoiceId = invResult.insertId;
            // generate pdf invoice (best effort)
            try {
                const fs = await import('fs');
                const PDFDocument = (await import('pdfkit')).default;
                const uploadsDir = './server/uploads/invoices';
                fs.mkdirSync(uploadsDir, { recursive: true });

                const pdfPath = `${uploadsDir}/invoice_${invoiceId}.pdf`;
                const doc = new PDFDocument({ size: 'A4' });
                const stream = fs.createWriteStream(pdfPath);
                doc.pipe(stream);

                doc.fontSize(18).text('ResQNow Invoice (Cash)', { align: 'center' });
                doc.moveDown();
                doc.fontSize(12).text(`Invoice ID: ${invoiceId}`);
                doc.text(`Request ID: ${requestId}`);
                doc.text(`Service Amount: INR ${breakdown.baseAmount.toFixed(2)}`);
                doc.text(`Platform Fee: INR ${breakdown.platformFee.toFixed(2)}`);
                doc.moveDown();
                doc.fontSize(14).text(`Total Paid: INR ${breakdown.totalAmount.toFixed(2)}`, { underline: true });

                doc.end();
                await new Promise((resolve, reject) => {
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });

                await conn.execute('UPDATE invoices SET pdf_path = ? WHERE id = ?', [pdfPath, invoiceId]);
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
                totalAmount: breakdown.totalAmount,
                platformFee: breakdown.platformFee,
                technicianAmount: techAmount
            });
            socketService.broadcast("admin:payment_update", {
                requestId,
                paymentMethod: "cash",
                status: "completed",
                totalAmount: breakdown.totalAmount,
                at: new Date().toISOString()
            });

            if (technicianId) socketService.notifyTechnician(technicianId, 'job:status_update', { requestId, status: 'paid' });
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
            `SELECT id, total_amount, pdf_path, created_at
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
            invoice_pdf_present: !latestInvoice || !!latestInvoice.pdf_path,
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
            key_id: process.env.RAZORPAY_KEY_ID
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

        const secret = process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder';
        const generated_signature = crypto
            .createHmac("sha256", secret)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        console.log("[Debug] Subscription Verification:", {
            secret_exists: !!secret,
            secret_len: secret ? secret.length : 0,
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

