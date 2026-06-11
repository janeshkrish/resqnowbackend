import { getPool } from "../db.js";
import { buildServiceRequestPaymentDetails } from "../services/serviceRequestPaymentService.js";
import { parseJson, toPositiveInt } from "./utils.js";

const COMPLETED_STATUSES = new Set(["completed", "paid"]);
const CANCELLED_STATUSES = new Set(["cancelled", "closed", "rejected"]);

const asNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asBoolean = (value) => Boolean(Number(value));

const uniqueStrings = (values) =>
  Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));

const statusLabel = (value) =>
  String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

function verificationStatus(value, fallback = "pending") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["approved", "verified"].includes(normalized)) return "verified";
  if (normalized === "rejected") return "rejected";
  if (normalized === "pending") return "pending";
  return fallback;
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
  const points = [lat1, lng1, lat2, lng2].map(Number);
  if (!points.every(Number.isFinite)) return null;
  const [aLat, aLng, bLat, bLng] = points;
  const earthRadiusKm = 6371;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLng / 2) ** 2;
  return Number((earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))).toFixed(1));
}

function resolveTowingFleetTypes(serviceRows, rawServiceCosts) {
  const types = [];
  for (const row of serviceRows || []) {
    const metadata = parseJson(row.metadata, {}) || {};
    types.push(...(Array.isArray(metadata.tow_truck_types) ? metadata.tow_truck_types : []));
    types.push(...(Array.isArray(metadata.towing_fleet_types) ? metadata.towing_fleet_types : []));
    if (metadata.default_tow_truck_type) types.push(metadata.default_tow_truck_type);
    if (metadata.fleet_pricing && typeof metadata.fleet_pricing === "object") {
      types.push(...Object.keys(metadata.fleet_pricing));
    }
  }
  for (const entry of Array.isArray(rawServiceCosts) ? rawServiceCosts : []) {
    if (String(entry?.service_domain || entry?.service_name || "").toLowerCase() !== "towing") continue;
    types.push(...(Array.isArray(entry?.towing_fleet_types) ? entry.towing_fleet_types : []));
  }
  return uniqueStrings(types);
}

function mapPricingRow(row) {
  return {
    id: Number(row.id),
    serviceDomain: row.service_domain || "",
    vehicleType: row.vehicle_type || "",
    visitCharge: asNumber(row.visit_charge),
    serviceCharge: asNumber(row.service_charge),
    deliveryCharge: asNumber(row.delivery_charge),
    extraKmCharge: asNumber(row.extra_km_charge),
    labourMin: asNumber(row.labour_min),
    labourMax: asNumber(row.labour_max),
    price2wMin: asNumber(row.price_2w_min),
    price2wMax: asNumber(row.price_2w_max),
    price4wMin: asNumber(row.price_4w_min),
    price4wMax: asNumber(row.price_4w_max),
    baseCharge: asNumber(row.base_price ?? row.service_charge),
    freeDistance: asNumber(row.free_km),
    costPerKm: asNumber(row.per_km_price ?? row.extra_km_charge),
    nightCharge: asNumber(row.night_charge),
    nightType: row.night_type || null,
    metadata: parseJson(row.metadata, {}) || {},
  };
}

