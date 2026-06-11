import { getPool } from "../db.js";
import { buildPagination, likeFilter, resolveAdminId, toPositiveInt } from "./utils.js";
import { socketService } from "../services/socket.js";
import { closeRequestWithFinanceSync } from "../services/requestClosureService.js";
import { sendEventEmail } from "../utils/eventEmail.js";

const ACTIVE_REQUEST_STATES = [
  "assigned",
  "accepted",
  "en_route_pickup",
  "arrived_pickup",
  "vehicle_loaded",
  "enroute_drop",
  "arrived_drop",
  "service_completed",
  "processing",
  "service_started",
  "en-route",
  "on-the-way",
  "arrived",
  "in_progress",
  "in-progress",
  "awaiting_payment",
  "payment_pending",
];

const REQUEST_STATUS_FILTER_SET = {
  pending: ["pending"],
  assigned: ["assigned"],
  accepted: ["accepted"],
  en_route_pickup: ["en_route_pickup"],
  arrived_pickup: ["arrived_pickup"],
  vehicle_loaded: ["vehicle_loaded"],
  enroute_drop: ["enroute_drop"],
  arrived_drop: ["arrived_drop"],
  service_completed: ["service_completed"],
  processing: ["processing"],
  in_progress: ["in_progress", "in-progress"],
  service_started: ["service_started", "en-route", "on-the-way", "arrived"],
  payment_pending: ["payment_pending", "awaiting_payment"],
  completed: ["completed", "paid"],
  closed: ["closed"],
  cancelled: ["cancelled"],
};

function normalizeRequestStatusKey(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";

  const map = {
    "all": "all",
    "on_the_way": "on-the-way",
    "on the way": "on-the-way",
    "en_route": "en-route",
    "service started": "service_started",
    "in_progress": "in-progress",
    "in progress": "in-progress",
    "payment-pending": "payment_pending",
    "awaiting-payment": "payment_pending",
    "awaiting payment": "payment_pending",
    "awaiting_payment": "payment_pending",
    "en route pickup": "en_route_pickup",
    "en-route-pickup": "en_route_pickup",
    "arrived pickup": "arrived_pickup",
    "vehicle loaded": "vehicle_loaded",
    "tow started": "enroute_drop",
    "start tow": "enroute_drop",
    "en route drop": "enroute_drop",
    "arrived drop": "arrived_drop",
    "service completed": "service_completed",
  };

  const mapped = map[normalized] || normalized;
  if (mapped === "on-the-way" || mapped === "en-route" || mapped === "arrived") {
    return "service_started";
  }
  if (mapped === "in-progress") {
    return "in_progress";
  }
  return mapped;
}

function resolveStatusFilterValues(value) {
  const key = normalizeRequestStatusKey(value);
  if (!key || key === "all") return { key: key || "all", values: [] };
  return {
    key,
    values: REQUEST_STATUS_FILTER_SET[key] || [key],
  };
}

function canonicalizeRequestStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["service_started", "en-route", "on-the-way", "arrived"].includes(normalized)) {
    return "service_started";
  }
  if (normalized === "in-progress") {
    return "in_progress";
  }
  if (normalized === "paid") {
    return "completed";
  }
  if (normalized === "awaiting_payment") {
    return "payment_pending";
  }
  if (["en_route_pickup", "arrived_pickup", "vehicle_loaded", "enroute_drop", "arrived_drop", "service_completed", "closed"].includes(normalized)) {
    return normalized;
  }
  return normalized || "pending";
}

const safeParseObject = (value) => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const toPositiveMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round((parsed + Number.EPSILON) * 100) / 100 : null;
};

