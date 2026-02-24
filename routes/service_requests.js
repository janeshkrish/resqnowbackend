
import express from "express";
import { getPool } from "../db.js";
import path from 'path';
import crypto from 'crypto';
import { verifyUser, verifyTechnician } from "../middleware/auth.js";
import { socketService } from "../services/socket.js";
import * as mail from "../services/mailer.js";
import Razorpay from "razorpay";
import {
    canonicalizeServiceDomain,
    canonicalizeVehicleFamily,
    parseVehicleTypes,
    serviceDomainsFromCosts
} from "../services/serviceNormalization.js";
import { estimateRequestAmount, estimateRequestAmountAsync } from "../services/pricingEstimator.js";
import { computePaymentAmounts, getPlatformPricingConfig } from "../services/platformPricing.js";

const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "");
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "");
const hasRazorpayConfig = Boolean(
    RAZORPAY_KEY_ID &&
    RAZORPAY_KEY_SECRET &&
    !RAZORPAY_KEY_ID.includes("placeholder") &&
    !RAZORPAY_KEY_SECRET.includes("placeholder")
);

const safeParse = (value) => {
    try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return []; }
};

const toPositiveMoney = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

async function resolveRequestBaseAmount(requestRow, pricingConfig = null) {
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

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const razorpay = hasRazorpayConfig
    ? new Razorpay({
        key_id: RAZORPAY_KEY_ID,
        key_secret: RAZORPAY_KEY_SECRET,
    })
    : null;

const router = express.Router();

const ensureRazorpayConfigured = (res) => {
    if (hasRazorpayConfig) return true;
    res.status(503).json({
        error: "Payment gateway is not configured. Please contact support."
    });
    return false;
};

// Allowed statuses and a small normalization helper to accept variants used in the UI
const VALID_STATUSES = new Set([
    'pending', 'assigned', 'accepted', 'on-the-way', 'en-route', 'arrived', 'in-progress', 'payment_pending', 'completed', 'cancelled', 'rejected'
]);

function normalizeStatus(status) {
    if (!status && status !== 0) return null;
    const s = String(status).trim();
    const map = {
        'on_the_way': 'on-the-way',
        'on the way': 'on-the-way',
        'on-the-way': 'on-the-way',
        'in_progress': 'in-progress',
        'in-progress': 'in-progress',
        'en_route': 'en-route',
        'en-route': 'en-route',
        'payment_pending': 'payment_pending'
    };
    if (map[s]) return map[s];
    if (VALID_STATUSES.has(s)) return s;
    return null;
}

/**
 * GET /api/service-requests
 * Fetch all service requests for the logged-in user.
 */
router.get("/", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const pool = await getPool();

        const [rows] = await pool.query(`
      SELECT 
        sr.*,
        t.name as technician_name,
        t.phone as technician_phone,
        t.rating as technician_rating,
        t.jobs_completed as technician_jobs_completed,
        t.latitude as technician_lat,
        t.longitude as technician_lng,
        t.pricing as technician_pricing,
        EXISTS(
          SELECT 1 FROM reviews r
          WHERE r.service_request_id = sr.id AND r.user_id = ?
        ) as has_review
      FROM service_requests sr
      LEFT JOIN technicians t ON sr.technician_id = t.id
      WHERE sr.user_id = ?
      ORDER BY sr.created_at DESC
    `, [userId, userId]);

        const requests = rows.map(row => ({
            id: row.id,
            service_type: row.service_type,
            vehicle_type: row.vehicle_type,
            vehicle_model: row.vehicle_model,
            address: row.address,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
            technician_id: row.technician_id,
            contact_phone: row.contact_phone,
            description: row.description,
            location_lat: row.location_lat,
            location_lng: row.location_lng,
            technician: row.technician_id ? {
                id: row.technician_id,
                name: row.technician_name,
                phone: row.technician_phone,
                rating: Number.isFinite(Number(row.technician_rating)) ? Number(row.technician_rating) : 0,
                completedJobs: Number.isFinite(Number(row.technician_jobs_completed)) ? Number(row.technician_jobs_completed) : 0,
                location: {
                    lat: Number.isFinite(Number(row.technician_lat)) ? Number(row.technician_lat) : null,
                    lng: Number.isFinite(Number(row.technician_lng)) ? Number(row.technician_lng) : null
                }
            } : null,
            has_review: !!row.has_review
        }));

        res.json(requests);
    } catch (err) {
        console.error("[Service Requests] Error fetching requests:", err);
        res.status(500).json({ error: "Failed to fetch service requests." });
    }
});

/**
 * POST /api/service-requests
 * Create a new service request.
 */
