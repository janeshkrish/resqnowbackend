import { Router } from "express";
import { getPool } from "../db.js";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { adminExtendedLogAdminAction } from "../services/adminExtendedActionLogService.js";

const router = Router();

const adminExtendedAllowedSeverity = new Set(["low", "medium", "high", "critical"]);
const adminExtendedAllowedStatus = new Set(["open", "assigned", "resolved"]);

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

async function adminExtendedInsertComplaintUpdate({
  pool,
  complaintId,
  updateType,
  noteText,
  metadata,
  createdBy,
}) {
  await pool.execute(
    `INSERT INTO admin_complaint_updates (complaint_id, update_type, note_text, metadata, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [complaintId, updateType, noteText || null, JSON.stringify(metadata || null), createdBy]
  );
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.complaints] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.get("/complaints", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.list";
  try {
    const statusFilter = String(req.query.status || "").trim().toLowerCase();
    const severityFilter = String(req.query.severity || "").trim().toLowerCase();
    const assignedFilter = String(req.query.assignedAdminId || "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const whereClauses = [];
    const values = [];
    if (adminExtendedAllowedStatus.has(statusFilter)) {
      whereClauses.push("status = ?");
      values.push(statusFilter);
    }
    if (adminExtendedAllowedSeverity.has(severityFilter)) {
      whereClauses.push("severity = ?");
      values.push(severityFilter);
    }
    if (assignedFilter) {
      whereClauses.push("assigned_admin_id = ?");
      values.push(assignedFilter);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         c.id,
         c.title,
         c.description,
         c.severity,
         c.status,
         c.assigned_admin_id,
         c.created_by,
         c.created_at,
         c.updated_at,
         (
           SELECT COUNT(*)
           FROM admin_complaint_updates cu
           WHERE cu.complaint_id = c.id
         ) AS updates_count
       FROM admin_complaints c
       ${whereSql}
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM admin_complaints
       ${whereSql}`,
      values
    );

    return res.json({
      complaints: rows,
      pagination: {
        limit,
        offset,
        total: Number(countRows?.[0]?.total || 0),
      },
    });
  } catch (error) {
    console.error("[adminExtended.complaints] list failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch complaints." });
  }
});

router.get("/complaints/:complaintId", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.detail";
  try {
    const complaintId = Number(req.params.complaintId);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: "Invalid complaintId." });
    }

    const pool = await getPool();
    const [complaintRows] = await pool.query(
      "SELECT * FROM admin_complaints WHERE id = ? LIMIT 1",
      [complaintId]
    );
    if (complaintRows.length === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    const [updateRows] = await pool.query(
      `SELECT id, complaint_id, update_type, note_text, metadata, created_by, created_at
       FROM admin_complaint_updates
       WHERE complaint_id = ?
       ORDER BY id ASC`,
      [complaintId]
    );

    return res.json({
      complaint: complaintRows[0],
      updates: updateRows.map((row) => ({
        ...row,
        metadata: adminExtendedParseMetadata(row.metadata),
      })),
    });
  } catch (error) {
    console.error("[adminExtended.complaints] detail failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch complaint details." });
  }
});

router.post("/complaints", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.createComplaint";
  try {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const severityRaw = String(req.body?.severity || "medium").trim().toLowerCase();
    const severity = adminExtendedAllowedSeverity.has(severityRaw) ? severityRaw : "medium";
    const adminId = adminExtendedResolveAdminId(req);

    if (!title) {
      return res.status(400).json({ error: "title is required." });
    }

    const pool = await getPool();
    const [insertResult] = await pool.execute(
      `INSERT INTO admin_complaints (title, description, severity, status, assigned_admin_id, created_by)
       VALUES (?, ?, ?, 'open', NULL, ?)`,
      [title, description || null, severity, adminId]
    );

    const complaintId = insertResult.insertId;
    await adminExtendedInsertComplaintUpdate({
      pool,
      complaintId,
      updateType: "create",
      noteText: "Complaint created",
      metadata: { title, severity },
      createdBy: adminId,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "createComplaint",
      targetType: "complaint",
      targetId: complaintId,
      metadata: { severity },
    });

    return res.status(201).json({
      success: true,
      complaintId,
      status: "open",
    });
  } catch (error) {
    console.error("[adminExtended.complaints] create failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to create complaint." });
  }
});