function mapRequestRow(row) {
  const pricingBreakdown = safeParseObject(row.pricing_breakdown_json);
  const routeMetadata = safeParseObject(row.route_metadata_json);
  const customerFare = toPositiveMoney(row.final_price ?? row.estimated_price ?? row.amount);
  const technicianEstimatedEarning = toPositiveMoney(row.technician_estimated_earning);
  const platformMargin =
    customerFare != null && technicianEstimatedEarning != null
      ? Math.round((customerFare - technicianEstimatedEarning + Number.EPSILON) * 100) / 100
      : null;
  const statusTimeline = [
    ["created", row.created_at],
    ["accepted", row.accepted_time],
    ["started", row.started_at || row.start_time],
    ["vehicle_loaded", row.vehicle_loaded_time],
    ["arrived_drop", row.drop_arrival_time],
    ["completed", row.completed_at],
    ["updated", row.updated_at],
  ]
    .filter(([, at]) => Boolean(at))
    .map(([status, at]) => ({ status, at }));
  return {
    requestId: row.request_id,
    user: row.user_name,
    issueType: row.issue_type,
    location: row.location,
    pickupLocation: row.location,
    pickupLatitude: row.location_lat == null ? null : Number(row.location_lat),
    pickupLongitude: row.location_lng == null ? null : Number(row.location_lng),
    dropLocation: row.drop_location || null,
    dropLatitude: row.drop_latitude == null ? null : Number(row.drop_latitude),
    dropLongitude: row.drop_longitude == null ? null : Number(row.drop_longitude),
    routeDistanceKm: row.route_distance_km == null ? null : Number(row.route_distance_km),
    estimatedDuration: row.estimated_duration == null ? null : Number(row.estimated_duration),
    estimatedPrice: row.estimated_price == null ? null : Number(row.estimated_price),
    finalPrice: row.final_price == null ? null : Number(row.final_price),
    amount: row.amount == null ? null : Number(row.amount),
    customerFare,
    technicianEstimatedEarning,
    platformMargin,
    pricingBreakdown,
    pricingFactors: pricingBreakdown
      ? {
          vehicleMultiplier: pricingBreakdown.vehicle_multiplier,
          surgeMultiplier: pricingBreakdown.surge_multiplier,
          weatherFactor: pricingBreakdown.weather_factor,
          highwayFactor: pricingBreakdown.highway_factor,
          emergencyFactor: pricingBreakdown.emergency_factor,
          peakHour: pricingBreakdown.peak_hour,
          activeDemandNearby: pricingBreakdown.active_demand_nearby,
          activeMechanicsNearby: pricingBreakdown.active_mechanics_nearby,
        }
      : null,
    routeMetadata,
    routeGeometry: routeMetadata?.geometry || null,
    routePolyline: Array.isArray(routeMetadata?.polyline) ? routeMetadata.polyline : null,
    statusTimeline,
    assignedTechnician: row.technician_name,
    status: canonicalizeRequestStatus(row.status),
    priority: row.priority,
    createdTime: row.created_at,
  };
}

async function logAction({ pool, adminId, actionType, targetId, metadata = null }) {
  await pool.execute(
    `INSERT INTO admin_actions_log (admin_id, action_type, target_type, target_id, metadata)
     VALUES (?, ?, 'service_request', ?, ?)`,
    [adminId, actionType, String(targetId), JSON.stringify(metadata)]
  );
}

