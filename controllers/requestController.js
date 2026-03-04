import { getPool } from "../db.js";
import { buildPagination, likeFilter, resolveAdminId, toPositiveInt } from "./utils.js";
import { socketService } from "../services/socket.js";
import { closeRequestWithFinanceSync } from "../services/requestClosureService.js";

const ACTIVE_REQUEST_STATES = [
  "assigned",
  "accepted",
  "en-route",
  "on-the-way",
  "arrived",
  "in-progress",
  "payment_pending",
];

function mapRequestRow(row) {
  return {
    requestId: row.request_id,
    user: row.user_name,
    issueType: row.issue_type,
    location: row.location,
    assignedTechnician: row.technician_name,
    status: row.status,
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

async function getRequestById(pool, requestId) {
  const [rows] = await pool.query(
    `SELECT id, status, technician_id
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
    const status = String(req.query?.status || "").trim().toLowerCase();
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

    if (status && status !== "all") {
      whereClauses.push("LOWER(COALESCE(sr.status, '')) = ?");
      values.push(status);
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
         COALESCE(t.name, 'Unassigned') AS technician_name,
         sr.status,
         CASE WHEN hp.request_id IS NULL THEN 'Normal' ELSE 'High' END AS priority,
         sr.created_at
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
        status: status || "all",
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
    const requestId = toPositiveInt(req.body?.requestId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
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
      `SELECT id, name
       FROM technicians
       WHERE id = ?
       LIMIT 1`,
      [technicianId]
    );
    if (technicianRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    await pool.execute(
      `UPDATE service_requests
       SET technician_id = ?,
           status = CASE WHEN LOWER(COALESCE(status, '')) IN ('pending', 'open') THEN 'assigned' ELSE status END,
           updated_at = NOW()
       WHERE id = ?`,
      [technicianId, requestId]
    );

    await logAction({
      pool,
      adminId: resolveAdminId(req),
      actionType: "manualAssignTechnician",
      targetId: requestId,
      metadata: { technicianId },
    });

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
    const requestId = toPositiveInt(req.body?.requestId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
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
    const requestId = toPositiveInt(req.body?.requestId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const reason = String(req.body?.reason || req.body?.note || "").trim();
    const requestedStatus = String(req.body?.status || "cancelled").trim().toLowerCase();

    if (!requestId) {
      return res.status(400).json({ error: "requestId is required." });
    }

    const finalStatus = requestedStatus === "completed" ? "completed" : "cancelled";

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

export { ACTIVE_REQUEST_STATES };
