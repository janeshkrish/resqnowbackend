import { recordId, isRecordId } from "../models/identifiers.js";
import * as db from "../db.js";
import { socketService } from "./socket.js";
import {
    canonicalizeServiceDomain,
    canonicalizeVehicleFamily,
    normalizeText,
    parseVehicleTypes,
    serviceDomainsFromCosts,
} from "./serviceNormalization.js";
import { markTechnicianReserved, JobOwnershipError, isActiveJobStatus } from "./technicianStateService.js";
import { estimateTechnicianEarningForRequest } from "./technicianEarningsService.js";
import { getRoute } from "./routeService.js";
import { recordAcceptedEvent } from "./requestEvents.js";
import { isTowingServiceType } from "./towingServiceType.js";
import { buildTechnicianJobDetails } from "./technicianJobDetails.js";
import { requiredTowTruckType, evaluateTowTruckCapability, loadTechnicianFleetVehicles } from "./towTruckCapability.js";
import { createPricedDispatchOffer, dispatchOfferPricingFields } from "./dispatchOfferService.js";
import { buildDispatchPricingSnapshot, readDispatchPricingSnapshot, customerPricingView } from "./dispatchPricingService.js";
import { getVehicleServicePolicy, evaluateVehicleServiceSupport, loadChargingServiceProfiles } from "./vehicleServiceCompatibility.js";


/**
 * Job Dispatch Service
 * Handles finding nearest technicians, calculating ETAs via the shared route service,
 * and managing dispatch offers.
 */


// Helper: safe JSON parse
const safeParse = (str) => {
    try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return []; }
};

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

const buildTowingDispatchFields = (row = {}) => {
    if (!isTowingServiceType(row?.service_type)) return {};

    const dropAddress = row.dropAddress || row.drop_address || row?.dropLocation?.address || "";
    const dropLat = Number(row.drop_latitude ?? row.dropLat ?? row?.dropLocation?.lat);
    const dropLng = Number(row.drop_longitude ?? row.dropLng ?? row?.dropLocation?.lng);
    const distance = row.routeDistanceKm ?? row.route_distance_km;
    const duration = row.estimatedDuration ?? row.estimated_duration;
    const pricingBreakdown =
        row.pricingBreakdown ||
        safeParseObject(row.pricing_breakdown_json) ||
        safeParseObject(row.pricing_breakdown);
    const routeMetadata =
        row.routeMetadata ||
        safeParseObject(row.route_metadata_json) ||
        safeParseObject(row.route_metadata);
    const technicianEarning = toPositiveMoney(
        row.technicianEstimatedEarning ?? row.technician_estimated_earning ?? row.estimatedEarnings
    );

    if (!dropAddress && distance == null && !pricingBreakdown) return {};

    return {
        dropLocation: {
            lat: Number.isFinite(dropLat) ? dropLat : null,
            lng: Number.isFinite(dropLng) ? dropLng : null,
            address: dropAddress,
        },
        dropAddress: dropAddress || null,
        routeDistanceKm: distance == null ? null : Number(distance),
        estimatedDuration: duration == null ? null : Number(duration),
        pricingBreakdown,
        routeMetadata,
        routeGeometry: routeMetadata?.geometry || null,
        routePolyline: Array.isArray(routeMetadata?.polyline) ? routeMetadata.polyline : null,
        finalEstimatedPrice: row.finalEstimatedPrice ?? row.final_price ?? row.estimated_price ?? null,
        technicianEstimatedEarning: technicianEarning,
        estimatedEarnings: technicianEarning,
    };
};

const canonicalizeDomain = canonicalizeServiceDomain;

// Internal Helper
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