async function appendRequestTimeline({
  pool,
  requestId,
  eventType,
  title,
  status = null,
  description = null,
  actorType = "admin",
  actorId = null,
  metadata = null,
}) {
  await pool.execute(
    `INSERT INTO request_timeline
      (request_id, event_type, status, title, description, actor_type, actor_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      eventType,
      status,
      title,
      description,
      actorType,
      actorId,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function getRequestById(pool, requestId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, status, technician_id
     FROM service_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId]
  );
  return rows?.[0] || null;
}

export async function getRequests(req, res) {
  try {
    const { page, limit, offset } = buildPagination(req.query);
    const search = String(req.query?.search || "").trim();
    const statusFilter = resolveStatusFilterValues(req.query?.status);
    const priority = String(req.query?.priority || "").trim().toLowerCase();

    const whereClauses = [];
    const values = [];

    if (search) {
      whereClauses.push(`(
        CAST(sr.id AS CHAR) LIKE ?
        OR LOWER(COALESCE(u.full_name, '')) LIKE ?
        OR LOWER(COALESCE(sr.service_type, '')) LIKE ?
        OR LOWER(COALESCE(sr.address, '')) LIKE ?
        OR LOWER(COALESCE(t.name, '')) LIKE ?
      )`);
      const like = likeFilter(search.toLowerCase());
      values.push(like, like, like, like, like);
    }

    if (statusFilter.values.length > 0) {
      const placeholders = statusFilter.values.map(() => "?").join(", ");
      whereClauses.push(`LOWER(COALESCE(sr.status, '')) IN (${placeholders})`);
      values.push(...statusFilter.values);
    }

    if (priority === "high") {
      whereClauses.push("hp.request_id IS NOT NULL");
    } else if (priority === "normal") {
      whereClauses.push("hp.request_id IS NULL");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         sr.id AS request_id,
         COALESCE(u.full_name, CONCAT('User #', sr.user_id)) AS user_name,
         sr.service_type AS issue_type,
         sr.address AS location,
         sr.location_lat,
         sr.location_lng,
         sr.drop_address AS drop_location,
         sr.drop_latitude,
         sr.drop_longitude,
         sr.route_distance_km,
         sr.estimated_duration,
         sr.route_metadata_json,
         sr.pricing_breakdown_json,
         sr.estimated_price,
         sr.final_price,
         sr.amount,
         sr.technician_estimated_earning,
         COALESCE(t.name, 'Unassigned') AS technician_name,
         sr.status,
         CASE WHEN hp.request_id IS NULL THEN 'Normal' ELSE 'High' END AS priority,
         sr.created_at,
         sr.updated_at,
         sr.accepted_time,
         sr.started_at,
         sr.start_time,
         sr.vehicle_loaded_time,
         sr.drop_arrival_time,
         sr.completed_at
       FROM service_requests sr
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       LEFT JOIN (
         SELECT CAST(target_id AS UNSIGNED) AS request_id
         FROM admin_actions_log
         WHERE action_type IN ('markHighPriority', 'mark_high_priority')
         GROUP BY CAST(target_id AS UNSIGNED)
       ) hp ON hp.request_id = sr.id
       ${whereSql}
       ORDER BY sr.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM service_requests sr
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       LEFT JOIN (
         SELECT CAST(target_id AS UNSIGNED) AS request_id
         FROM admin_actions_log
         WHERE action_type IN ('markHighPriority', 'mark_high_priority')
         GROUP BY CAST(target_id AS UNSIGNED)
       ) hp ON hp.request_id = sr.id
       ${whereSql}`,
      values
    );

    const total = Number(countRows?.[0]?.total || 0);

    return res.json({
      data: rows.map(mapRequestRow),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: {
        search,
        status: statusFilter.key || "all",
        priority: priority || "all",
      },
    });
  } catch (error) {
    console.error("[admin.requests.list] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch requests." });
  }
}