// POST /api/service-requests
router.post("/", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            service_type,
            vehicle_type,
            vehicle_model,
            address,
            contact_phone,
            description,
            location_lat,
            location_lng,
            technician_id
        } = req.body;

        console.log(`[Create Request] User: ${userId}, Service: ${service_type}, Lat: ${location_lat}, Lng: ${location_lng}`);

        if (!service_type || !address) {
            return res.status(400).json({ error: "Service type and address are required." });
        }

        const rawService = String(service_type || "").trim();
        const rawVehicle = String(vehicle_type || "").trim();
        const inferredVehicle = canonicalizeVehicleFamily(rawVehicle || rawService.split("-")[0]);
        const inferredDomain = canonicalizeServiceDomain(rawService.replace(/^(car|bike|ev|commercial)-/i, ""));
        if (!inferredVehicle || !inferredDomain) {
            return res.status(400).json({ error: "Invalid service_type or vehicle_type for dispatch." });
        }
        const canonicalServiceType = `${inferredVehicle}-${inferredDomain}`;

        const pool = await getPool();

        // 1. Prevent Duplicate Bookings
        const [recentRequests] = await pool.query(
            "SELECT id FROM service_requests WHERE user_id = ? AND service_type = ? AND status IN ('pending', 'assigned', 'accepted') AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)",
            [userId, canonicalServiceType]
        );

        if (recentRequests.length > 0) {
            return res.status(409).json({
                error: "A similar request is already active.",
                id: recentRequests[0].id
            });
        }

        // 2. Validate selection + resolve server-side amount
        const incomingAmount = Number(req.body.amount ?? req.body.price);
        const hasDirectTechnician = technician_id !== undefined && technician_id !== null && String(technician_id).trim() !== "";
        let directTechnicianId = hasDirectTechnician ? Number(technician_id) : null;
        let selectedTechnician = null;

        if (hasDirectTechnician) {
            if (!Number.isFinite(directTechnicianId)) {
                return res.status(400).json({ error: "Invalid technician_id." });
            }

            const [techRows] = await pool.query(
                "SELECT id, status, is_active, is_available, latitude, longitude, service_area_range, service_type, specialties, pricing, service_costs, vehicle_types FROM technicians WHERE id = ? LIMIT 1",
                [directTechnicianId]
            );
            const tech = techRows?.[0];
            if (!tech) {
                return res.status(404).json({ error: "Selected technician not found." });
            }
            selectedTechnician = tech;
            if (String(tech.status || "").toLowerCase() !== "approved") {
                return res.status(400).json({ error: "Selected technician is not approved." });
            }
            if (!tech.is_active || !tech.is_available) {
                return res.status(400).json({ error: "Selected technician is not currently available." });
            }
            const serviceDomains = [
                canonicalizeServiceDomain(tech.service_type),
                ...(Array.isArray(safeParse(tech.specialties)) ? safeParse(tech.specialties).map((s) => canonicalizeServiceDomain(s)) : []),
                ...serviceDomainsFromCosts(tech.service_costs)
            ].filter(Boolean);
            if (!serviceDomains.includes(inferredDomain)) {
                return res.status(400).json({ error: "Selected technician does not support this service domain." });
            }
            const techVehicles = parseVehicleTypes(tech.vehicle_types);
            if (!techVehicles.includes(inferredVehicle)) {
                return res.status(400).json({ error: "Selected technician does not support this vehicle type." });
            }
            const tLat = Number(tech.latitude);
            const tLng = Number(tech.longitude);
            const uLat = Number(location_lat);
            const uLng = Number(location_lng);
            if (Number.isFinite(tLat) && Number.isFinite(tLng) && Number.isFinite(uLat) && Number.isFinite(uLng)) {
                const dist = getDistanceFromLatLonInKm(uLat, uLng, tLat, tLng);
                const techRange = Number(tech.service_area_range);
                if (Number.isFinite(techRange) && techRange > 0 && dist > techRange) {
                    return res.status(400).json({ error: "Selected technician is out of service range for this location." });
                }
            }
        }

        let initialAmount = null;
        if (hasDirectTechnician && selectedTechnician) {
            initialAmount = await estimateRequestAmountAsync(
                { service_type: canonicalServiceType, vehicle_type: inferredVehicle },
                selectedTechnician
            );
        }

        if (initialAmount == null) {
            initialAmount = Number.isFinite(incomingAmount) && incomingAmount > 0
                ? incomingAmount
                : await estimateRequestAmountAsync({ service_type: canonicalServiceType, vehicle_type: inferredVehicle });
        }

        const initialStatus = hasDirectTechnician ? "assigned" : "pending";

        const [result] = await pool.execute(
            `INSERT INTO service_requests 
      (user_id, service_type, vehicle_type, vehicle_model, address, contact_name, contact_email, contact_phone, description, location_lat, location_lng, technician_id, status, started_at, amount) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [
                userId,
                canonicalServiceType,
                inferredVehicle || null,
                vehicle_model || null,
                address,
                req.body.contact_name || null,
                req.body.contact_email || null,
                contact_phone || null,
                description || null,
                location_lat || null,
                location_lng || null,
                directTechnicianId,
                initialStatus,
                initialAmount
            ]
        );

        const newRequestId = result.insertId;
        console.log(`[Create Job] Created Request #${newRequestId}`);

        // 3. Trigger Direct Notify or Smart Dispatch (Async)
        // We do this asynchronously so we can return quickly to the UI
        (async () => {
            try {
                if (hasDirectTechnician && directTechnicianId) {
                    socketService.notifyTechnician(directTechnicianId, "job:assigned", {
                        id: String(newRequestId),
                        requestId: String(newRequestId),
                        customerName: req.body.contact_name || "Customer",
                        serviceType: canonicalServiceType,
                        vehicleType: inferredVehicle,
                        location: {
                            lat: location_lat,
                            lng: location_lng,
                            address
                        },
                        address,
                        amount: initialAmount || 0
                    });
                    socketService.notifyTechnician(directTechnicianId, "job:list_update", {
                        requestId: String(newRequestId),
                        action: "created"
                    });
                    return;
                }

                const { jobDispatchService } = await import("../services/jobDispatchService.js");
                const jobRequest = {
                    id: newRequestId,
                    location_lat,
                    location_lng,
                    service_type: canonicalServiceType,
                    vehicle_type: inferredVehicle,
                    address,
                    amount: initialAmount,
                    contact_name: req.body.contact_name || null
                };

                const candidates = await jobDispatchService.findTopTechnicians(jobRequest);
                console.log(`[Create Job] Found ${candidates.length} candidates for #${newRequestId}`);

                if (candidates.length > 0) {
                    await jobDispatchService.dispatchJob(jobRequest, candidates);
                } else {
                    // No technicians found immediately
                    // Provide fallback or keep pending for admin manual assignment
                    console.log(`[Create Job] No auto-match candidates for #${newRequestId}`);
                }
            } catch (dispatchErr) {
                console.error("[Dispatch Error]", dispatchErr);
            }
        })();

        res.json({
            id: newRequestId,
            user_id: userId,
            service_type: canonicalServiceType,
            canonical_service_type: canonicalServiceType,
            status: initialStatus,
            technician_id: directTechnicianId,
            message: hasDirectTechnician
                ? "Request created and assigned. Technician has been notified."
                : "Request created. Searching for nearby technicians...",
            created_at: new Date()
        });

    } catch (err) {
        console.error("[Service Requests] Error creating request:", err);
        res.status(500).json({ error: "Failed to create service request." });
    }
});


