import * as db from "../db.js";
import { socketService } from "./socket.js";
import {
    canonicalizeServiceDomain,
    canonicalizeVehicleFamily,
    normalizeText,
    parseVehicleTypes,
    serviceDomainsFromCosts,
} from "./serviceNormalization.js";
import { markTechnicianReserved } from "./technicianStateService.js";
import { estimateTechnicianEarningForRequest } from "./technicianEarningsService.js";
import { getRoute } from "./routeService.js";
import { isTowingServiceType } from "./towingServiceType.js";


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
        const reqVehicle = canonicalizeVehicleFamily(jobRequest.vehicle_type);
        const globalRadius = Number.isFinite(Number(radiusKm)) ? Number(radiusKm) : null;
        return { userLat, userLng, reqType, reqVehicle, globalRadius };
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
        if (techVehicles.length === 0) reasons.push("vehicle_profile_missing");
        if (techVehicles.length > 0 && !techVehicles.some((t) => canonicalizeVehicleFamily(t) === reqVehicle)) {
            reasons.push("vehicle_mismatch");
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
    async findTopTechnicians(jobRequest, radiusKm = null) {
        console.log(`[Dispatch] Finding technicians for Job #${jobRequest.id} (Radius: ${radiusKm}km)`);
        const { userLat, userLng } = this.buildRequestCriteria(jobRequest, radiusKm);

        if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) {
            console.error("[Dispatch] Invalid job location");
            return [];
        }

        try {
            // 1. Get technicians from DB and analyze with strict eligibility rules
            const rows = await db.query("SELECT * FROM technicians");
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
                        const route = await getRoute({
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
    async dispatchJob(jobRequest, technicians) {
        if (!technicians || technicians.length === 0) return;
        const pool = await db.getPool();

        // De-duplicate by existing offers so a technician gets one active alert per request
        const [existingOffers] = await pool.query(
            "SELECT technician_id FROM dispatch_offers WHERE service_request_id = ?",
            [jobRequest.id]
        );
        const offeredSet = new Set((existingOffers || []).map((o) => String(o.technician_id)));
        const freshTechnicians = technicians.filter((t) => !offeredSet.has(String(t.id)));
        if (freshTechnicians.length === 0) {
            console.log(`[Dispatch] No new technicians to notify for request #${jobRequest.id}.`);
            return;
        }

        // 1. Create Offers
        const values = freshTechnicians.map(t => [jobRequest.id, t.id, 'pending']);
        if (values.length > 0) {
            const sql = "INSERT INTO dispatch_offers (service_request_id, technician_id, status) VALUES ?";
            const q = pool.format(sql, [values]);
            await pool.query(q);
            console.log(`[Dispatch] Created ${values.length} offer(s) for request #${jobRequest.id}.`);
        }

        // 2. Send WebSocket Alerts
        for (const t of freshTechnicians) {
            const earningEstimate = await estimateTechnicianEarningForRequest({
                request: jobRequest,
                technician: t,
                technicianId: t.id,
            });
            const resolvedOfferAmount = toPositiveMoney(earningEstimate?.amount) ?? 0;
            const offerPayload = {
                requestId: jobRequest.id,
                serviceType: jobRequest.service_type,
                vehicleType: jobRequest.vehicle_type,
                location: { lat: jobRequest.location_lat, lng: jobRequest.location_lng },
                address: jobRequest.address,
                customerName: jobRequest.contact_name || "Valued Customer",
                ...buildTowingDispatchFields(jobRequest),
                amount: resolvedOfferAmount,
                priceAmount: resolvedOfferAmount,
                technicianEstimatedEarning: resolvedOfferAmount,
                estimatedEarnings: resolvedOfferAmount,
                earningsSource: earningEstimate?.source || null,
                earningsBreakdown: earningEstimate?.breakdown || null,
                distance: t.distanceText,
                locationDistance: t.distanceText,
                eta: t.etaText,
                expiresIn: 20 // 20 seconds countdown
            };

            // Emit to technician room and push notification
            socketService.io.to(`technician_${t.id}`).emit("JOB_ALERT", offerPayload);
            socketService.notifyTechnician(t.id, "job_offer", offerPayload);
            socketService.io.to(`technician_${t.id}`).emit("job:list_update", {
                requestId: jobRequest.id,
                action: "created"
            });
            console.log(`[Dispatch] Notified technician ${t.id} for request #${jobRequest.id}.`);

            // Push Notification (Simulated)
            db.query("INSERT INTO notifications (type, title, message, created_at) VALUES (?, ?, ?, NOW())", [
                'job_offer',
                'New Job Alert!',
                `Service: ${jobRequest.service_type}. ETA: ${t.etaText}`
            ]).catch(() => { });
        }
    },

    /**
     * Technician Accepts Job (Atomic Locking)
     */
    async acceptJob(technicianId, requestId) {
        const pool = await db.getPool();
        const conn = await pool.getConnection();
        let acceptedJob = null;
        let sourceJob = null;
        let tech = null;
        let idempotent = false;
        let shouldNotify = false;
        let shouldRevokeOffers = false;
        let assignedAmount = null;

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
            const earningEstimate = await estimateTechnicianEarningForRequest({
                request: sourceJob,
                technician: tech,
                technicianId,
                connection: conn,
            });
            const isTowingJob = isTowingServiceType(sourceJob?.service_type);
            assignedAmount =
                toPositiveMoney(earningEstimate?.amount) ??
                toPositiveMoney(sourceJob?.amount) ??
                toPositiveMoney(sourceJob?.service_charge);
            const customerAmount = isTowingJob
                ? toPositiveMoney(sourceJob?.amount) ?? toPositiveMoney(sourceJob?.service_charge)
                : null;
            const resolvedAmount = customerAmount ?? assignedAmount ?? sourceJob?.amount ?? sourceJob?.service_charge ?? null;

            if (terminalStatuses.has(currentStatus)) {
                await conn.rollback();
                return {
                    success: false,
                    code: "conflict",
                    reason: `Job is already ${currentStatus}.`
                };
            }

            // Idempotent branch: already accepted/owned by same technician.
            if (sameTechnician && sameTechIdempotentStatuses.has(currentStatus)) {
                idempotent = true;

                // Legacy compatibility: convert stale "assigned" into "accepted".
                if (currentStatus === "assigned") {
                    await conn.query(
                        "UPDATE service_requests SET status = 'accepted', amount = COALESCE(amount, ?), technician_estimated_earning = ?, accepted_time = COALESCE(accepted_time, NOW()), updated_at = NOW() WHERE id = ?",
                        [resolvedAmount, assignedAmount, requestId]
                    );
                    await conn.query(
                        "UPDATE dispatch_offers SET status = 'accepted' WHERE service_request_id = ? AND technician_id = ?",
                        [requestId, technicianId]
                    );
                    await conn.query(
                        "UPDATE dispatch_offers SET status = 'rejected' WHERE service_request_id = ? AND technician_id != ? AND status = 'pending'",
                        [requestId, technicianId]
                    );
                    shouldNotify = true;
                    shouldRevokeOffers = true;
                    acceptedJob = {
                        ...sourceJob,
                        technician_id: technicianId,
                        status: "accepted",
                        amount: resolvedAmount,
                        technician_estimated_earning: assignedAmount,
                        updated_at: new Date().toISOString(),
                    };
                } else {
                    acceptedJob = {
                        ...sourceJob,
                        technician_id: technicianId,
                        amount: resolvedAmount,
                    };
                }

                await markTechnicianReserved(conn, technicianId, requestId);
                await conn.commit();
            } else {
                // Conflict: already owned by another technician in non-pending states.
                if (currentStatus !== "pending" || (existingTechnicianId && !sameTechnician)) {
                    await conn.rollback();
                    return {
                        success: false,
                        code: "conflict",
                        reason: "Job already accepted by another technician."
                    };
                }

                // Fresh accept path.
                const [acceptUpdateResult] = await conn.query(
                    "UPDATE service_requests SET technician_id = ?, status = 'accepted', amount = ?, technician_estimated_earning = ?, accepted_time = COALESCE(accepted_time, NOW()), updated_at = NOW() WHERE id = ? AND status = 'pending'",
                    [technicianId, resolvedAmount, assignedAmount, requestId]
                );
                const updatedRows = Number(acceptUpdateResult?.affectedRows || 0);
                console.log(
                    `[Dispatch Accept] requestId=${requestId} technicianId=${technicianId} affectedRows=${updatedRows}`
                );
                if (updatedRows !== 1) {
                    await conn.rollback();
                    return {
                        success: false,
                        code: "conflict",
                        reason: "Job already accepted by another technician."
                    };
                }

                await conn.query(
                    "UPDATE dispatch_offers SET status = 'accepted' WHERE service_request_id = ? AND technician_id = ?",
                    [requestId, technicianId]
                );
                await conn.query(
                    "UPDATE dispatch_offers SET status = 'rejected' WHERE service_request_id = ? AND technician_id != ? AND status = 'pending'",
                    [requestId, technicianId]
                );
                await markTechnicianReserved(conn, technicianId, requestId);

                acceptedJob = {
                    ...sourceJob,
                    technician_id: technicianId,
                    status: "accepted",
                    amount: resolvedAmount,
                    technician_estimated_earning: assignedAmount,
                    updated_at: new Date().toISOString(),
                };
                shouldNotify = true;
                shouldRevokeOffers = true;
                await conn.commit();
            }

        } catch (err) {
            try { await conn.rollback(); } catch { /* ignore rollback errors */ }
            throw err;
        } finally {
            conn.release();
        }

        if (shouldNotify) {
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
                            technicianId: Number(technicianId),
                        };
                        // notifyTechnician emits over socket and push, so background devices
                        // can dismiss full-screen alerts immediately.
                        socketService.notifyTechnician(normalizedOfferTechnicianId, "job:revoked", revokedPayload);
                        if (socketService.io) {
                            socketService.io.to(`technician_${normalizedOfferTechnicianId}`).emit("JOB_TAKEN", jobTakenPayload);
                            socketService.io.to(`technician_${normalizedOfferTechnicianId}`).emit("job:list_update", {
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

                socketService.io.emit(`job_update_${requestId}`, { status: "accepted", technician: techInfo });
                socketService.notifyUser(sourceJob?.user_id, "job:status_update", {
                    requestId,
                    status: "accepted",
                    technicianId
                });

                const acceptedPayload = {
                    success: true,
                    idempotent,
                    request: acceptedJob
                };

                socketService.io.to(`technician_${technicianId}`).emit("job_assigned", acceptedPayload);
                socketService.notifyTechnician(technicianId, "job:assigned", {
                    ...acceptedPayload,
                    id: String(requestId),
                    jobId: String(requestId),
                    requestId: String(requestId),
                    status: "accepted",
                    customerName,
                    serviceType: sourceJob?.service_type,
                    locationDistance,
                    ...buildTowingDispatchFields(sourceJob),
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