router.post("/complaints/:complaintId/assign", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.assignComplaint";
  try {
    const complaintId = Number(req.params.complaintId);
    const assignedAdminId = String(req.body?.assignedAdminId || "").trim();
    const note = String(req.body?.note || "").trim();
    const adminId = adminExtendedResolveAdminId(req);

    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: "Invalid complaintId." });
    }
    if (!assignedAdminId) {
      return res.status(400).json({ error: "assignedAdminId is required." });
    }

    const pool = await getPool();
    const [updateResult] = await pool.execute(
      `UPDATE admin_complaints
       SET status = 'assigned',
           assigned_admin_id = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [assignedAdminId, complaintId]
    );
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    await adminExtendedInsertComplaintUpdate({
      pool,
      complaintId,
      updateType: "assign",
      noteText: note || "Complaint assigned",
      metadata: { assignedAdminId },
      createdBy: adminId,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "assignComplaint",
      targetType: "complaint",
      targetId: complaintId,
      metadata: { assignedAdminId },
    });

    return res.json({
      success: true,
      complaintId,
      assignedAdminId,
      status: "assigned",
    });
  } catch (error) {
    console.error("[adminExtended.complaints] assign failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to assign complaint." });
  }
});

router.post("/complaints/:complaintId/resolve", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.resolveComplaint";
  try {
    const complaintId = Number(req.params.complaintId);
    const resolutionNote = String(req.body?.resolutionNote || "").trim();
    const adminId = adminExtendedResolveAdminId(req);

    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: "Invalid complaintId." });
    }

    const pool = await getPool();
    const [updateResult] = await pool.execute(
      `UPDATE admin_complaints
       SET status = 'resolved',
           updated_at = NOW()
       WHERE id = ?`,
      [complaintId]
    );
    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    await adminExtendedInsertComplaintUpdate({
      pool,
      complaintId,
      updateType: "resolve",
      noteText: resolutionNote || "Complaint resolved",
      metadata: { resolvedAt: new Date().toISOString() },
      createdBy: adminId,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "resolveComplaint",
      targetType: "complaint",
      targetId: complaintId,
      metadata: { resolutionNote: resolutionNote || null },
    });

    return res.json({
      success: true,
      complaintId,
      status: "resolved",
    });
  } catch (error) {
    console.error("[adminExtended.complaints] resolve failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to resolve complaint." });
  }
});

router.post("/complaints/:complaintId/internal-note", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.complaints.addInternalNote";
  try {
    const complaintId = Number(req.params.complaintId);
    const note = String(req.body?.note || "").trim();
    const metadata = req.body?.metadata || null;
    const adminId = adminExtendedResolveAdminId(req);

    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({ error: "Invalid complaintId." });
    }
    if (!note) {
      return res.status(400).json({ error: "note is required." });
    }

    const pool = await getPool();
    const [complaintRows] = await pool.query(
      "SELECT id FROM admin_complaints WHERE id = ? LIMIT 1",
      [complaintId]
    );
    if (complaintRows.length === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    await adminExtendedInsertComplaintUpdate({
      pool,
      complaintId,
      updateType: "internal_note",
      noteText: note,
      metadata,
      createdBy: adminId,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "addInternalNote",
      targetType: "complaint",
      targetId: complaintId,
      metadata,
    });

    return res.status(201).json({
      success: true,
      complaintId,
      note,
    });
  } catch (error) {
    console.error("[adminExtended.complaints] internal note failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to add complaint internal note." });
  }
});

export default router;