// ... (GET and other routes remain same)

/**
 * POST /api/service-requests/:id/accept
 * Technician Accepts a Broadcast Job
 */
router.post("/:id/accept", verifyTechnician, async (req, res) => {
    try {
        const technicianId = req.technicianId;
        const requestId = req.params.id;

        console.log(`[Accept Job] Tech ${technicianId} attempting to accept Request ${requestId}`);

        const { jobDispatchService } = await import("../services/jobDispatchService.js");
        const result = await jobDispatchService.acceptJob(technicianId, requestId);

        if (!result.success) {
            return res.status(409).json({ error: result.reason || "Job already taken." });
        }

        res.json({ success: true, job: result.job });

    } catch (err) {
        console.error("[Accept Job] Error:", err);
        res.status(500).json({ error: "Failed to accept job." });
    }
});


/**
 * PATCH /api/service-requests/:id/technician-status
 * Update request status (For Technician)
 */
router.patch("/:id/technician-status", verifyTechnician, async (req, res) => {
    try {
        const technicianId = req.technicianId;
        const requestId = req.params.id;
        const { status } = req.body;

        const pool = await getPool();

        // Check assignment
        console.log(`[Tech Status Update] RequestID: ${requestId}, TechID: ${technicianId}, Status: ${status}`);
        const [requests] = await pool.query("SELECT * FROM service_requests WHERE id = ? AND technician_id = ?", [requestId, technicianId]);
        if (requests.length === 0) {
            console.error(`[Tech Status Update] Fail: Request ${requestId} not assigned to technician ${technicianId}`);
            return res.status(404).json({ error: "Request not found or not assigned to you." });
        }
        const request = requests[0];

        // Fetch user and tech info upfront
        const [users] = await pool.query("SELECT email, full_name FROM users WHERE id = ?", [request.user_id]);
        const userEmail = users[0]?.email;
        const userName = users[0]?.full_name;

        const [techs] = await pool.query("SELECT name FROM technicians WHERE id = ?", [technicianId]);
        const techName = techs[0]?.name || "Your Technician";

        const normalized = normalizeStatus(status);
        if (!normalized) {
            return res.status(400).json({ error: "Invalid status value." });
        }

        let newStatus = normalized;
        let newTechId = technicianId;
        let reassignedAmount = null;

        if (normalized === 'rejected') {
            // ... (keep reassignment logic)
            const { jobMatcher } = await import("../services/jobMatcher.js");
            const nextMatch = await jobMatcher.findBestMatch(request, [technicianId]);

            if (nextMatch) {
                newTechId = nextMatch.id;
                newStatus = 'assigned';
                reassignedAmount = await estimateRequestAmountAsync(
                    { service_type: request.service_type, vehicle_type: request.vehicle_type },
                    nextMatch
                );
                // Notify new technician
                socketService.notifyTechnician(newTechId, 'job:assigned', {
                    id: String(requestId),
                    customerName: userName || "Customer",
                    serviceType: request.service_type,
                    vehicleType: request.vehicle_type,
                    location: {
                        lat: request.location_lat,
                        lng: request.location_lng,
                        address: request.address
                    },
                    distance: nextMatch.distance || 0,
                    amount: reassignedAmount ?? request.amount ?? request.service_charge ?? 0
                });

                if (nextMatch.email) {
                    mail.sendMail({
                        to: nextMatch.email,
                        subject: "New Job Assigned (Re-assigned) - ResQNow",
                        html: `<p>A job has been re-assigned to you.</p>
                               <p>Type: ${request.service_type}</p>
                               <p>Location: ${request.address}</p>`
                    }).catch(console.error);
                }
            } else {
                newTechId = null;
                newStatus = 'pending';
            }
        }

        // If tech marks job as completed, we transition to payment_pending so user pays next
        // EXCEPTION: If it's already PAID, then we allow setting it to 'completed'
        if (normalized === 'completed' && request.status !== 'paid') {
            newStatus = 'payment_pending';
        }

        // Timestamp logic
        let timestampUpdate = "";
        if (newStatus === 'en-route' || newStatus === 'in-progress' || newStatus === 'on-the-way') {
            timestampUpdate = ", started_at = COALESCE(started_at, NOW())";
        } else if (normalized === 'completed' || newStatus === 'payment_pending' || newStatus === 'paid') {
            // mark completed_at
            timestampUpdate = ", completed_at = NOW()";
            // Release Technician (Mark Available)
            await pool.query("UPDATE technicians SET is_available = TRUE WHERE id = ?", [technicianId]);
        }

        const shouldUpdateAmount = toPositiveMoney(reassignedAmount) != null;
        const amountUpdateClause = shouldUpdateAmount ? ", amount = ?" : "";
        const updateParams = shouldUpdateAmount
            ? [newStatus, newTechId, reassignedAmount, requestId]
            : [newStatus, newTechId, requestId];

        await pool.execute(
            `UPDATE service_requests SET status = ?, technician_id = ? ${amountUpdateClause} ${timestampUpdate} WHERE id = ?`,
            updateParams
        );

        // Notify Customer via Socket
        if (request.user_id) {
            socketService.notifyUser(request.user_id, 'job:status_update', {
                requestId,
                status: newStatus,
                technicianId: newTechId,
                started_at: (newStatus === 'en-route' || newStatus === 'in-progress') ? new Date().toISOString() : undefined,
                completed_at: (normalized === 'completed' || newStatus === 'payment_pending') ? new Date().toISOString() : undefined
            });
        }

        // Email Notifications for Customer based on status transitions
        if (userEmail) {
            let emailSubject = "";
            let emailHtml = "";

            if (newStatus === 'accepted') {
                emailSubject = "Technician Accepted Your Request - ResQNow";
                emailHtml = `<p>Hello ${userName || 'there'},</p>
                             <p><b>${techName}</b> has accepted your request for ${request.service_type}.</p>
                             <p>They will begin moving towards your location shortly.</p>`;
            } else if (newStatus === 'on-the-way') {
                emailSubject = "Technician is On The Way - ResQNow";
                emailHtml = `<p><b>${techName}</b> is now on the way to your location (${request.address}).</p>
                             <p>Stay where you are, help is coming!</p>`;
            } else if (newStatus === 'arrived') {
                emailSubject = "Technician Has Arrived - ResQNow";
                emailHtml = `<p><b>${techName}</b> has arrived at your location.</p>
                             <p>Please look for them and meet at the specified address.</p>`;
            } else if (newStatus === 'payment_pending') {
                emailSubject = "Service Completed – Payment Pending - ResQNow";
                emailHtml = `<p>Your ${request.service_type} service has been completed by <b>${techName}</b>.</p>
                             <p>Please complete the payment to finalize the request. You can pay via the app.</p>`;
            }

            if (emailSubject) {
                mail.sendMail({
                    to: userEmail,
                    subject: emailSubject,
                    html: emailHtml
                }).catch(console.error);
            }
        }

        res.json({ success: true, status: newStatus });

    } catch (err) {
        console.error("[Service Requests] Tech Update status error:", err);
        res.status(500).json({ error: "Failed to update status." });
    }
});

