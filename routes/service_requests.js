
import express from "express";
import { getPool } from "../db.js";
import crypto from 'crypto';
import { verifyUser, verifyTechnician } from "../middleware/auth.js";
import { socketService } from "../services/socket.js";
import * as mail from "../services/mailer.js";
import Razorpay from "razorpay";
import { generateInvoicePDF } from "../services/invoiceService.js";
import {
    canonicalizeServiceDomain,
    canonicalizeVehicleFamily,
    parseVehicleTypes,
    serviceDomainsFromCosts
} from "../services/serviceNormalization.js";
import { estimateRequestAmount, estimateRequestAmountAsync, estimateTechnicianPayoutAsync } from "../services/pricingEstimator.js";
import { computePaymentAmounts, getPlatformPricingConfig } from "../services/platformPricing.js";
import { buildMarketplacePricingSnapshot } from "../services/marketplacePaymentService.js";
import {
    PAYMENT_LEDGER_STATUS,
    PAYMENT_TO_TECHNICIAN_STATUS,
} from "../models/marketplaceConstants.js";
import { enqueueDispatchJob } from "../services/dispatchQueueService.js";
import {
    isActiveJobStatus,
    isTerminalJobStatus,
    markTechnicianReserved,
    releaseTechnicianAvailability
} from "../services/technicianStateService.js";

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

function sendDeprecatedServiceRequestPaymentRoute(res, replacementPath, details) {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Wed, 31 Dec 2026 23:59:59 GMT");
    return res.status(410).json({
        error: "This legacy service-request payment endpoint has been deprecated. Use the canonical /api/payments/* endpoints instead.",
        deprecated: true,
        replacement: replacementPath,
        details,
    });
}

// Allowed statuses and a small normalization helper to accept variants used in the UI
const VALID_STATUSES = new Set([
    'pending',
    'assigned',
    'accepted',
    'processing',
    'service_started',
    'on-the-way',
    'en-route',
    'arrived',
    'in_progress',
    'in-progress',
    'awaiting_payment',
    'payment_pending',
    'completed',
    'cancelled',
    'rejected',
    'paid'
]);