export async function assignRequest(req, res) {
  try {
    const requestId = toPositiveInt(req.params?.requestId ?? req.body?.requestId, 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    const technicianId = toPositiveInt(req.body?.technicianId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });

    if (!requestId || !technicianId) {
      return res.status(400).json({ error: "requestId and technicianId are required." });
    }

    const pool = await getPool();
    const requestRow = await getRequestById(pool, requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found." });
    }

    const [technicianRows] = await pool.query(
      `SELECT id, name, phone, status, is_active, is_available
       FROM technicians
       WHERE id = ?
       LIMIT 1`,
      [technicianId]
    );
    if (technicianRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }
    if (String(technicianRows[0].status || "").toLowerCase() !== "approved") {
      return res.status(409).json({ error: "Only approved technicians can be assigned." });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `UPDATE service_requests
         SET technician_id = ?,
             status = CASE
               WHEN LOWER(COALESCE(status, '')) IN ('pending', 'open', 'assigned') THEN 'assigned'
               ELSE status
             END,
             updated_at = NOW()
         WHERE id = ?`,
        [technicianId, requestId]
      );
      if (requestRow.technician_id && Number(requestRow.technician_id) !== technicianId) {
        await conn.execute(
          `UPDATE technicians
           SET current_job_id = NULL, is_available = TRUE
           WHERE id = ? AND current_job_id = ?`,
          [requestRow.technician_id, requestId]
        );
      }
      await conn.execute(
        "UPDATE technicians SET current_job_id = ?, is_available = FALSE WHERE id = ?",
        [requestId, technicianId]
      );
      await appendRequestTimeline({
        pool: conn,
        requestId,
        eventType: "technician_assigned",
        title: "Technician Assigned",
        status: "assigned",
        actorId: resolveAdminId(req),
        metadata: {
          technicianId,
          previousTechnicianId: requestRow.technician_id || null,
        },
      });
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const adminNotificationEmail = String(req.adminEmail || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (adminNotificationEmail) {
      const [detailRows] = await pool.query(
        `SELECT
           COALESCE(sr.contact_name, u.full_name, CONCAT('User #', sr.user_id)) AS user_name,
           COALESCE(t.name, CONCAT('Technician #', sr.technician_id)) AS technician_name
         FROM service_requests sr
         LEFT JOIN users u ON u.id = sr.user_id
         LEFT JOIN technicians t ON t.id = sr.technician_id
         WHERE sr.id = ?
         LIMIT 1`,
        [requestId]
      );
      const detail = detailRows?.[0] || {};
      void sendEventEmail("ADMIN_TECHNICIAN_ASSIGNED", {
        email: adminNotificationEmail,
        requestId,
        name: detail.user_name || "Customer",
        technicianName: detail.technician_name || technicianRows[0]?.name || `Technician #${technicianId}`,
      });
    }

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "manualAssignTechnician",
      targetId: requestId,
      metadata: { technicianId },
    });

    const assignmentPayload = {
      requestId,
      jobId: String(requestId),
      id: String(requestId),
      technicianId,
      status: "assigned",
      assignedByAdmin: true,
    };
    if (requestRow.technician_id && Number(requestRow.technician_id) !== technicianId) {
      socketService.notifyTechnician(requestRow.technician_id, "job:revoked", assignmentPayload);
    }
    socketService.notifyTechnician(technicianId, "job:assigned", assignmentPayload);
    socketService.notifyUser(requestRow.user_id, "job:status_update", assignmentPayload);
    socketService.broadcast("admin:request_status_updated", assignmentPayload);
    socketService.broadcast("admin:technician_update", assignmentPayload);

    return res.json({
      success: true,
      requestId,
      technicianId,
      message: "Request assigned successfully.",
    });
  } catch (error) {
    console.error("[admin.requests.assign] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to assign request." });
  }
}

export async function escalateRequest(req, res) {
  try {
    const requestId = toPositiveInt(req.params?.requestId ?? req.body?.requestId, 0, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
    const reason = String(req.body?.reason || req.body?.note || "").trim();
    const radiusKm = toPositiveInt(req.body?.radiusKm, 35, { min: 5, max: 200 });

    if (!requestId) {
      return res.status(400).json({ error: "requestId is required." });
    }

    const pool = await getPool();
    const requestRow = await getRequestById(pool, requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found." });
    }

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "escalateRequest",
      targetId: requestId,
      metadata: {
        reason: reason || null,
        radiusKm,
        escalatedAt: new Date().toISOString(),
      },
    });
    await appendRequestTimeline({
      pool,
      requestId,
      eventType: "escalated",
      title: "Request Escalated",
      status: requestRow.status,
      description: reason || null,
      actorId: resolveAdminId(req),
      metadata: { radiusKm },
    });
    socketService.broadcast("admin:request_status_updated", {
      requestId,
      status: requestRow.status,
      escalated: true,
      at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      requestId,
      radiusKm,
      message: "Request escalated.",
    });
  } catch (error) {
    console.error("[admin.requests.escalate] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to escalate request." });
  }
}