/**
 * PATCH /api/service-requests/:id/status
 * Update request status (For User - e.g. cancel)
 */
router.patch("/:id/status", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const requestId = req.params.id;
        const { status } = req.body;

        // Check ownership
        const pool = await getPool();
        const [check] = await pool.query("SELECT id, technician_id FROM service_requests WHERE id = ? AND user_id = ?", [requestId, userId]);
        if (check.length === 0) {
            return res.status(404).json({ error: "Request not found or unauthorized." });
        }
        const reqData = check[0];

        const normalized = normalizeStatus(status);
        if (!normalized) {
            return res.status(400).json({ error: "Invalid status value." });
        }

        if (normalized === 'cancelled') {
            // Rule: Cannot cancel if technician has arrived or job is done
            if (['arrived', 'in-progress', 'payment_pending', 'completed', 'paid'].includes(reqData.status)) {
                return res.status(400).json({ error: `Cannot cancel request when status is '${reqData.status}'.` });
            }
        }

        await pool.execute(
            "UPDATE service_requests SET status = ? WHERE id = ?",
            [normalized, requestId]
        );

        // Notify Technician if assigned
        if (reqData.technician_id) {
            socketService.notifyTechnician(reqData.technician_id, 'job:status_update', {
                requestId,
                status: normalized
            });

            if (normalized === 'cancelled') {
                // Fetch tech email
                const [techs] = await pool.query("SELECT email, name FROM technicians WHERE id = ?", [reqData.technician_id]);
                if (techs[0]?.email) {
                    mail.sendMail({
                        to: techs[0].email,
                        subject: "Job Cancelled - ResQNow",
                        html: `<h3>Hello ${techs[0].name},</h3>
                               <p>The job #${requestId} has been cancelled by the customer.</p>
                               <p>You are now available for other requests.</p>`
                    }).catch(console.error);
                }
            }
        }

        res.json({ success: true, status: normalized });
    } catch (err) {
        console.error("[Service Requests] Update status error:", err);
        res.status(500).json({ error: "Failed to update status." });
    }
});