export const jobDispatchService = {
    buildRequestCriteria(jobRequest, radiusKm = null) {
        const userLat = Number(jobRequest.location_lat);
        const userLng = Number(jobRequest.location_lng);
        const reqRawType = normalizeText((jobRequest.service_type || "").replace(/^(car|bike|ev|commercial)-/i, ""));
        const reqType = canonicalizeDomain(reqRawType);
        const vehiclePolicy = getVehicleServicePolicy(jobRequest);
        const reqVehicle = vehiclePolicy.family;
        const globalRadius = Number.isFinite(Number(radiusKm)) ? Number(radiusKm) : null;
        return { userLat, userLng, reqType, reqVehicle, globalRadius, vehiclePolicy, jobRequest, requiredTowTruckType: requiredTowTruckType(jobRequest) };
    },

    evaluateTechnicianForRequest(tech, criteria) {
        const reasons = [];
        const { userLat, userLng, reqType, reqVehicle, globalRadius } = criteria;

        if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) {
            return { eligible: false, reasons: ["invalid_job_location"] };
        }
        if (!reqType) reasons.push("invalid_service_domain");
        if (!reqVehicle) reasons.push("invalid_vehicle_type");
        if (reasons.length > 0) return { eligible: false, reasons };

        if (String(tech.status || "").toLowerCase() !== "approved") reasons.push("not_approved");
        if (!tech.is_active) reasons.push("inactive");
        if (!tech.is_available) reasons.push("unavailable");
        if (tech.current_job_id != null) reasons.push("busy");
        if (tech.admin_hidden != null && Boolean(Number(tech.admin_hidden))) reasons.push("hidden_by_admin");

        const tLat = Number(tech.latitude);
        const tLng = Number(tech.longitude);
        if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) reasons.push("missing_location");

        const type = canonicalizeDomain(tech.service_type);
        const specialties = safeParse(tech.specialties);
        const serviceCosts = safeParse(tech.service_costs);
        const specialtyDomains = Array.isArray(specialties) ? specialties : [];
        const pricingDomains = serviceDomainsFromCosts(serviceCosts);
        const domains = [type, ...specialtyDomains, ...pricingDomains]
            .map((d) => canonicalizeDomain(d))
            .filter(Boolean);

        if (domains.length === 0) reasons.push("service_profile_missing");
        if (domains.length > 0 && !domains.includes(reqType)) reasons.push("service_mismatch");

        const techVehicles = parseVehicleTypes(tech.vehicle_types);
        const vehicleSupport = evaluateVehicleServiceSupport(criteria.jobRequest || { service_type: reqType, vehicle_type: reqVehicle }, tech);
        if (!vehicleSupport.eligible) reasons.push(vehicleSupport.code);

        if (reqType === "towing") {
            const capability = evaluateTowTruckCapability(criteria.requiredTowTruckType, tech.fleet_vehicles);
            if (capability.code) reasons.push(capability.code);
        }

        let distKm = null;
        if (Number.isFinite(tLat) && Number.isFinite(tLng)) {
            distKm = getDistanceFromLatLonInKm(userLat, userLng, tLat, tLng);
            const techRange = Number(tech.service_area_range);
            const allowedByTechRange = Number.isFinite(techRange) && techRange > 0 ? distKm <= techRange : true;
            const allowedByGlobalRadius = globalRadius ? distKm <= globalRadius : true;
            if (!allowedByTechRange || !allowedByGlobalRadius) reasons.push("out_of_range");
        }

        return {
            eligible: reasons.length === 0,
            reasons,
            distanceKm: distKm,
            matchedDomain: reqType,
            matchedVehicle: reqVehicle,
            technicianDomains: domains,
            technicianVehicles: techVehicles
        };
    },

    analyzeTechnicians(jobRequest, technicians, radiusKm = null) {
        const criteria = this.buildRequestCriteria(jobRequest, radiusKm);
        const reasonCounts = {};
        const analysis = (technicians || []).map((tech) => {
            const evaluation = this.evaluateTechnicianForRequest(tech, criteria);
            evaluation.reasons.forEach((r) => {
                reasonCounts[r] = (reasonCounts[r] || 0) + 1;
            });
            return {
                technicianId: tech.id,
                name: tech.name,
                status: tech.status,
                is_active: !!tech.is_active,
                is_available: !!tech.is_available,
                service_type: tech.service_type,
                vehicle_types: safeParse(tech.vehicle_types),
                service_area_range: tech.service_area_range,
                latitude: tech.latitude,
                longitude: tech.longitude,
                ...evaluation
            };
        });
        return { criteria, analysis, reasonCounts };
    },

    /**
     * Find top technicians for a job request (ETA prioritized).
     * 1. Check DB for active, available, and compatible techs within radius.
     * 2. Calculate ETA using the shared OSM route service.
     * 3. Sort by ETA (fastest first).
     * 4. Return top candidates.
     */
    async findTopTechnicians(jobRequest, radiusKm = null, { pool: suppliedPool, routeProvider = getRoute } = {}) {
        console.log(`[Dispatch] Finding technicians for Job #${jobRequest.id} (Radius: ${radiusKm}km)`);
        const { userLat, userLng } = this.buildRequestCriteria(jobRequest, radiusKm);

        if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) {
            console.error("[Dispatch] Invalid job location");
            return [];
        }

        try {
            // 1. Get technicians from DB and analyze with strict eligibility rules
            const pool = suppliedPool || await db.getPool();
            let [rows] = await pool.query("SELECT * FROM technicians");
            rows = await loadChargingServiceProfiles(pool, jobRequest, rows);
            if (isTowingServiceType(jobRequest.service_type)) rows = await loadTechnicianFleetVehicles(pool, rows);
            const { criteria, analysis, reasonCounts } = this.analyzeTechnicians(jobRequest, rows, radiusKm);

            if (!criteria.reqType || !criteria.reqVehicle) {
                console.warn(`[Dispatch] Missing canonical request dimensions. reqType=${criteria.reqType}, reqVehicle=${criteria.reqVehicle}`);
                return [];
            }
            let candidates = rows
                .map((row) => {
                    const evalRow = analysis.find((a) => String(a.technicianId) === String(row.id));
                    return { ...row, evaluation: evalRow };
                })
                .filter((row) => row.evaluation?.eligible)
                .map((row) => ({
                    ...row,
                    haversineDist: Number(row.evaluation?.distanceKm || 0)
                }));

            console.log(`[Dispatch] Found ${candidates.length} candidates within ${radiusKm}km.`);
            if (candidates.length === 0) {
                console.log("[Dispatch] No candidates found. Dumping technician summary for debug:");
                rows.forEach(r => console.log(`- ${r.name} (${r.service_type}) @ ${r.latitude},${r.longitude}`));
                console.log("[Dispatch] Rejection summary:", reasonCounts);
                return [];
            }

            // 3. ETA scoring
            // Use fallback ETA for everyone; enrich top N with the shared OSM route service.
            candidates.sort((a, b) => a.haversineDist - b.haversineDist);
            candidates.forEach((tech) => {
                tech.etaSeconds = (tech.haversineDist / 30) * 3600; // fallback 30km/h
                tech.etaText = `~${Math.ceil(tech.etaSeconds / 60)} mins`;
                tech.distanceText = `${tech.haversineDist.toFixed(1)} km`;
            });

            const matrixLimit = Math.max(0, Number(process.env.DISPATCH_ETA_MATRIX_LIMIT || 25));
            const matrixCandidates = candidates.slice(0, matrixLimit);

            try {
                // Fetch ETA for each candidate in parallel
                await Promise.all(matrixCandidates.map(async (tech) => {
                    try {
                        const route = await routeProvider({
                            points: [
                                { lat: tech.latitude, lng: tech.longitude },
                                { lat: userLat, lng: userLng },
                            ],
                            overview: "simplified",
                        });
                        tech.etaSeconds = Number(route.durationMinutes || 0) * 60;
                        tech.etaText = `${Math.ceil(Number(route.durationMinutes || 0))} mins`;
                        tech.distanceText = `${Number(route.distanceKm || 0).toFixed(1)} km`;
                    } catch { }
                }));

            } catch (err) {
                console.error("[Dispatch] OSRM Error:", err.message);
            }

            // 4. Sort by Fastest ETA
            candidates.sort((a, b) => a.etaSeconds - b.etaSeconds);

            // Return all matching technicians
            return candidates;

        } catch (err) {
            console.error("[Dispatch] Error finding technicians:", err);
            return [];
        }
    },

    /**
     * Dispatch Job to Technicians.
     * Creates offers and sends socket notifications.
     */
    async dispatchJob(jobRequest, technicians, { pool: suppliedPool, sockets = socketService, estimateEarning = estimateTechnicianEarningForRequest } = {}) {
        if (!technicians || technicians.length === 0) return;
        const pool = suppliedPool || await db.getPool();

        // De-duplicate by existing offers so a technician gets one active alert per request
        const [existingOffers] = await pool.query(
            "SELECT technician_id FROM dispatch_offers WHERE service_request_id = ? AND status = 'pending' AND pricing_snapshot IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW())",
            [jobRequest.id]
        );
        const offeredSet = new Set((existingOffers || []).map((o) => String(o.technician_id)));
        const freshTechnicians = technicians.filter((t) => !offeredSet.has(String(t.id)));
        if (freshTechnicians.length === 0) {
            console.log(`[Dispatch] No new technicians to notify for request #${jobRequest.id}.`);
            return;
        }

        // Invalid/missing registered rates cannot become zero or platform-priced offers.
        for (const t of freshTechnicians) {
            let offer;
            try { offer = await createPricedDispatchOffer(pool, jobRequest, t, { estimateEarning }); }
            catch (error) {
                if (!["pricing_unavailable", "offer_unavailable"].includes(error.code)) throw error;
                console.warn(`[Dispatch] Skipped technician ${t.id}: ${error.code}`);
                continue;
            }
            const offerPayload = {
                requestId: jobRequest.id,
                isTowing: isTowingServiceType(jobRequest.service_type),
                serviceType: jobRequest.service_type,
                vehicleType: jobRequest.vehicle_type,
                location: { lat: jobRequest.location_lat, lng: jobRequest.location_lng },
                address: jobRequest.address,
                customerName: jobRequest.contact_name || "Valued Customer",
                ...buildTowingDispatchFields(jobRequest),
                ...buildTechnicianJobDetails(jobRequest),
                description: jobRequest.description || null,
                ...dispatchOfferPricingFields(offer),
                distance: t.distanceText,
                locationDistance: t.distanceText,
                eta: t.etaText,
                expiresIn: 20 // 20 seconds countdown
            };

            // Emit to technician room and push notification
            sockets.io?.to(`technician_${t.id}`).emit("JOB_ALERT", offerPayload);
            sockets.notifyTechnician(t.id, "job_offer", offerPayload);
            sockets.io?.to(`technician_${t.id}`).emit("job:list_update", {
                requestId: jobRequest.id,
                action: "created"
            });
            console.log(`[Dispatch] Notified technician ${t.id} for request #${jobRequest.id}.`);

            // Push Notification (Simulated)
            pool.query("INSERT INTO notifications (type, title, message, created_at) VALUES (?, ?, ?, NOW())", [
                'job_offer',
                'New Job Alert!',
                `Service: ${jobRequest.service_type}. ETA: ${t.etaText}`
            ]).catch(() => { });
        }
    },

    /**
     * Technician Accepts Job (Atomic Locking)
     */
    async getAcceptanceOutcome(technicianId, requestId, { pool: suppliedPool, offerId = null } = {}) {
        const pool = suppliedPool || await db.getPool();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [jobs] = await conn.query("SELECT * FROM service_requests WHERE id = ? FOR UPDATE", [requestId]);
            const job = jobs[0];
            const [offers] = await conn.query(
                `SELECT id, status, pricing_snapshot, expires_at IS NOT NULL AND expires_at <= NOW() AS expired
                 FROM dispatch_offers WHERE service_request_id = ? AND technician_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1`,
                [requestId, technicianId]
            );
            const ownsJob = job?.technician_id != null && String(job.technician_id) === String(technicianId);
            let result;
            if (!job || (!ownsJob && !offers.length)) result = { code: "not_found" };
            else if (ownsJob && isActiveJobStatus(job.status) && normalizeText(job.status) !== "assigned") {
                result = { state: "accepted", job: { ...job, isTowing: isTowingServiceType(job.service_type) } };
            } else if (["completed", "paid", "closed", "cancelled", "rejected", "expired"].includes(String(job.status).trim().toLowerCase())) {
                result = { state: "closed" };
            } else if (job.technician_id != null && !ownsJob) result = { state: "taken" };
            else if (offerId != null && String(offers[0]?.id) !== String(offerId)) result = { state: "expired", code: "offer_unavailable" };
            else if (!readDispatchPricingSnapshot(offers[0]?.pricing_snapshot, { requestId, technicianId })) result = { state: "expired", code: "offer_price_unavailable" };
            else if (ownsJob && String(job.status).trim().toLowerCase() === "assigned" && offers[0]?.status === "pending" && !Number(offers[0].expired)) result = { state: "available" };
            else if (offers[0]?.status === "pending" && !Number(offers[0].expired) && String(job.status).trim().toLowerCase() === "pending") {
                result = { state: "available" };
            } else result = { state: "expired" };
            await conn.commit();
            return result;
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally { conn.release(); }
    },

    async expirePendingOffer(requestId, technicianId, { pool: suppliedPool } = {}) {
        const pool = suppliedPool || await db.getPool();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [jobs] = await conn.query("SELECT * FROM service_requests WHERE id = ? FOR UPDATE", [requestId]);
            if (!jobs[0] || String(jobs[0].status).toLowerCase() !== "pending" || jobs[0].technician_id != null) {
                await conn.rollback();
                return { expired: false, reason: "request_resolved" };
            }
            const [result] = await conn.query(
                `UPDATE dispatch_offers SET status = 'expired'
                 WHERE service_request_id = ? AND technician_id = ? AND status = 'pending'
                   AND expires_at IS NOT NULL AND expires_at <= NOW()`,
                [requestId, technicianId]
            );
            await conn.commit();
            return { expired: Number(result.affectedRows) > 0, reason: "offer_already_handled" };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally { conn.release(); }
    },

    async acceptJob(technicianId, requestId, { pool: suppliedPool, estimateEarning = estimateTechnicianEarningForRequest, sockets = socketService, requireOffer = true, offerId = null } = {}) {
        const pool = suppliedPool || await db.getPool();
        const conn = await pool.getConnection();
        let acceptedJob = null;
        let sourceJob = null;
        let tech = null;
        let idempotent = false;
        let shouldNotify = false;
        let shouldRevokeOffers = false;
        let assignedAmount = null;
        let winningOffer = null;

        try {
            await conn.beginTransaction();

            // 1) Atomic lock on request row regardless of current status.
            const [jobRows] = await conn.query(
                "SELECT * FROM service_requests WHERE id = ? FOR UPDATE",
                [requestId]
            );

            if (jobRows.length === 0) {
                await conn.rollback();
                return { success: false, code: "not_found", reason: "Job not found" };
            }
            sourceJob = jobRows[0];
            const currentStatus = String(sourceJob?.status || "").trim().toLowerCase();
            const existingTechnicianId =
                sourceJob?.technician_id == null ? null : String(sourceJob.technician_id);
            const normalizedTechnicianId = String(technicianId);
            const sameTechnician = existingTechnicianId === normalizedTechnicianId;
            const terminalStatuses = new Set(["cancelled", "completed", "rejected", "paid", "closed"]);
            const sameTechIdempotentStatuses = new Set([
                "assigned",
                "accepted",
                "en-route",
                "on-the-way",
                "arrived",
                "in-progress",
                "en_route_pickup",
                "arrived_pickup",
                "vehicle_loaded",
                "enroute_drop",
                "arrived_drop",
                "service_completed",
                "awaiting_payment",
                "payment_pending",
                "paid",
                "closed",
            ]);

            // 2) Lock technician row.
            const [techRows] = await conn.query(
                "SELECT * FROM technicians WHERE id = ? FOR UPDATE",
                [technicianId]
            );
            if (techRows.length === 0) {
                await conn.rollback();
                return { success: false, code: "technician_not_found", reason: "Technician not found" };
            }
            tech = techRows[0];
            if (terminalStatuses.has(currentStatus)) {
                await conn.rollback();
                return { success: false, code: "job_closed", reason: `Job is already ${currentStatus}.` };
            }
            // A lost response must not replay pricing, reservation, or notifications.
            // Return the stored job even if this technician has since gone offline.
            if (sameTechnician && isActiveJobStatus(currentStatus) && currentStatus !== "assigned") {
                await conn.commit();
                return { success: true, idempotent: true, job: { ...sourceJob, isTowing: isTowingServiceType(sourceJob.service_type) }, technician: tech };
            }
            if ((!sameTechnician || !sameTechIdempotentStatuses.has(currentStatus)) &&
                (currentStatus !== "pending" || (existingTechnicianId && !sameTechnician))) {
                await conn.rollback();
                return { success: false, code: "job_taken", reason: "Job already accepted by another technician." };
            }
            if (requireOffer) {
                if (offerId == null || !isRecordId(recordId(offerId))) {
                    await conn.rollback();
                    return { success: false, code: "offer_required", reason: "Please open the latest priced offer before accepting this job." };
                }
                const [offers] = await conn.query(
                    `SELECT id, status, pricing_snapshot, expires_at IS NOT NULL AND expires_at <= NOW() AS expired
                     FROM dispatch_offers WHERE service_request_id = ? AND technician_id = ?
                     ORDER BY sent_at DESC, id DESC LIMIT 1 FOR UPDATE`,
                    [requestId, technicianId]
                );
                const offer = offers[0];
                if (!offer || offer.status !== "pending" || Number(offer.expired)) {
                    await conn.rollback();
                    const expired = offer?.status === "expired" || Number(offer?.expired);
                    return { success: false, code: expired ? "offer_expired" : "offer_unavailable", reason: expired ? "This job offer has expired." : "This job offer is no longer available." };
                }
                if (offerId != null && String(offer.id) !== String(offerId)) {
                    await conn.rollback();
                    return { success: false, code: "offer_unavailable", reason: "This offer has been replaced. Please open the latest job offer." };
                }
                winningOffer = offer;
            }
            await markTechnicianReserved(conn, technicianId, requestId, { alreadyOwned: sameTechnician, request: sourceJob });
            let pricingSnapshot = readDispatchPricingSnapshot(winningOffer?.pricing_snapshot, { requestId, technicianId });
            if (!pricingSnapshot && requireOffer) {
                await conn.rollback();
                return { success: false, code: "offer_price_unavailable", reason: "This offer has no valid saved price. Please wait for a refreshed offer." };
            }
            if (!pricingSnapshot) {
                pricingSnapshot = await buildDispatchPricingSnapshot({ request: sourceJob, technician: tech, technicianId, connection: conn, estimateEarning });
                const [created] = await conn.query(
                    "INSERT INTO dispatch_offers (service_request_id, technician_id, status, sent_at, expires_at, pricing_snapshot) VALUES (?, ?, 'pending', NOW(), DATE_ADD(NOW(), INTERVAL 20 SECOND), ?)",
                    [requestId, technicianId, JSON.stringify(pricingSnapshot)]
                );
                winningOffer = { id: created.insertId };
            }
            pricingSnapshot = { ...pricingSnapshot, offer_id: recordId(winningOffer.id) };
            assignedAmount = pricingSnapshot.technician_earning;
            const resolvedAmount = pricingSnapshot.customer_base_amount;

            const [acceptUpdateResult] = await conn.query(
                "UPDATE service_requests SET technician_id = ?, status = 'accepted', amount = ?, service_charge = ?, price = ?, technician_estimated_earning = ?, estimated_price = ?, final_price = ?, pricing_snapshot = ?, pricing_breakdown_json = ?, accepted_time = COALESCE(accepted_time, NOW()), updated_at = NOW() WHERE id = ? AND status IN ('pending', 'assigned')",
                [technicianId, resolvedAmount, resolvedAmount, resolvedAmount, assignedAmount,
                    pricingSnapshot.customer_total_amount, pricingSnapshot.customer_total_amount,
                    JSON.stringify(pricingSnapshot), JSON.stringify(pricingSnapshot.pricing_breakdown), requestId]
            );
            if (Number(acceptUpdateResult.affectedRows) !== 1) {
                await conn.rollback();
                return { success: false, code: "job_taken", reason: "Job already accepted by another technician." };
            }
            await conn.query("UPDATE dispatch_offers SET status = 'accepted' WHERE id = ? AND status = 'pending'", [winningOffer.id]);
            await conn.query(
                "UPDATE dispatch_offers SET status = 'rejected' WHERE service_request_id = ? AND id != ? AND status = 'pending'",
                [requestId, winningOffer.id]
            );
            acceptedJob = {
                ...sourceJob, technician_id: technicianId, status: "accepted",
                amount: resolvedAmount, service_charge: resolvedAmount, price: resolvedAmount,
                technician_estimated_earning: assignedAmount,
                estimated_price: pricingSnapshot.customer_total_amount,
                final_price: pricingSnapshot.customer_total_amount,
                pricing_snapshot: pricingSnapshot,
                pricing_breakdown_json: pricingSnapshot.pricing_breakdown,
                accepted_time: sourceJob.accepted_time || new Date().toISOString(),
                offerId: recordId(winningOffer.id), offer_id: recordId(winningOffer.id),
                pricing_status: "confirmed", pricing_finalized: true,
                updated_at: new Date().toISOString(),
            };
            shouldNotify = true;
            shouldRevokeOffers = true;
            await conn.commit();

            acceptedJob = {
                ...acceptedJob,
                isTowing: isTowingServiceType(sourceJob?.service_type),
            };

        } catch (err) {
            try { await conn.rollback(); } catch { /* ignore rollback errors */ }
            if (err instanceof JobOwnershipError || err.code === "pricing_unavailable") return { success: false, code: err.code, reason: err.message };
            if (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT" || Number(err.errno) === 1213) {
                return { success: false, code: "acceptance_retry", reason: "Another job action is being processed. Please check the job and retry." };
            }
            throw err;
        } finally {
            conn.release();
        }

        if (shouldNotify) {
            void recordAcceptedEvent({
                requestId,
                technicianId,
                from: { lat: Number(tech?.latitude), lng: Number(tech?.longitude) },
                to: { lat: Number(sourceJob?.location_lat), lng: Number(sourceJob?.location_lng) },
            }, { getRoute });
            try {
                const [userRows] = await pool.query(
                    "SELECT full_name FROM users WHERE id = ? LIMIT 1",
                    [sourceJob?.user_id]
                );
                const customerName = String(
                    sourceJob?.contact_name ||
                    userRows?.[0]?.full_name ||
                    "Customer"
                ).trim();

                const userLat = Number(sourceJob?.location_lat);
                const userLng = Number(sourceJob?.location_lng);
                const techLat = Number(tech?.latitude);
                const techLng = Number(tech?.longitude);
                const locationDistance =
                    Number.isFinite(userLat) &&
                    Number.isFinite(userLng) &&
                    Number.isFinite(techLat) &&
                    Number.isFinite(techLng)
                        ? `${getDistanceFromLatLonInKm(userLat, userLng, techLat, techLng).toFixed(1)} km`
                        : "Nearby";

                if (shouldRevokeOffers) {
                    const [rejectedOffers] = await pool.query(
                        "SELECT technician_id FROM dispatch_offers WHERE service_request_id = ? AND status = 'rejected'",
                        [requestId]
                    );
                    rejectedOffers.forEach((offer) => {
                        const normalizedOfferTechnicianId = String(offer?.technician_id || "").trim();
                        if (!normalizedOfferTechnicianId) return;

                        const revokedPayload = {
                            requestId: String(requestId),
                            jobId: String(requestId),
                            message: "This job has already been taken by another technician."
                        };
                        const jobTakenPayload = {
                            jobId: String(requestId),
                            technicianId: recordId(technicianId),
                        };
                        // notifyTechnician emits over socket and push, so background devices
                        // can dismiss full-screen alerts immediately.
                        sockets.notifyTechnician(normalizedOfferTechnicianId, "job:revoked", revokedPayload);
                        if (sockets.io) {
                            sockets.io.to(`technician_${normalizedOfferTechnicianId}`).emit("JOB_TAKEN", jobTakenPayload);
                            sockets.io.to(`technician_${normalizedOfferTechnicianId}`).emit("job:list_update", {
                                requestId: String(requestId),
                                action: "revoked"
                            });
                        }
                    });
                }

                const techInfo = {
                    id: tech.id,
                    name: tech.name,
                    phone: tech.phone,
                    location: { lat: tech.latitude, lng: tech.longitude }
                };

                sockets.io?.to(`request_${requestId}`).emit(`job_update_${requestId}`, { ...customerPricingView(acceptedJob), status: "accepted", technician: techInfo });
                sockets.notifyUser(sourceJob?.user_id, "job:status_update", {
                    requestId,
                    status: "accepted",
                    technicianId,
                    ...customerPricingView(acceptedJob),
                });

                const acceptedPayload = {
                    success: true,
                    idempotent,
                    request: acceptedJob
                };

                sockets.io?.to(`technician_${technicianId}`).emit("job_assigned", acceptedPayload);
                sockets.notifyTechnician(technicianId, "job:assigned", {
                    ...acceptedPayload,
                    id: String(requestId),
                    jobId: String(requestId),
                    requestId: String(requestId),
                    status: "accepted",
                    isTowing: isTowingServiceType(sourceJob?.service_type),
                    customerName,
                    serviceType: sourceJob?.service_type,
                    locationDistance,
                    ...buildTowingDispatchFields(acceptedJob),
                    ...buildTechnicianJobDetails(acceptedJob),
                    offerId: acceptedJob.offerId,
                    offer_id: acceptedJob.offer_id,
                    priceAmount: assignedAmount ?? 0,
                    amount: assignedAmount ?? 0,
                    technicianEstimatedEarning: assignedAmount ?? 0,
                    estimatedEarnings: assignedAmount ?? 0,
                    location: {
                        lat: sourceJob?.location_lat,
                        lng: sourceJob?.location_lng,
                        address: sourceJob?.address
                    },
                    address: sourceJob?.address
                });
            } catch (notifyErr) {
                console.error("[Dispatch] Accept notification sync failed:", notifyErr);
            }
        }

        console.log(
            `[Dispatch] Accept resolved for request #${requestId}: technician=${technicianId}, idempotent=${idempotent}`
        );
        return { success: true, idempotent, job: acceptedJob, technician: tech };
    }
};