export async function markHighPriority(req, res) {
  try {
    const requestId = toPositiveInt(req.body?.requestId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const note = String(req.body?.note || "").trim();

    if (!requestId) {
      return res.status(400).json({ error: "requestId is required." });
    }

    const pool = await getPool();
    const requestRow = await getRequestById(pool, requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found." });
    }

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "markHighPriority",
      targetId: requestId,
      metadata: {
        note: note || null,
      },
    });
    await appendRequestTimeline({
      pool,
      requestId,
      eventType: "high_priority",
      title: "Marked High Priority",
      status: requestRow.status,
      description: note || null,
      actorId: resolveAdminId(req),
    });

    return res.json({
      success: true,
      requestId,
      priority: "High",
    });
  } catch (error) {
    console.error("[admin.requests.highPriority] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to mark request as high priority." });
  }
}

export async function closeRequest(req, res) {
  try {
    const requestId = toPositiveInt(
      req.params?.requestId ?? req.body?.requestId ?? req.body?.id ?? req.body?.request_id,
      0,
      { min: 0, max: Number.MAX_SAFE_INTEGER }
    );
    const reason = String(req.body?.reason || req.body?.note || "").trim();
    const requestedStatus = String(req.body?.status || "cancelled").trim().toLowerCase();

    if (!requestId) {
      return res.status(400).json({ error: "requestId is required." });
    }

    if (!["completed", "cancelled"].includes(requestedStatus)) {
      return res.status(400).json({ error: "status must be either 'completed' or 'cancelled'." });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: "reason must be 1000 characters or fewer." });
    }

    const finalStatus = requestedStatus;

    const closureResult = await closeRequestWithFinanceSync({
      requestId,
      status: finalStatus,
      reason: reason || "Closed by admin",
    });

    const pool = await getPool();

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "manualCloseRequest",
      targetId: requestId,
      metadata: {
        status: closureResult.status,
        reason: reason || null,
        previousStatus: closureResult.previousStatus,
        paymentRowsUpdated: closureResult.paymentRowsUpdated,
        alreadyTerminal: closureResult.alreadyTerminal,
      },
    });
    await appendRequestTimeline({
      pool,
      requestId,
      eventType: closureResult.status === "completed" ? "completed" : "cancelled",
      title: closureResult.status === "completed" ? "Request Completed" : "Request Cancelled",
      status: closureResult.status,
      description: reason || null,
      actorId: resolveAdminId(req),
      metadata: { previousStatus: closureResult.previousStatus },
    });

    if (closureResult.userId) {
      socketService.notifyUser(closureResult.userId, "job:status_update", {
        requestId,
        status: closureResult.status,
      });
    }

    if (closureResult.technicianId) {
      socketService.notifyTechnician(closureResult.technicianId, "job:status_update", {
        requestId,
        status: closureResult.status,
      });
    }

    // Keep existing admin pages in sync without manual refresh.
    socketService.broadcast("admin:request_status_updated", {
      requestId,
      status: closureResult.status,
      previousStatus: closureResult.previousStatus,
      at: new Date().toISOString(),
    });
    socketService.broadcast("admin:payment_update", {
      requestId,
      status: closureResult.status,
      paymentRowsUpdated: closureResult.paymentRowsUpdated,
      at: new Date().toISOString(),
    });
    socketService.broadcast("admin:analytics_update", {
      requestId,
      status: closureResult.status,
      at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      requestId,
      status: closureResult.status,
      previousStatus: closureResult.previousStatus,
      paymentRowsUpdated: closureResult.paymentRowsUpdated,
      alreadyTerminal: closureResult.alreadyTerminal,
      message: "Request closed.",
    });
  } catch (error) {
    console.error("[admin.requests.close] failed:", error?.message || error);
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to close request." });
  }
}