/**
 * PATCH /api/service-requests/:id/cancel
 * Cancel request (User) - explicit route per spec
 */
router.patch("/:id/cancel", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const requestId = req.params.id;
        const pool = await getPool();

        const [rows] = await pool.query("SELECT id, status, technician_id FROM service_requests WHERE id = ? AND user_id = ?", [requestId, userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Request not found or unauthorized' });

        const current = rows[0];

        // Strict Rule: Allow cancel at ANY status as long as it's not already cancelled
        if (String(current.status) === 'cancelled') {
            return res.status(400).json({ error: 'Request is already cancelled.' });
        }

        const { reason } = req.body;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            // Invalidate payment if exists? (Not explicitly asked but implies "Invalidates payment")
            // We set status to cancelled.
            // also set technician_id to NULL to free them.
            // set cancelled_at to NOW()

            await conn.execute(
                'UPDATE service_requests SET status = ?, technician_id = NULL, cancelled_at = NOW(), cancellation_reason = ? WHERE id = ?',
                ['cancelled', reason || null, requestId]
            );

            // Release Technician
            if (current.technician_id) {
                await conn.query("UPDATE technicians SET is_available = TRUE WHERE id = ?", [current.technician_id]);
            }

            await conn.commit();

            console.log('REQUEST STATUS UPDATED:', { requestId, status: 'cancelled' });

            if (current.technician_id) {
                socketService.notifyTechnician(current.technician_id, 'job:status_update', { requestId, status: 'cancelled', reason: reason || "User cancelled" });
            }
            socketService.notifyUser(userId, 'job:status_update', { requestId, status: 'cancelled' });

            const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
            return res.json({ success: true, request: updatedRows[0] });
        } catch (txErr) {
            await conn.rollback();
            console.error('Cancel transaction error:', txErr);
            return res.status(500).json({ error: 'Failed to cancel request' });
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error('[Service Requests] Cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel request' });
    }
});

/**
 * GET /api/service-requests/:id
 * Fetch single request (for tracking)
 */
router.get("/:id", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId;
        const requestId = req.params.id;
        const pool = await getPool();

        const [rows] = await pool.query(`
      SELECT 
        sr.*,
        t.name as technician_name,
        t.phone as technician_phone,
        t.rating as technician_rating,
        t.jobs_completed as technician_jobs_completed,
        t.pricing as technician_pricing,
        t.service_costs as technician_service_costs,
        t.latitude as technician_lat,
        t.longitude as technician_lng,
        u.full_name as customer_name,
        u.phone as customer_phone
      FROM service_requests sr
      LEFT JOIN technicians t ON sr.technician_id = t.id
      LEFT JOIN users u ON sr.user_id = u.id
      WHERE sr.id = ? AND sr.user_id = ?
    `, [requestId, userId]);

        if (rows.length === 0) {
            return res.status(404).json({ error: "Request not found." });
        }

        const row = rows[0];
        const pricingConfig = await getPlatformPricingConfig();
        const resolvedAmount = await resolveRequestBaseAmount(row, pricingConfig);
        const request = {
            ...row,
            technician: row.technician_id ? {
                id: row.technician_id,
                name: row.technician_name,
                phone: row.technician_phone,
                rating: Number.isFinite(Number(row.technician_rating)) ? Number(row.technician_rating) : 0,
                completedJobs: Number.isFinite(Number(row.technician_jobs_completed)) ? Number(row.technician_jobs_completed) : 0,
                location: {
                    lat: Number.isFinite(Number(row.technician_lat)) ? Number(row.technician_lat) : null,
                    lng: Number.isFinite(Number(row.technician_lng)) ? Number(row.technician_lng) : null
                }
            } : null,
            amount: resolvedAmount
        };

        res.json(request);
    } catch (err) {
        console.error("[Service Requests] Error fetching request:", err);
        res.status(500).json({ error: "Failed to fetch request." });
    }
});


/**
 * POST /api/service-requests/:id/payment-order
 * Create Razorpay order for service payment
 */
router.post("/:id/payment-order", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        const requestId = req.params.id;
        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [rows] = await pool.query("SELECT * FROM service_requests WHERE id = ?", [requestId]);

        if (rows.length === 0) return res.status(404).json({ error: "Request not found" });
        const request = rows[0];

        const serviceCharge = await resolveRequestBaseAmount(request, pricingConfig);
        const breakdown = computePaymentAmounts(serviceCharge, pricingConfig);

        console.log(
            `[Payment Order] Request: ${requestId}, ServiceCharge: ${breakdown.baseAmount}, Fee: ${breakdown.platformFee}, Total: ${breakdown.totalAmount}`
        );

        const options = {
            amount: Math.round(breakdown.totalAmount * 100),
            currency: breakdown.currency,
            receipt: `receipt_${requestId}_${Date.now()}`,
            payment_capture: 1
        };

        const order = await razorpay.orders.create(options);
        res.json({
            ...order,
            base_amount: breakdown.baseAmount,
            platform_fee: breakdown.platformFee,
            platform_fee_percent: breakdown.platformFeePercent,
            total_amount: breakdown.totalAmount
        });
    } catch (err) {
        console.error("Create payment order error:", err);
        res.status(500).json({ error: "Failed to create payment order" });
    }
});

