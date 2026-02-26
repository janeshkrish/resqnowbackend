import { Router } from "express";
import { getPool } from "../db.js";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { adminExtendedLogAdminAction } from "../services/adminExtendedActionLogService.js";

const router = Router();

function adminExtendedResolveAdminId(req) {
  return String(req.adminExtended?.adminId || req.adminEmail || req.admin?.email || "admin");
}

function adminExtendedParseMetadata(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function adminExtendedToBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return fallback;
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.technicians] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.get("/technicians/performance-summary", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.technicians.technicianPerformanceSummary";
  try {
    const technicianId = Number(req.query.technicianId);
    const hasTechnicianFilter = Number.isInteger(technicianId) && technicianId > 0;

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         t.id,
         t.name,
         t.status,
         t.is_active,
         t.is_available,
         COUNT(sr.id) AS total_requests,
         SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 1 ELSE 0 END) AS completed_requests,
         SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('assigned', 'accepted', 'en-route', 'on-the-way', 'arrived', 'in-progress', 'payment_pending') THEN 1 ELSE 0 END) AS active_requests,
         ROUND(AVG(CASE
           WHEN sr.started_at IS NOT NULL AND sr.started_at >= sr.created_at
           THEN TIMESTAMPDIFF(MINUTE, sr.created_at, sr.started_at)
           ELSE NULL
         END), 2) AS avg_response_minutes,
         ROUND(IFNULL(SUM(CASE WHEN LOWER(COALESCE(p.status, '')) = 'completed' THEN p.amount ELSE 0 END), 0), 2) AS total_revenue
       FROM technicians t
       LEFT JOIN service_requests sr ON sr.technician_id = t.id
       LEFT JOIN payments p ON p.service_request_id = sr.id
       ${hasTechnicianFilter ? "WHERE t.id = ?" : ""}
       GROUP BY t.id, t.name, t.status, t.is_active, t.is_available
       ORDER BY completed_requests DESC, total_revenue DESC`,
      hasTechnicianFilter ? [technicianId] : []
    );

    const [visibilityRows] = await pool.query(
      `SELECT technician_id, metadata
       FROM technician_admin_notes
       WHERE note_type = 'visibility'
       ORDER BY id DESC`
    );

    const visibilityMap = new Map();
    for (const row of visibilityRows) {
      if (visibilityMap.has(String(row.technician_id))) continue;
      const metadata = adminExtendedParseMetadata(row.metadata);
      visibilityMap.set(String(row.technician_id), adminExtendedToBoolean(metadata?.isVisible, true));
    }

    const summary = rows.map((row) => ({
      technicianId: row.id,
      technicianName: row.name,
      status: row.status,
      isActive: Boolean(row.is_active),
      isAvailable: Boolean(row.is_available),
      isVisible: visibilityMap.has(String(row.id)) ? visibilityMap.get(String(row.id)) : true,
      totalRequests: Number(row.total_requests || 0),
      completedRequests: Number(row.completed_requests || 0),
      activeRequests: Number(row.active_requests || 0),
      avgResponseMinutes: Number(row.avg_response_minutes || 0),
      totalRevenue: Number(row.total_revenue || 0),
    }));

    return res.json({
      technicianPerformanceSummary: summary,
    });
  } catch (error) {
    console.error("[adminExtended.technicians] performance summary failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technician performance summary." });
  }
});

router.post("/technicians/:technicianId/toggle-visibility", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.technicians.toggleTechnicianVisibility";
  try {
    const technicianId = Number(req.params.technicianId);
    if (!Number.isInteger(technicianId) || technicianId <= 0) {
      return res.status(400).json({ error: "Invalid technicianId." });
    }

    const pool = await getPool();
    const [techRows] = await pool.query("SELECT id, name FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
    if (techRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const [latestVisibilityRows] = await pool.query(
      `SELECT metadata
       FROM technician_admin_notes
       WHERE technician_id = ? AND note_type = 'visibility'
       ORDER BY id DESC
       LIMIT 1`,
      [technicianId]
    );

    const latestVisibilityMetadata = adminExtendedParseMetadata(latestVisibilityRows?.[0]?.metadata);
    const currentVisibility = adminExtendedToBoolean(latestVisibilityMetadata?.isVisible, true);
    const requestedVisibility = req.body?.isVisible;
    const nextVisibility = requestedVisibility == null
      ? !currentVisibility
      : adminExtendedToBoolean(requestedVisibility, currentVisibility);

    const metadata = {
      isVisible: nextVisibility,
      previousIsVisible: currentVisibility,
      note: req.body?.note || null,
    };

    await pool.execute(
      `INSERT INTO technician_admin_notes (technician_id, admin_id, note_type, note_text, metadata)
       VALUES (?, ?, 'visibility', ?, ?)`,
      [
        technicianId,
        adminExtendedResolveAdminId(req),
        req.body?.note || "Visibility toggled by adminExtended.",
        JSON.stringify(metadata),
      ]
    );

    await adminExtendedLogAdminAction({
      adminId: adminExtendedResolveAdminId(req),
      actionType: "toggleTechnicianVisibility",
      targetType: "technician",
      targetId: technicianId,
      metadata,
    });

    return res.json({
      success: true,
      technicianId,
      technicianName: techRows[0].name,
      isVisible: nextVisibility,
      previousIsVisible: currentVisibility,
    });
  } catch (error) {
    console.error("[adminExtended.technicians] toggle visibility failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to toggle technician visibility." });
  }
});

router.post("/technicians/:technicianId/admin-note", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.technicians.adminNoteOnTechnician";
  try {
    const technicianId = Number(req.params.technicianId);
    const noteText = String(req.body?.note || "").trim();
    const noteType = String(req.body?.noteType || "note").trim().toLowerCase();

    if (!Number.isInteger(technicianId) || technicianId <= 0) {
      return res.status(400).json({ error: "Invalid technicianId." });
    }
    if (!noteText) {
      return res.status(400).json({ error: "note is required." });
    }

    const pool = await getPool();
    const [techRows] = await pool.query("SELECT id, name FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
    if (techRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const metadata = req.body?.metadata || null;
    const [insertResult] = await pool.execute(
      `INSERT INTO technician_admin_notes (technician_id, admin_id, note_type, note_text, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [technicianId, adminExtendedResolveAdminId(req), noteType || "note", noteText, JSON.stringify(metadata)]
    );

    await adminExtendedLogAdminAction({
      adminId: adminExtendedResolveAdminId(req),
      actionType: "adminNoteOnTechnician",
      targetType: "technician",
      targetId: technicianId,
      metadata: {
        noteType,
        noteId: insertResult.insertId,
      },
    });

    return res.status(201).json({
      success: true,
      noteId: insertResult.insertId,
      technicianId,
      technicianName: techRows[0].name,
      noteType,
      note: noteText,
      metadata,
    });
  } catch (error) {
    console.error("[adminExtended.technicians] admin note failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to add admin note." });
  }
});

router.get("/technicians/:technicianId/admin-notes", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.technicians.listAdminNotes";
  try {
    const technicianId = Number(req.params.technicianId);
    if (!Number.isInteger(technicianId) || technicianId <= 0) {
      return res.status(400).json({ error: "Invalid technicianId." });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT id, technician_id, admin_id, note_type, note_text, metadata, created_at
       FROM technician_admin_notes
       WHERE technician_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [technicianId, limit]
    );

    return res.json({
      technicianId,
      notes: rows.map((row) => ({
        id: row.id,
        technicianId: row.technician_id,
        adminId: row.admin_id,
        noteType: row.note_type,
        note: row.note_text,
        metadata: adminExtendedParseMetadata(row.metadata),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("[adminExtended.technicians] list notes failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technician admin notes." });
  }
});

export default router;