function normalizeStatus(status) {
    if (!status && status !== 0) return null;
    const s = String(status).trim().toLowerCase();
    const map = {
        'service started': 'service_started',
        'service_started': 'service_started',
        'service-started': 'service_started',
        'on_the_way': 'on-the-way',
        'on the way': 'on-the-way',
        'on-the-way': 'on-the-way',
        'in_progress': 'in-progress',
        'in progress': 'in-progress',
        'in-progress': 'in-progress',
        'processing': 'processing',
        'en_route': 'en-route',
        'en-route': 'en-route',
        'payment_pending': 'payment_pending',
        'payment-pending': 'payment_pending',
        'awaiting_payment': 'awaiting_payment',
        'awaiting-payment': 'awaiting_payment',
        'awaiting payment': 'awaiting_payment'
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
            _id: String(row.id),
            id: row.id,
            service_type: row.service_type,
            vehicle_type: row.vehicle_type,
            vehicle_model: row.vehicle_model,
            address: row.address,
            status: row.status,
            serviceStatus: row.status,
            payment_status: row.payment_status,
            paymentStatus: ["completed", "paid"].includes(String(row.payment_status || "").toLowerCase()) ? "paid" : (row.payment_status || null),
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
        let directDistanceKm = null;

        if (hasDirectTechnician) {
            if (!Number.isFinite(directTechnicianId)) {
                return res.status(400).json({ error: "Invalid technician_id." });
            }

            const [techRows] = await pool.query(
                "SELECT id, status, is_active, is_available, current_job_id, latitude, longitude, service_area_range, service_type, specialties, pricing, service_costs, vehicle_types FROM technicians WHERE id = ? LIMIT 1",
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
            if (tech.current_job_id != null) {
                return res.status(400).json({ error: "Selected technician is currently on another active job." });
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
                directDistanceKm = dist;
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
      (user_id, service_type, vehicle_type, vehicle_model, address, contact_name, contact_email, contact_phone, description, location_lat, location_lng, customer_location_lat, customer_location_lng, technician_id, status, amount) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
                location_lat || null,
                location_lng || null,
                directTechnicianId,
                initialStatus,
                initialAmount
            ]
        );

        const newRequestId = result.insertId;
        console.log(`[Create Job] Created Request #${newRequestId}`);

        if (hasDirectTechnician && directTechnicianId) {
            await markTechnicianReserved(pool, directTechnicianId, newRequestId);
            console.log(`[Create Job] Reserved technician ${directTechnicianId} for direct request #${newRequestId}.`);
        }

        // 3. Trigger Direct Notify or queue-driven dispatch (async)
        (async () => {
            const runDirectFallbackDispatch = async (fallbackReason) => {
                console.warn(
                    `[Dispatch Trace] requestId=${newRequestId} fallback=direct reason=${fallbackReason}`
                );
                const { jobDispatchService } = await import("../services/jobDispatchService.js");
                const fallbackJobRequest = {
                    id: newRequestId,
                    location_lat,
                    location_lng,
                    service_type: canonicalServiceType,
                    vehicle_type: inferredVehicle,
                    address,
                    amount: initialAmount,
                    contact_name: req.body.contact_name || null
                };

                const candidates = await jobDispatchService.findTopTechnicians(fallbackJobRequest);
                console.log(
                    `[Dispatch Trace] requestId=${newRequestId} technicians_found=${candidates.length}`
                );

                if (candidates.length > 0) {
                    await jobDispatchService.dispatchJob(fallbackJobRequest, candidates);
                    console.log(
                        `[Dispatch Trace] requestId=${newRequestId} alerts_sent=${candidates.length} source=fallback`
                    );
                    return;
                }

                console.warn(`[Dispatch Trace] requestId=${newRequestId} no_matching_technicians`);
            };

            try {
                if (hasDirectTechnician && directTechnicianId) {
                    const directAssignedPayload = {
                        id: String(newRequestId),
                        jobId: String(newRequestId),
                        requestId: String(newRequestId),
                        customerName: req.body.contact_name || "Customer",
                        serviceType: canonicalServiceType,
                        locationDistance: Number.isFinite(directDistanceKm) ? `${directDistanceKm.toFixed(1)} km` : "Nearby",
                        vehicleType: inferredVehicle,
                        location: {
                            lat: location_lat,
                            lng: location_lng,
                            address
                        },
                        address,
                        amount: initialAmount || 0,
                        priceAmount: initialAmount || 0
                    };
                    if (socketService.io) {
                        socketService.io.to(`technician_${directTechnicianId}`).emit("JOB_ALERT", directAssignedPayload);
                    }
                    socketService.notifyTechnician(directTechnicianId, "job:assigned", directAssignedPayload);
                    socketService.notifyTechnician(directTechnicianId, "job:list_update", {
                        requestId: String(newRequestId),
                        action: "created"
                    });
                    return;
                }

                console.log(`[Dispatch Trace] requestId=${newRequestId} action=enqueue_attempt`);
                const queued = await enqueueDispatchJob({
                    jobId: newRequestId,
                    userId,
                    retryCount: 0,
                    attemptedTechnicianIds: [],
                    source: "service_request_create",
                });

                if (queued?.queued) {
                    console.log(
                        `[Dispatch Trace] requestId=${newRequestId} action=enqueued queueJobId=${queued.id || "n/a"}`
                    );
                    return;
                }

                await runDirectFallbackDispatch(queued?.reason || "queue_unavailable");
            } catch (dispatchErr) {
                console.error(`[Dispatch Error] requestId=${newRequestId}`, dispatchErr);
                try {
                    await runDirectFallbackDispatch("dispatch_exception");
                } catch (fallbackErr) {
                    console.error(
                        `[Dispatch Error] requestId=${newRequestId} fallback_failed`,
                        fallbackErr
                    );
                }
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
                : "Request created. Dispatch queued for nearby technicians...",
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
            if (result.code === "not_found") {
                return res.status(404).json({ error: result.reason || "Job not found." });
            }
            if (result.code === "technician_not_found") {
                return res.status(404).json({ error: result.reason || "Technician not found." });
            }
            return res.status(409).json({ error: result.reason || "Job already taken." });
        }

        res.json({
            success: true,
            idempotent: !!result.idempotent,
            request: result.job,
            job: result.job
        });

    } catch (err) {
        console.error("[Accept Job] Error:", err);
        res.status(500).json({ error: "Failed to accept job." });
    }
});

/**
 * GET /api/service-requests/:id/technician-offer
 * Resolve the latest offer snapshot for a technician deep link alert.
 */
router.get("/:id/technician-offer", verifyTechnician, async (req, res) => {
    try {
        const technicianId = req.technicianId;
        const requestId = req.params.id;
        const pool = await getPool();

        const [rows] = await pool.query(
            `SELECT
                sr.id,
                sr.service_type,
                sr.vehicle_type,
                sr.address,
                sr.contact_name,
                sr.location_lat,
                sr.location_lng,
                sr.status,
                sr.technician_id,
                COALESCE(sr.amount, sr.service_charge, 0) AS amount,
                d.status AS offer_status,
                t.latitude AS technician_lat,
                t.longitude AS technician_lng,
                t.pricing AS technician_pricing,
                t.service_costs AS technician_service_costs
            FROM service_requests sr
            LEFT JOIN dispatch_offers d
                ON d.service_request_id = sr.id
                AND d.technician_id = ?
            LEFT JOIN technicians t
                ON t.id = ?
            WHERE sr.id = ?
            LIMIT 1`,
            [technicianId, technicianId, requestId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Service request not found.", available: false });
        }

        const row = rows[0];
        const estimatedAmount = await estimateTechnicianPayoutAsync(
            { service_type: row.service_type, vehicle_type: row.vehicle_type },
            {
                id: technicianId,
                pricing: row.technician_pricing,
                service_costs: row.technician_service_costs
            },
            { technicianId }
        );
        const resolvedOfferAmount = toPositiveMoney(estimatedAmount) ?? 0;
        const normalizedStatus = normalizeStatus(row?.status) || String(row?.status || "").trim().toLowerCase();
        const offerStatus = String(row?.offer_status || "").trim().toLowerCase();
        const assignedTechnicianId = row?.technician_id == null ? null : String(row.technician_id);
        const isAssignedToCurrentTechnician = assignedTechnicianId === String(technicianId);
        const hasPendingOffer = offerStatus === "pending";
        const terminalStatuses = new Set(["cancelled", "completed", "rejected"]);

        if (terminalStatuses.has(normalizedStatus)) {
            return res.status(409).json({
                available: false,
                reason: "closed",
                message: `Job is already ${normalizedStatus}.`,
            });
        }

        if (assignedTechnicianId && !isAssignedToCurrentTechnician) {
            return res.status(409).json({
                available: false,
                reason: "taken",
                message: "This job has already been taken by another technician.",
            });
        }

        if (!isAssignedToCurrentTechnician && !hasPendingOffer) {
            return res.status(409).json({
                available: false,
                reason: "unavailable",
                message: "This job offer is no longer available.",
            });
        }

        const customerLat = Number(row.location_lat);
        const customerLng = Number(row.location_lng);
        const technicianLat = Number(row.technician_lat);
        const technicianLng = Number(row.technician_lng);
        const distanceKm =
            Number.isFinite(customerLat) &&
                Number.isFinite(customerLng) &&
                Number.isFinite(technicianLat) &&
                Number.isFinite(technicianLng)
                ? Number(getDistanceFromLatLonInKm(technicianLat, technicianLng, customerLat, customerLng).toFixed(1))
                : null;

        return res.json({
            available: true,
            request: {
                id: String(row.id),
                requestId: String(row.id),
                serviceType: row.service_type,
                service_type: row.service_type,
                vehicleType: row.vehicle_type,
                vehicle_type: row.vehicle_type,
                customerName: row.contact_name || "Customer",
                address: row.address || "",
                status: normalizedStatus,
                offer_status: offerStatus || null,
                location: {
                    lat: Number.isFinite(customerLat) ? customerLat : null,
                    lng: Number.isFinite(customerLng) ? customerLng : null,
                    address: row.address || "",
                },
                location_lat: Number.isFinite(customerLat) ? customerLat : null,
                location_lng: Number.isFinite(customerLng) ? customerLng : null,
                distance: distanceKm,
                locationDistance: distanceKm != null ? `${distanceKm.toFixed(1)} km` : "Nearby",
                amount: resolvedOfferAmount,
                priceAmount: resolvedOfferAmount,
            },
        });
    } catch (err) {
        console.error("[Technician Offer] Error fetching offer snapshot:", err);
        return res.status(500).json({ error: "Failed to resolve technician offer.", available: false });
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
        const normalized = normalizeStatus(status);
        if (!normalized) {
            return res.status(400).json({ error: "Invalid status value." });
        }

        // Route accepted updates through atomic accept logic so competing technicians
        // cannot both claim the same request.
        if (normalized === "accepted") {
            const { jobDispatchService } = await import("../services/jobDispatchService.js");
            const acceptResult = await jobDispatchService.acceptJob(technicianId, requestId);
            if (!acceptResult.success) {
                if (acceptResult.code === "not_found" || acceptResult.code === "technician_not_found") {
                    return res.status(404).json({ error: acceptResult.reason || "Request not found." });
                }
                return res.status(409).json({ error: acceptResult.reason || "Job already accepted by another technician." });
            }
            return res.json({
                success: true,
                status: "accepted",
                request: acceptResult.job,
                idempotent: !!acceptResult.idempotent,
            });
        }

        // Check assignment
        console.log(`[Tech Status Update] RequestID: ${requestId}, TechID: ${technicianId}, Status: ${status}`);
        const [requests] = await pool.query("SELECT * FROM service_requests WHERE id = ? AND technician_id = ?", [requestId, technicianId]);
        if (requests.length === 0) {
            console.error(`[Tech Status Update] Fail: Request ${requestId} not assigned to technician ${technicianId}`);
            return res.status(404).json({ error: "Request not found or not assigned to you." });
        }
        const request = requests[0];
        const currentRequestStatus = normalizeStatus(request.status);
        const rejectableOfferStatuses = new Set(["pending", "assigned", "technician_assigned"]);
        if (normalized === "rejected" && !rejectableOfferStatuses.has(currentRequestStatus)) {
            return res.status(409).json({
                error: `Cannot reject request when status is '${request.status || currentRequestStatus || "unknown"}'.`
            });
        }

        // Fetch user and tech info upfront
        const [users] = await pool.query("SELECT email, full_name FROM users WHERE id = ?", [request.user_id]);
        const userEmail = users[0]?.email;
        const userName = users[0]?.full_name;

        const [techs] = await pool.query("SELECT name FROM technicians WHERE id = ?", [technicianId]);
        const techName = techs[0]?.name || "Your Technician";

        let newStatus = normalized;
        let newTechId = technicianId;
        let reassignedAmount = null;

        if (normalized === 'rejected') {
            await releaseTechnicianAvailability(pool, technicianId, requestId);
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
                await markTechnicianReserved(pool, newTechId, requestId);
                await pool.query(
                    "UPDATE dispatch_offers SET status = 'rejected' WHERE service_request_id = ? AND technician_id = ?",
                    [requestId, technicianId]
                );
                const [existingNextOffer] = await pool.query(
                    "SELECT id FROM dispatch_offers WHERE service_request_id = ? AND technician_id = ? LIMIT 1",
                    [requestId, newTechId]
                );
                if (existingNextOffer.length > 0) {
                    await pool.query(
                        "UPDATE dispatch_offers SET status = 'accepted' WHERE id = ?",
                        [existingNextOffer[0].id]
                    );
                } else {
                    await pool.query(
                        "INSERT INTO dispatch_offers (service_request_id, technician_id, status) VALUES (?, ?, 'accepted')",
                        [requestId, newTechId]
                    );
                }
                // Notify new technician
                const reassignedPayload = {
                    id: String(requestId),
                    jobId: String(requestId),
                    requestId: String(requestId),
                    customerName: userName || "Customer",
                    serviceType: request.service_type,
                    vehicleType: request.vehicle_type,
                    location: {
                        lat: request.location_lat,
                        lng: request.location_lng,
                        address: request.address
                    },
                    locationDistance: Number.isFinite(Number(nextMatch.distance))
                        ? `${Number(nextMatch.distance).toFixed(1)} km`
                        : (nextMatch.distanceText || "Nearby"),
                    distance: Number(nextMatch.distance) || 0,
                    amount: reassignedAmount ?? request.amount ?? request.service_charge ?? 0,
                    priceAmount: reassignedAmount ?? request.amount ?? request.service_charge ?? 0
                };
                if (socketService.io) {
                    socketService.io.to(`technician_${newTechId}`).emit("JOB_ALERT", reassignedPayload);
                }
                socketService.notifyTechnician(newTechId, 'job:assigned', reassignedPayload);
                socketService.notifyTechnician(newTechId, "job:list_update", {
                    requestId: String(requestId),
                    action: "updated"
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
                await pool.query(
                    "UPDATE dispatch_offers SET status = 'rejected' WHERE service_request_id = ? AND technician_id = ?",
                    [requestId, technicianId]
                );
            }
        }

        // If tech marks work done, move to awaiting_payment until user payment is finished.
        if (normalized === 'completed' && !['paid', 'completed'].includes(String(request.status || '').toLowerCase())) {
            newStatus = 'awaiting_payment';
        }

        // Timestamp logic
        let timestampUpdate = "";
        if (newStatus === 'accepted') {
            timestampUpdate = ", accepted_time = COALESCE(accepted_time, NOW())";
        } else if (
            newStatus === 'service_started' ||
            newStatus === 'en-route' ||
            newStatus === 'in-progress' ||
            newStatus === 'in_progress' ||
            newStatus === 'on-the-way'
        ) {
            timestampUpdate = ", started_at = COALESCE(started_at, NOW()), start_time = COALESCE(start_time, NOW())";
        } else if (normalized === 'completed' || newStatus === 'awaiting_payment' || newStatus === 'payment_pending' || newStatus === 'paid' || newStatus === 'completed') {
            // mark completed_at
            timestampUpdate = ", completed_at = NOW()";
            if (newStatus === 'paid' || newStatus === 'completed') {
                await releaseTechnicianAvailability(pool, technicianId, requestId);
            }
        }

        const shouldUpdateAmount = toPositiveMoney(reassignedAmount) != null;
        const amountUpdateClause = shouldUpdateAmount ? ", amount = ?" : "";
        const updateParams = shouldUpdateAmount
            ? [newStatus, newTechId, reassignedAmount, requestId]
            : [newStatus, newTechId, requestId];

        await pool.execute(
            `UPDATE service_requests SET status = ?, technician_id = ? ${amountUpdateClause} ${timestampUpdate}, updated_at = NOW() WHERE id = ?`,
            updateParams
        );

        if (newTechId && isActiveJobStatus(newStatus)) {
            await markTechnicianReserved(pool, newTechId, requestId);
        } else if (!isActiveJobStatus(newStatus) && isTerminalJobStatus(newStatus)) {
            await releaseTechnicianAvailability(pool, technicianId, requestId);
        }

        // Notify Customer via Socket
        if (request.user_id) {
            socketService.notifyUser(request.user_id, 'job:status_update', {
                requestId,
                status: newStatus,
                technicianId: newTechId,
                started_at: (
                    newStatus === 'service_started' ||
                    newStatus === 'en-route' ||
                    newStatus === 'in-progress' ||
                    newStatus === 'in_progress'
                ) ? new Date().toISOString() : undefined,
                completed_at: (normalized === 'completed' || newStatus === 'awaiting_payment' || newStatus === 'payment_pending') ? new Date().toISOString() : undefined
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
            } else if (newStatus === 'awaiting_payment' || newStatus === 'payment_pending') {
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
        const [check] = await pool.query("SELECT id, status, technician_id FROM service_requests WHERE id = ? AND user_id = ?", [requestId, userId]);
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
            if (['arrived', 'service_started', 'in-progress', 'in_progress', 'awaiting_payment', 'payment_pending', 'completed', 'paid'].includes(String(reqData.status || '').toLowerCase())) {
                return res.status(400).json({ error: `Cannot cancel request when status is '${reqData.status}'.` });
            }
        }

        await pool.execute(
            "UPDATE service_requests SET status = ?, updated_at = NOW() WHERE id = ?",
            [normalized, requestId]
        );

        if (reqData.technician_id && (normalized === 'cancelled' || isTerminalJobStatus(normalized))) {
            await releaseTechnicianAvailability(pool, reqData.technician_id, requestId);
        }

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
                await releaseTechnicianAvailability(conn, current.technician_id, requestId);
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
            _id: String(row.id),
            serviceStatus: row.status,
            paymentStatus: ["completed", "paid"].includes(String(row.payment_status || "").toLowerCase()) ? "paid" : (row.payment_status || null),
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
    return sendDeprecatedServiceRequestPaymentRoute(
        res,
        "/api/payments/create-order",
        `Call POST /api/payments/create-order with { requestId: ${req.params.id} }.`
    );
});

/**
 * POST /api/service-requests/:id/verify-payment
 * Verify online payment and record commission
 */
router.post("/:id/verify-payment", verifyUser, async (req, res) => {
    return sendDeprecatedServiceRequestPaymentRoute(
        res,
        "/api/payments/confirm",
        `Call POST /api/payments/confirm with { requestId: ${req.params.id}, razorpay_order_id, razorpay_payment_id, razorpay_signature }.`
    );
});


/**
 * POST /api/service-requests/:id/payment-cash
 * Handle cash payment selection
 */
router.post("/:id/payment-cash", verifyUser, async (req, res) => {
    return sendDeprecatedServiceRequestPaymentRoute(
        res,
        "/api/payments/cash",
        `Call POST /api/payments/cash with { requestId: ${req.params.id}, couponCode? }.`
    );
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

        const [rows] = await pool.query(
            `SELECT
                id, service_request_id, user_id, order_id, razorpay_payment_id,
                amount, platform_fee, technician_amount, gst, total_amount, status,
                (invoice_pdf IS NOT NULL) AS has_invoice_pdf,
                created_at
             FROM invoices
             WHERE service_request_id = ? AND user_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [requestId, userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

        const inv = rows[0];
        res.json({
            id: inv.id,
            service_request_id: inv.service_request_id,
            order_id: inv.order_id || null,
            razorpay_payment_id: inv.razorpay_payment_id || null,
            amount: parseFloat(inv.amount || 0),
            platform_fee: parseFloat(inv.platform_fee || 0),
            technician_amount: parseFloat(inv.technician_amount || 0),
            gst: parseFloat(inv.gst || 0),
            total_amount: parseFloat(inv.total_amount || 0),
            status: inv.status || "GENERATED",
            pdf_available: !!inv.has_invoice_pdf,
            pdf_url: inv.has_invoice_pdf ? `/api/service-requests/${requestId}/invoice/pdf` : null,
            created_at: inv.created_at
        });
    } catch (err) {
        console.error('[Invoices] Error fetching invoice:', err);
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});

router.get("/:id/invoice/pdf", verifyUser, async (req, res) => {
    try {
        const requestId = req.params.id;
        const userId = req.user.userId;
        const pool = await getPool();

        const [rows] = await pool.query(
            `SELECT id, order_id, invoice_pdf
             FROM invoices
             WHERE service_request_id = ? AND user_id = ?
             ORDER BY created_at DESC
             LIMIT 1`,
            [requestId, userId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: "Invoice not found" });
        }

        const invoice = rows[0];
        if (!invoice.invoice_pdf) {
            return res.status(404).json({ error: "Invoice PDF not available" });
        }

        const fileName = `invoice_${invoice.order_id || requestId}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename=\"${fileName}\"`);
        return res.send(invoice.invoice_pdf);
    } catch (err) {
        console.error("[Invoices] Error fetching invoice PDF:", err);
        return res.status(500).json({ error: "Failed to fetch invoice PDF" });
    }
});

export default router;