/**
 * POST /api/service-requests/:id/verify-payment
 * Verify online payment and record commission
 */
router.post("/:id/verify-payment", verifyUser, async (req, res) => {
    try {
        if (!ensureRazorpayConfigured(res)) return;
        console.log('--------------------------------------------------');
        console.log('[VERIFY PAYMENT] Hit /verify-payment endpoint');
        console.log('[VERIFY PAYMENT] Params:', req.params);
        console.log('[VERIFY PAYMENT] Body:', JSON.stringify(req.body, null, 2));
        console.log('[VERIFY PAYMENT] User:', req.user);

        const requestId = req.params.id;
        const userId = req.user.userId;
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest("hex");

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: "Invalid signature" });
        }

        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [reqRows] = await pool.query(
            "SELECT amount, service_charge, service_type, vehicle_type, technician_id FROM service_requests WHERE id = ?",
            [requestId]
        );
        if (reqRows.length === 0) {
            return res.status(404).json({ error: "Request not found" });
        }

        const amount = await resolveRequestBaseAmount(reqRows[0], pricingConfig);
        const breakdown = computePaymentAmounts(amount, pricingConfig);
        const technicianId = reqRows[0]?.technician_id;
        const techAmount = breakdown.baseAmount;

        console.log("PAYMENT VERIFIED. Amount:", breakdown.baseAmount, " Mode: ONLINE");

        // Fetch user and tech details for invoice
        // Re-query to get user_id properly if not in reqRows (reqRows only requested amount, tech_id)
        // Also ensure we get phone number and address for invoice
        const [details] = await pool.query(
            `SELECT sr.service_type, sr.address, u.full_name as customer_name, u.email as customer_email, u.phone as customer_phone, t.name as technician_name 
             FROM service_requests sr
             LEFT JOIN users u ON sr.user_id = u.id
             LEFT JOIN technicians t ON sr.technician_id = t.id
             WHERE sr.id = ?`,
            [requestId]
        );
        const invDetails = details[0];

        // Begin transaction to safely update request, payments and create invoice
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Update Service Request to mark paid
            await conn.execute(
                "UPDATE service_requests SET payment_status = 'completed', payment_method = 'razorpay', status = 'paid', amount = ? WHERE id = ?",
                [breakdown.baseAmount, requestId]
            );
            console.log('REQUEST STATUS UPDATED:', { requestId, status: 'paid' });

            // Insert Payment Record
            await conn.execute(
                `INSERT INTO payments (user_id, service_request_id, payment_method, status, 
                  amount, platform_fee, technician_amount, is_settled,
                  razorpay_order_id, razorpay_payment_id, razorpay_signature) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, requestId, 'razorpay', 'completed', breakdown.totalAmount, breakdown.platformFee, techAmount, true, razorpay_order_id, razorpay_payment_id, razorpay_signature]
            );

            // Create Invoice
            const [invResult] = await conn.execute(
                `INSERT INTO invoices (service_request_id, user_id, technician_id, amount, platform_fee, technician_amount, gst, total_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [requestId, userId, technicianId || null, breakdown.baseAmount, breakdown.platformFee, techAmount, 0, breakdown.totalAmount]
            );

            const invoiceId = invResult.insertId;

            // Generate PDF invoice using dedicated service
            try {
                const { generateInvoicePDF } = await import('../services/invoiceService.js');

                const invoiceData = {
                    invoiceId: invoiceId,
                    requestId: requestId,
                    customerName: invDetails.customer_name,
                    customerPhone: invDetails.customer_phone,
                    customerAddress: invDetails.address, // Correctly fetched from invDetails
                    serviceType: invDetails.service_type,
                    vehicleType: invDetails.vehicle_type, // Fetch if needed
                    amount: breakdown.baseAmount,
                    platformFee: breakdown.platformFee,
                    totalAmount: breakdown.totalAmount,
                    paymentMethod: 'Razorpay',
                    transactionId: razorpay_payment_id
                };

                const pdfPath = await generateInvoicePDF(invoiceData);

                // Update invoice record with pdf path
                await conn.execute("UPDATE invoices SET pdf_path = ? WHERE id = ?", [pdfPath, invoiceId]);

                // Email the Invoice
                if (invDetails.customer_email) {
                    console.log(`Sending invoice email to: ${invDetails.customer_email}`);
                    const fs = await import('fs');
                    const pdfBuffer = fs.readFileSync(pdfPath);

                    try {
                        const { sendInvoiceEmail } = await import('../services/mailer.js');
                        await sendInvoiceEmail(invDetails.customer_email, invoiceData, pdfBuffer);
                        console.log('Invoice email sent successfully');
                    } catch (e) {
                        console.error('Failed to send invoice email:', e);
                    }
                } else {
                    console.warn(`No customer email found for request ${requestId}, skipping invoice email.`);
                }

                // Update technician stats (jobs completed and earnings)
                if (technicianId) {
                    await conn.execute(
                        "UPDATE technicians SET jobs_completed = jobs_completed + 1, total_earnings = total_earnings + ? WHERE id = ?",
                        [techAmount, technicianId]
                    );

                    // Fetch updated stats for real-time dashboard update
                    const [statsRows] = await conn.query(
                        "SELECT total_earnings, jobs_completed FROM technicians WHERE id = ?",
                        [technicianId]
                    );

                    const [todayRows] = await conn.query(
                        "SELECT SUM(amount) as total FROM service_requests WHERE technician_id = ? AND status IN ('completed', 'paid') AND DATE(created_at) = CURDATE()",
                        [technicianId]
                    );

                    const updatedStats = {
                        totalEarnings: statsRows[0]?.total_earnings || 0,
                        completedJobs: statsRows[0]?.jobs_completed || 0,
                        todayEarnings: todayRows[0]?.total || 0,
                        newJobAmount: techAmount
                    };

                    socketService.notifyTechnician(technicianId, 'dashboard:stats_update', updatedStats);
                }

                const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
                res.json({ success: true, request: updatedRows[0] });

            } catch (genErr) {
                await conn.rollback();
                console.error('Failed to generate invoice PDF or send email:', genErr);
                // We still fail the request? Or succeed with warning? 
                // Better to fail so user/admin knows invoice didn't generate.
                return res.status(500).json({ error: 'Payment processed but invoice generation failed' });
            }

        } catch (txErr) {
            await conn.rollback();
            console.error('Verify payment transaction error:', txErr);
            // Log full error details
            if (txErr.sqlMessage) console.error("SQL Error:", txErr.sqlMessage);
            return res.status(500).json({ error: 'Payment verification failed: ' + (txErr.message || 'Transaction error') });
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error("Critical Payment Error:", err);
        res.status(500).json({ error: 'Internal server error during payment verification.' });
    }
});