function mapFleetRow(row) {
  return {
    id: Number(row.id),
    vehicleType: row.vehicle_type || "",
    vehicleNumber: row.vehicle_number || "",
    capacity: row.capacity || null,
    status: row.status || "available",
    metadata: parseJson(row.metadata, {}) || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function mapAttachment(row) {
  return {
    id: Number(row.id),
    fileName: row.file_name || null,
    url: row.file_url,
    mimeType: row.mime_type || null,
    type: row.attachment_type || "document",
    uploadedByType: row.uploaded_by_type || null,
    uploadedById: row.uploaded_by_id || null,
    metadata: parseJson(row.metadata, {}) || {},
    createdAt: row.created_at || null,
  };
}

async function fetchTechnicianAggregate(pool, technicianId) {
  const [technicianRows] = await pool.query("SELECT * FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
  const row = technicianRows?.[0];
  if (!row) return null;

  const [serviceRows, fleetRows, statsRows] = await Promise.all([
    pool
      .query(
        `SELECT *
         FROM technician_services
         WHERE technician_id = ?
         ORDER BY service_domain, vehicle_type, id`,
        [technicianId]
      )
      .then(([rows]) => rows),
    pool
      .query(
        `SELECT *
         FROM technician_fleet_vehicles
         WHERE technician_id = ?
         ORDER BY updated_at DESC, id DESC`,
        [technicianId]
      )
      .then(([rows]) => rows),
    pool
      .query(
        `SELECT
           COUNT(*) AS total_jobs,
           SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('completed', 'paid') THEN 1 ELSE 0 END) AS completed_jobs,
           SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('cancelled', 'closed', 'rejected') THEN 1 ELSE 0 END) AS cancelled_jobs
         FROM service_requests
         WHERE technician_id = ?`,
        [technicianId]
      )
      .then(([rows]) => rows),
  ]);

  const [revenueRows, reviewRows] = await Promise.all([
    pool
      .query(
        `SELECT COALESCE(SUM(COALESCE(technician_amount, 0)), 0) AS revenue_earned
         FROM payments p
         INNER JOIN service_requests sr ON sr.id = p.service_request_id
         WHERE sr.technician_id = ?
           AND LOWER(COALESCE(p.status, '')) IN ('completed', 'paid')`,
        [technicianId]
      )
      .then(([rows]) => rows),
    pool
      .query(
        `SELECT AVG(rating) AS rating, COUNT(*) AS review_count
         FROM reviews
         WHERE technician_id = ?`,
        [technicianId]
      )
      .then(([rows]) => rows),
  ]);

  const documents = parseJson(row.documents, {}) || {};
  const specialties = parseJson(row.specialties, []) || [];
  const vehicleTypes = parseJson(row.vehicle_types, {}) || {};
  const rawPricing = parseJson(row.pricing, {}) || {};
  const rawServiceCosts = parseJson(row.service_costs, []) || [];
  const documentStatuses =
    documents.verification_statuses && typeof documents.verification_statuses === "object"
      ? documents.verification_statuses
      : {};
  const overallVerification = verificationStatus(row.status);
  const pricingRows = serviceRows.map(mapPricingRow);
  const fleet = fleetRows.map(mapFleetRow);
  const selectedFleetTypes = resolveTowingFleetTypes(serviceRows, rawServiceCosts);
  const services = uniqueStrings([
    ...(Array.isArray(specialties) ? specialties : []),
    row.service_type,
    ...serviceRows.map((service) => service.service_domain),
  ]);
  const stats = statsRows?.[0] || {};
  const reviewStats = reviewRows?.[0] || {};

  return {
    technicianId: Number(row.id),
    businessInfo: {
      shopName: row.name || "",
      proprietorName: row.proprietor_name || "",
      contactNumber: row.phone || "",
      alternatePhone: row.alternate_phone || "",
      whatsappNumber: row.whatsapp_number || "",
      email: row.email || "",
      address: row.address || "",
      location: row.location || row.locality || "",
      region: row.region || "",
      district: row.district || "",
      state: row.state || "",
      locality: row.locality || "",
      googleMapsLink: row.google_maps_link || "",
      latitude: asNumber(row.latitude),
      longitude: asNumber(row.longitude),
      workingHours: parseJson(row.working_hours, {}) || {},
      businessType: row.business_type || "",
      experienceYears: Number(row.experience || 0),
      serviceAreaRangeKm: Number(row.service_area_range || 0),
    },
    verification: {
      approvalStatus: verificationStatus(row.status),
      aadhaar: {
        number: row.aadhaar_number || "",
        status: verificationStatus(documentStatuses.aadhaar, overallVerification),
      },
      pan: {
        number: row.pan_number || "",
        status: verificationStatus(documentStatuses.pan, overallVerification),
      },
      drivingLicense: {
        number: documents.driving_license_number || documents.dl_number || "",
        status: verificationStatus(documentStatuses.driving_license || documentStatuses.dl, overallVerification),
      },
      gst: {
        number: row.gst_number || "",
        status: verificationStatus(documentStatuses.gst, overallVerification),
      },
      businessRegistration: {
        number: row.trade_license_number || "",
        status: verificationStatus(documentStatuses.business_registration, overallVerification),
      },
    },
    services,
    fleet: {
      selectedTypes: selectedFleetTypes,
      vehicleCategories: vehicleTypes,
      vehicles: fleet,
    },
    pricing: {
      rows: pricingRows,
      rawPricing,
      rawServiceCosts,
    },
    documents,
    statistics: {
      totalJobs: Number(stats.total_jobs || 0),
      completedJobs: Number(stats.completed_jobs || 0),
      cancelledJobs: Number(stats.cancelled_jobs || 0),
      rating: asNumber(reviewStats.rating) ?? asNumber(row.rating) ?? 0,
      reviewCount: Number(reviewStats.review_count || 0),
      revenueEarned: asNumber(revenueRows?.[0]?.revenue_earned) ?? asNumber(row.total_earnings) ?? 0,
    },
    paymentDetails: parseJson(row.payment_details, {}) || {},
    appReadiness: parseJson(row.app_readiness, {}) || {},
    availability: {
      isActive: asBoolean(row.is_active),
      isAvailable: asBoolean(row.is_available),
      isLoggedIn: asBoolean(row.is_logged_in),
      lastSeenAt: row.last_seen_at || null,
    },
    registration: {
      createdAt: row.created_at || null,
      resumeUrl: row.resume_url || "",
      specialties,
      vehicleTypes,
      pricing: rawPricing,
      serviceCosts: rawServiceCosts,
      workingHours: parseJson(row.working_hours, {}) || {},
      paymentDetails: parseJson(row.payment_details, {}) || {},
      appReadiness: parseJson(row.app_readiness, {}) || {},
    },
  };
}

function buildDerivedTimeline(requestRow) {
  const values = [
    ["request_created", "Request Created", "pending", requestRow.created_at],
    ["technician_assigned", "Technician Assigned", "assigned", requestRow.accepted_time && requestRow.technician_id ? requestRow.accepted_time : null],
    ["accepted", "Accepted", "accepted", requestRow.accepted_time],
    ["started", "Started", "in_progress", requestRow.started_at || requestRow.start_time],
    ["reached", "Reached", "arrived", requestRow.arrived_time],
    ["vehicle_loaded", "Vehicle Loaded", "vehicle_loaded", requestRow.vehicle_loaded_time],
    ["arrived_drop", "Reached Destination", "arrived_drop", requestRow.drop_arrival_time],
    ["completed", "Completed", "completed", requestRow.completed_at],
    ["cancelled", "Cancelled", "cancelled", requestRow.cancelled_at],
  ];

  return values
    .filter(([, , , createdAt]) => Boolean(createdAt))
    .map(([eventType, title, status, createdAt]) => ({
      id: `derived-${eventType}`,
      eventType,
      title,
      status,
      description: null,
      actorType: "system",
      actorId: null,
      metadata: {},
      createdAt,
    }));
}

function mapAdminActionToTimeline(row) {
  const action = String(row.action_type || "").trim();
  const metadata = parseJson(row.metadata, {}) || {};
  const normalized = action.toLowerCase();
  let title = statusLabel(action);
  let eventType = action;
  if (normalized.includes("assign")) {
    title = "Technician Assigned";
    eventType = "technician_assigned";
  } else if (normalized.includes("escalat")) {
    title = "Request Escalated";
    eventType = "escalated";
  } else if (normalized.includes("priority")) {
    title = "Marked High Priority";
    eventType = "high_priority";
  } else if (normalized.includes("pricing") || normalized.includes("fare")) {
    title = "Fare Overridden";
    eventType = "fare_overridden";
  } else if (normalized.includes("close")) {
    title = "Request Closed";
    eventType = "closed";
  }
  return {
    id: `admin-${row.id}`,
    eventType,
    title,
    status: metadata.status || null,
    description: metadata.reason || metadata.note || null,
    actorType: "admin",
    actorId: row.admin_id || null,
    metadata,
    createdAt: row.created_at,
  };
}

export async function getAdminTechnicianDetails(req, res) {
  try {
    const technicianId = toPositiveInt(req.params?.id ?? req.params?.technicianId, 0, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    if (!technicianId) return res.status(400).json({ error: "Invalid technician id." });
    const pool = await getPool();
    const profile = await fetchTechnicianAggregate(pool, technicianId);
    if (!profile) return res.status(404).json({ error: "Technician not found." });
    return res.json(profile);
  } catch (error) {
    console.error("[admin.details.technician] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technician details." });
  }
}

export async function getAdminRequestDetails(req, res) {
  try {
    const requestId = toPositiveInt(req.params?.requestId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!requestId) return res.status(400).json({ error: "Invalid request id." });
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         sr.*,
         u.full_name AS user_full_name,
         u.email AS user_email,
         u.phone AS user_phone
       FROM service_requests sr
       LEFT JOIN users u ON u.id = sr.user_id
       WHERE sr.id = ?
       LIMIT 1`,
      [requestId]
    );
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: "Request not found." });

    const [paymentRows, invoiceRows, timelineRows, attachmentRows, actionRows] = await Promise.all([
      pool
        .query("SELECT * FROM payments WHERE service_request_id = ? ORDER BY id DESC LIMIT 1", [requestId])
        .then(([result]) => result),
      pool
        .query("SELECT * FROM invoices WHERE service_request_id = ? ORDER BY id DESC LIMIT 1", [requestId])
        .then(([result]) => result),
      pool
        .query("SELECT * FROM request_timeline WHERE request_id = ? ORDER BY created_at, id", [requestId])
        .then(([result]) => result),
      pool
        .query("SELECT * FROM request_attachments WHERE request_id = ? ORDER BY created_at, id", [requestId])
        .then(([result]) => result),
      pool
        .query(
          `SELECT id, admin_id, action_type, metadata, created_at
           FROM admin_actions_log
           WHERE target_type = 'service_request' AND CAST(target_id AS UNSIGNED) = ?
           ORDER BY created_at, id`,
          [requestId]
        )
        .then(([result]) => result),
    ]);

    const payment = paymentRows?.[0] || null;
    const invoice = invoiceRows?.[0] || null;
    const pricingBreakdown = parseJson(row.pricing_breakdown_json, {}) || {};
    const paymentDetails = buildServiceRequestPaymentDetails({ requestRow: row, paymentRow: payment });
    const customerFare =
      asNumber(row.final_price) ?? asNumber(row.estimated_price) ?? asNumber(payment?.amount) ?? asNumber(row.amount) ?? 0;
    const technicianEarnings =
      asNumber(row.technician_estimated_earning) ?? asNumber(payment?.technician_amount) ?? asNumber(row.amount) ?? 0;
    const tax = asNumber(pricingBreakdown.tax ?? pricingBreakdown.gst ?? invoice?.gst) ?? 0;
    const platformMargin =
      asNumber(payment?.platform_fee) ?? Math.max(0, Number((customerFare - technicianEarnings - tax).toFixed(2)));
    const technician = row.technician_id ? await fetchTechnicianAggregate(pool, Number(row.technician_id)) : null;
    const timeline = [
      ...buildDerivedTimeline(row),
      ...(timelineRows || []).map((entry) => ({
        id: Number(entry.id),
        eventType: entry.event_type,
        title: entry.title,
        status: entry.status || null,
        description: entry.description || null,
        actorType: entry.actor_type || null,
        actorId: entry.actor_id || null,
        metadata: parseJson(entry.metadata, {}) || {},
        createdAt: entry.created_at,
      })),
      ...(actionRows || []).map(mapAdminActionToTimeline),
    ].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const highPriority = (actionRows || []).some((entry) =>
      String(entry.action_type || "").toLowerCase().includes("priority")
    );

    return res.json({
      request: {
        id: Number(row.id),
        createdTime: row.created_at,
        updatedTime: row.updated_at,
        status: row.status || "pending",
        priority: highPriority ? "High" : "Normal",
        serviceType: row.service_type || "",
        description: row.description || "",
        paymentStatus: row.payment_status || "pending",
        cancellationReason: row.cancellation_reason || row.closing_reason || null,
      },
      customer: {
        id: Number(row.user_id),
        name: row.contact_name || row.user_full_name || "",
        phone: row.contact_phone || row.user_phone || "",
        email: row.contact_email || row.user_email || "",
        issueDescription: row.description || "",
        notes: row.notes || null,
      },
      vehicle: {
        number: row.vehicle_number || null,
        type: row.vehicle_type || null,
        category: pricingBreakdown.vehicle_category || row.vehicle_category || row.vehicle_type || null,
        model: row.vehicle_model || null,
      },
      location: {
        pickupAddress: row.address || "",
        destinationAddress: row.drop_address || null,
        pickup: { lat: asNumber(row.location_lat), lng: asNumber(row.location_lng) },
        destination: { lat: asNumber(row.drop_latitude), lng: asNumber(row.drop_longitude) },
        distanceKm: asNumber(row.route_distance_km),
        estimatedDurationMinutes: asNumber(row.estimated_duration),
        routeMetadata: parseJson(row.route_metadata_json, {}) || {},
      },
      fare: {
        currency: paymentDetails.currency || "INR",
        customerFare,
        technicianEarnings,
        platformMargin,
        surgeMultiplier: asNumber(pricingBreakdown.surge_multiplier) ?? 1,
        tax,
        total: asNumber(payment?.amount) ?? asNumber(invoice?.total_amount) ?? customerFare,
        paymentDetails,
        breakdown: pricingBreakdown,
      },
      technician,
      timeline,
      attachments: (attachmentRows || []).map(mapAttachment),
    });
  } catch (error) {
    console.error("[admin.details.request] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch request details." });
  }
}

export async function getAdminRequestAssignmentCandidates(req, res) {
  try {
    const requestId = toPositiveInt(req.params?.requestId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
    if (!requestId) return res.status(400).json({ error: "Invalid request id." });
    const search = String(req.query?.search || "").trim().toLowerCase();
    const limit = toPositiveInt(req.query?.limit, 50, { min: 1, max: 100 });
    const pool = await getPool();
    const [requestRows] = await pool.query(
      "SELECT id, service_type, location_lat, location_lng FROM service_requests WHERE id = ? LIMIT 1",
      [requestId]
    );
    const request = requestRows?.[0];
    if (!request) return res.status(404).json({ error: "Request not found." });

    const [technicians] = await pool.query(
      `SELECT *
       FROM technicians
       WHERE LOWER(COALESCE(status, '')) = 'approved'
         AND COALESCE(is_active, 0) = 1
       ORDER BY COALESCE(is_available, 0) DESC, COALESCE(rating, 0) DESC, id`
    );
    if (!technicians.length) return res.json({ requestId, data: [] });

    const ids = technicians.map((row) => Number(row.id));
    const placeholders = ids.map(() => "?").join(", ");
    const [serviceRows, fleetRows] = await Promise.all([
      pool
        .query(
          `SELECT technician_id, service_domain, vehicle_type
           FROM technician_services
           WHERE technician_id IN (${placeholders})`,
          ids
        )
        .then(([rows]) => rows),
      pool
        .query(
          `SELECT technician_id, vehicle_type, vehicle_number, capacity, status
           FROM technician_fleet_vehicles
           WHERE technician_id IN (${placeholders})`,
          ids
        )
        .then(([rows]) => rows),
    ]);

    const servicesByTechnician = new Map();
    const fleetByTechnician = new Map();
    for (const service of serviceRows) {
      const key = Number(service.technician_id);
      const current = servicesByTechnician.get(key) || [];
      current.push(service.service_domain);
      servicesByTechnician.set(key, uniqueStrings(current));
    }
    for (const fleet of fleetRows) {
      const key = Number(fleet.technician_id);
      const current = fleetByTechnician.get(key) || [];
      current.push({
        vehicleType: fleet.vehicle_type || "",
        vehicleNumber: fleet.vehicle_number || "",
        capacity: fleet.capacity || null,
        status: fleet.status || "available",
      });
      fleetByTechnician.set(key, current);
    }

    const requestedService = String(request.service_type || "").trim().toLowerCase();
    const data = technicians
      .map((row) => {
        const specialties = parseJson(row.specialties, []) || [];
        const services = uniqueStrings([
          row.service_type,
          ...(Array.isArray(specialties) ? specialties : []),
          ...(servicesByTechnician.get(Number(row.id)) || []),
        ]);
        const fleet = fleetByTechnician.get(Number(row.id)) || [];
        const searchable = [
          row.name,
          row.phone,
          row.email,
          row.location,
          ...services,
          ...fleet.flatMap((item) => [item.vehicleType, item.vehicleNumber]),
        ]
          .join(" ")
          .toLowerCase();
        const technicianLat = row.current_lat ?? row.latitude;
        const technicianLng = row.current_lng ?? row.longitude;
        return {
          technicianId: Number(row.id),
          name: row.name || "",
          phone: row.phone || "",
          profileImage: parseJson(row.documents, {})?.profile_photo || "",
          shopName: row.name || "",
          location: row.location || row.locality || "",
          distanceKm: calculateDistanceKm(
            request.location_lat,
            request.location_lng,
            technicianLat,
            technicianLng
          ),
          rating: asNumber(row.rating) ?? 0,
          jobsCompleted: Number(row.jobs_completed || 0),
          availability: asBoolean(row.is_available) ? "Available" : "Busy",
          status: asBoolean(row.is_logged_in) ? "Online" : "Offline",
          approvalStatus: verificationStatus(row.status),
          services,
          fleet,
          matchesService: services.some((service) => String(service).toLowerCase() === requestedService),
          searchable,
        };
      })
      .filter((row) => !search || row.searchable.includes(search))
      .sort((left, right) => {
        if (left.matchesService !== right.matchesService) return left.matchesService ? -1 : 1;
        if (left.availability !== right.availability) return left.availability === "Available" ? -1 : 1;
        if (left.distanceKm == null && right.distanceKm != null) return 1;
        if (left.distanceKm != null && right.distanceKm == null) return -1;
        if (left.distanceKm != null && right.distanceKm != null && left.distanceKm !== right.distanceKm) {
          return left.distanceKm - right.distanceKm;
        }
        return right.rating - left.rating;
      })
      .slice(0, limit)
      .map(({ searchable, ...row }) => row);

    return res.json({ requestId, serviceType: request.service_type, data });
  } catch (error) {
    console.error("[admin.details.candidates] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch assignment candidates." });
  }
}

export { COMPLETED_STATUSES, CANCELLED_STATUSES };