export async function overrideRequestPricing(req, res) {
  try {
    const requestId = toPositiveInt(req.params?.requestId ?? req.body?.requestId ?? req.body?.request_id, 0, {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    });
    const baseAmount = toPositiveMoney(req.body?.baseAmount ?? req.body?.amount);
    const finalPrice = toPositiveMoney(req.body?.finalPrice ?? req.body?.final_price ?? req.body?.estimatedPrice);
    const reason = String(req.body?.reason || req.body?.note || "").trim();

    if (!requestId) {
      return res.status(400).json({ error: "requestId is required." });
    }
    if (baseAmount == null || baseAmount > 1000000) {
      return res.status(400).json({ error: "A valid baseAmount is required." });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: "reason must be 1000 characters or fewer." });
    }

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT id, user_id, technician_id, status, payment_status, pricing_breakdown_json
       FROM service_requests
       WHERE id = ?
       LIMIT 1`,
      [requestId]
    );
    const requestRow = rows?.[0] || null;
    if (!requestRow) {
      return res.status(404).json({ error: "Request not found." });
    }

    const paidStatus = new Set(["paid", "completed"]);
    if (
      paidStatus.has(String(requestRow.status || "").toLowerCase()) ||
      paidStatus.has(String(requestRow.payment_status || "").toLowerCase())
    ) {
      return res.status(409).json({ error: "Cannot override pricing after payment is complete." });
    }

    const existingBreakdown = safeParseObject(requestRow.pricing_breakdown_json) || {};
    const override = {
      base_amount: baseAmount,
      final_estimated_price: finalPrice ?? existingBreakdown.final_estimated_price ?? null,
      admin_override: true,
      override_reason: reason || null,
      overridden_by: resolveAdminId(req),
      overridden_at: new Date().toISOString(),
    };
    const mergedBreakdown = {
      ...existingBreakdown,
      ...override,
    };

    await pool.execute(
      `UPDATE service_requests
       SET amount = ?,
           estimated_price = COALESCE(?, estimated_price),
           final_price = COALESCE(?, final_price),
           pricing_breakdown_json = ?,
           pricing_override_json = ?,
           pricing_overridden_by = ?,
           pricing_overridden_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [
        baseAmount,
        finalPrice,
        finalPrice,
        JSON.stringify(mergedBreakdown),
        JSON.stringify(override),
        resolveAdminId(req),
        requestId,
      ]
    );

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "overrideRequestPricing",
      targetId: requestId,
      metadata: override,
    });
    await appendRequestTimeline({
      pool,
      requestId,
      eventType: "fare_overridden",
      title: "Fare Overridden",
      status: requestRow.status,
      description: reason || null,
      actorId: resolveAdminId(req),
      metadata: override,
    });

    socketService.notifyUser(requestRow.user_id, "request:pricing_updated", {
      requestId,
      amount: baseAmount,
      finalPrice,
      pricingBreakdown: mergedBreakdown,
    });
    if (requestRow.technician_id) {
      socketService.notifyTechnician(requestRow.technician_id, "request:pricing_updated", {
        requestId,
        amount: baseAmount,
        finalPrice,
        pricingBreakdown: mergedBreakdown,
      });
    }
    socketService.broadcast("admin:request_pricing_updated", {
      requestId,
      amount: baseAmount,
      finalPrice,
      at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      requestId,
      amount: baseAmount,
      finalPrice,
      pricingBreakdown: mergedBreakdown,
    });
  } catch (error) {
    console.error("[admin.requests.pricingOverride] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to override pricing." });
  }
}

export { ACTIVE_REQUEST_STATES };