/**
 * POST /api/service-requests/:id/payment-cash
 * Handle cash payment selection
 */
router.post("/:id/payment-cash", verifyUser, async (req, res) => {
    try {
        const requestId = req.params.id;
        const userId = req.user.userId;
        const pool = await getPool();
        const pricingConfig = await getPlatformPricingConfig();
        const [reqRows] = await pool.query(
            "SELECT amount, service_charge, service_type, vehicle_type, technician_id FROM service_requests WHERE id = ?",
            [requestId]
        );
        if (reqRows.length === 0) {
            return res.status(404).json({ error: "Request not found" });
        }

        const amount = await resolveRequestBaseAmount(reqRows[0], pricingConfig);
        const breakdown = computePaymentAmounts(amount, pricingConfig);
        const technicianId = reqRows[0]?.technician_id;

        console.log(
            `[Cash Payment] Request: ${requestId}, Amount: ${breakdown.baseAmount}, TechId: ${technicianId}, PlatformFee: ${breakdown.platformFee}`
        );
        console.log("PAYMENT MODE: CASH");

        // Fetch details for invoice
        const [details] = await pool.query(
            `SELECT sr.service_type, u.full_name as customer_name, u.email as customer_email, t.name as technician_name 
             FROM service_requests sr
             LEFT JOIN users u ON sr.user_id = u.id
             LEFT JOIN technicians t ON sr.technician_id = t.id
             WHERE sr.id = ?`,
            [requestId]
        );
        const invDetails = details[0];

        const conn = await pool.getConnection();

        try {
            await conn.beginTransaction();

            // 1. Update Request
            await conn.execute(
                "UPDATE service_requests SET payment_status = 'completed', payment_method = 'cash', status = 'paid', amount = ? WHERE id = ?",
                [breakdown.baseAmount, requestId]
            );

            // 2. Insert Payment Record (Cash)
            await conn.execute(
                `INSERT INTO payments (user_id, service_request_id, payment_method, status, amount, platform_fee, is_settled) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, requestId, 'cash', 'completed', breakdown.totalAmount, breakdown.platformFee, false]
            );

            // 3. Insert Technician Due (CRITICAL REQUIREMENT)
            if (technicianId && breakdown.platformFee > 0) {
                await conn.execute(
                    `INSERT INTO technician_dues (technician_id, service_request_id, amount, status)
                      VALUES (?, ?, ?, 'pending')`,
                    [technicianId, requestId, breakdown.platformFee]
                );
                console.log(`Created Technician Due: Tech ${technicianId}, Request ${requestId}, Amount ${breakdown.platformFee}`);
            }

            // 4. Create Invoice
            const [invResult] = await conn.execute(
                `INSERT INTO invoices (service_request_id, user_id, technician_id, amount, platform_fee, technician_amount, gst, total_amount)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [requestId, userId, technicianId || null, breakdown.baseAmount, breakdown.platformFee, breakdown.baseAmount, 0, breakdown.totalAmount]
            );
            const invoiceId = invResult.insertId;

            // Generate and save PDF invoice
            try {
                const fs = await import('fs');
                const path = await import('path');
                const PDFDocument = (await import('pdfkit')).default;
                const uploadsDir = path.resolve(process.cwd(), 'server', 'uploads', 'invoices');
                fs.mkdirSync(uploadsDir, { recursive: true });

                const pdfPath = path.join(uploadsDir, `invoice_${invoiceId}.pdf`);
                const doc = new PDFDocument({ size: 'A4' });
                const stream = fs.createWriteStream(pdfPath);
                doc.pipe(stream);

                doc.fontSize(18).text('ResQNow Invoice (Cash Payment)', { align: 'center' });
                doc.moveDown();
                doc.fontSize(12).text(`Invoice ID: ${invoiceId}`);
                doc.text(`Request ID: ${requestId}`);
                doc.text(`Customer: ${invDetails.customer_name || 'Customer'}`);
                doc.text(`Technician: ${invDetails.technician_name || 'Technician'}`);
                doc.moveDown();
                doc.text(`Service Amount: INR ${breakdown.baseAmount.toFixed(2)}`);
                doc.text(`Platform Fee: INR ${breakdown.platformFee.toFixed(2)}`);
                doc.text(`Technician Amount: INR ${breakdown.baseAmount.toFixed(2)}`); // Tech keeps full amount, owes platform fee
                doc.moveDown();
                doc.fontSize(14).text(`Total: INR ${breakdown.totalAmount.toFixed(2)}`, { underline: true });

                doc.end();

                await new Promise((resolve, reject) => {
                    stream.on('finish', resolve);
                    stream.on('error', reject);
                });

                await conn.execute("UPDATE invoices SET pdf_path = ? WHERE id = ?", [pdfPath, invoiceId]);

                // Update tech stats (earnings = full amount in cash, but they owe fee)
                if (technicianId) {
                    await conn.execute(
                        "UPDATE technicians SET jobs_completed = jobs_completed + 1, total_earnings = total_earnings + ? WHERE id = ?",
                        [breakdown.baseAmount, technicianId]
                    );
                }

                await conn.commit();
                console.log('Cash payment transaction committed.');

                // Notify parties
                if (technicianId) {
                    socketService.notifyTechnician(technicianId, 'job:status_update', { requestId, status: 'paid' });
                }
                socketService.notifyUser(userId, 'payment_completed', { requestId, status: 'paid' });
                // Also emit a job:status_update so existing tracking listeners react
                socketService.notifyUser(userId, 'job:status_update', { requestId, status: 'paid' });

                // Send invoice email if we have customer email
                if (invDetails?.customer_email) {
                    try {
                        const pdfBuffer = await fs.promises.readFile(pdfPath);
                        mail.sendInvoiceEmail(invDetails.customer_email, {
                            requestId,
                            customerName: invDetails.customer_name || 'Customer',
                            serviceType: invDetails.service_type,
                            technicianName: invDetails.technician_name || 'Technician',
                            amount: breakdown.baseAmount,
                            gst: 0,
                            totalAmount: breakdown.totalAmount,
                            paymentMethod: 'cash',
                            transactionId: `CASH_${Date.now()}`
                        }, pdfBuffer).catch(console.error);
                    } catch (pdfErr) {
                        console.error('Failed to read/send PDF invoice:', pdfErr);
                    }
                }

                const [updatedRows] = await pool.query('SELECT * FROM service_requests WHERE id = ?', [requestId]);
                res.json({ success: true, request: updatedRows[0] });

            } catch (genErr) {
                await conn.rollback();
                console.error('Failed to generate invoice PDF or finalize cash payment:', genErr);
                return res.status(500).json({ error: 'Cash payment processed but invoice generation failed' });
            }

        } catch (txErr) {
            await conn.rollback();
            console.error('Cash payment transaction error:', txErr);
            return res.status(500).json({ error: 'Failed to process cash payment' });
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error("Cash payment error:", error);
        res.status(500).json({ error: error.message });
    }
});


/**
 * GET /api/service-requests/:id/invoice
 * Fetch invoice metadata for a request (user or admin)
 */
router.get("/:id/invoice", verifyUser, async (req, res) => {
    try {
        const requestId = req.params.id;
        const userId = req.user.userId;
        const pool = await getPool();

        const [rows] = await pool.query("SELECT * FROM invoices WHERE service_request_id = ? AND user_id = ? LIMIT 1", [requestId, userId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

        const inv = rows[0];
        const pdfRelative = inv.pdf_path ? inv.pdf_path.split(path.sep).join('/').split('/server/uploads/').pop() : null;
        res.json({
            id: inv.id,
            service_request_id: inv.service_request_id,
            amount: parseFloat(inv.amount || 0),
            platform_fee: parseFloat(inv.platform_fee || 0),
            technician_amount: parseFloat(inv.technician_amount || 0),
            gst: parseFloat(inv.gst || 0),
            total_amount: parseFloat(inv.total_amount || 0),
            pdf_path: inv.pdf_path || null,
            pdf_url: pdfRelative ? `/uploads/${pdfRelative}` : null,
            created_at: inv.created_at
        });
    } catch (err) {
        console.error('[Invoices] Error fetching invoice:', err);
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});

export default router;
