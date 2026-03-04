import { getPool } from "../db.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { buildPagination, parseJson, resolveAdminId, toPositiveInt } from "./utils.js";

const ALLOWED_STATUS = new Set(["open", "assigned", "resolved"]);
const ALLOWED_SEVERITY = new Set(["low", "medium", "high", "critical"]);

async function addComplaintUpdate(pool, complaintId, updateType, noteText, metadata, createdBy) {
  await pool.execute(
    `INSERT INTO admin_complaint_updates (complaint_id, update_type, note_text, metadata, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [complaintId, updateType, noteText || null, JSON.stringify(metadata || null), createdBy]
  );
}

async function logAction(pool, adminId, actionType, complaintId, metadata = null) {
  await pool.execute(
    `INSERT INTO admin_actions_log (admin_id, action_type, target_type, target_id, metadata)
     VALUES (?, ?, 'complaint', ?, ?)`,
    [adminId, actionType, String(complaintId), JSON.stringify(metadata)]
  );
}

export async function createComplaint(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    const severityRaw = String(req.body?.severity || "medium").trim().toLowerCase();
    const severity = ALLOWED_SEVERITY.has(severityRaw) ? severityRaw : "medium";

    if (!title) {
      return res.status(400).json({ error: "Complaint title is required." });
    }

    const adminId = resolveAdminId(req);
    const createdBy = String(req.body?.userId || adminId).trim() || adminId;

    const pool = await getPool();
    const [result] = await pool.execute(
      `INSERT INTO admin_complaints (title, description, severity, status, assigned_admin_id, created_by)
       VALUES (?, ?, ?, 'open', NULL, ?)`,
      [title, description || null, severity, createdBy]
    );

    const complaintId = result.insertId;

    await addComplaintUpdate(pool, complaintId, "create", "Complaint created", { severity }, adminId);
    await logAction(pool, adminId, "createComplaint", complaintId, { severity });

    return res.status(201).json({
      success: true,
      complaintId,
      status: "open",
    });
  } catch (error) {
    console.error("[admin.complaints.create] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to create complaint." });
  }
}

export async function getComplaints(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const { page, limit, offset } = buildPagination(req.query);
    const status = String(req.query?.status || "").trim().toLowerCase();

    const whereClauses = [];
    const values = [];

    if (status && status !== "all" && ALLOWED_STATUS.has(status)) {
      whereClauses.push("c.status = ?");
      values.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         c.id AS complaint_id,
         c.title,
         c.description,
         c.created_by,
         c.assigned_admin_id,
         c.status,
         c.severity,
         c.created_at,
         c.updated_at
       FROM admin_complaints c
       ${whereSql}
       ORDER BY c.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM admin_complaints c
       ${whereSql}`,
      values
    );

    const total = Number(countRows?.[0]?.total || 0);

    return res.json({
      data: rows.map((row) => ({
        complaintId: row.complaint_id,
        complaintTitle: row.title,
        description: row.description,
        user: row.created_by,
        assignedAdmin: row.assigned_admin_id || "Unassigned",
        status: row.status,
        severity: row.severity,
        createdDate: row.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("[admin.complaints.list] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch complaints." });
  }
}

export async function assignComplaint(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const complaintId = toPositiveInt(req.body?.complaintId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const assignedAdminId = String(req.body?.assignedAdminId || "").trim();
    const note = String(req.body?.note || "").trim();

    if (!complaintId || !assignedAdminId) {
      return res.status(400).json({ error: "complaintId and assignedAdminId are required." });
    }

    const pool = await getPool();
    const [updateResult] = await pool.execute(
      `UPDATE admin_complaints
       SET assigned_admin_id = ?, status = 'assigned', updated_at = NOW()
       WHERE id = ?`,
      [assignedAdminId, complaintId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    const adminId = resolveAdminId(req);
    await addComplaintUpdate(pool, complaintId, "assign", note || "Complaint assigned", { assignedAdminId }, adminId);
    await logAction(pool, adminId, "assignComplaint", complaintId, { assignedAdminId });

    return res.json({
      success: true,
      complaintId,
      assignedAdminId,
      status: "assigned",
    });
  } catch (error) {
    console.error("[admin.complaints.assign] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to assign complaint." });
  }
}

export async function resolveComplaint(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const complaintId = toPositiveInt(req.body?.complaintId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const resolutionNote = String(req.body?.resolutionNote || req.body?.note || "").trim();

    if (!complaintId) {
      return res.status(400).json({ error: "complaintId is required." });
    }

    const pool = await getPool();
    const [updateResult] = await pool.execute(
      `UPDATE admin_complaints
       SET status = 'resolved', updated_at = NOW()
       WHERE id = ?`,
      [complaintId]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    const adminId = resolveAdminId(req);
    await addComplaintUpdate(
      pool,
      complaintId,
      "resolve",
      resolutionNote || "Complaint resolved",
      { resolvedAt: new Date().toISOString() },
      adminId
    );
    await logAction(pool, adminId, "resolveComplaint", complaintId, { resolutionNote: resolutionNote || null });

    return res.json({
      success: true,
      complaintId,
      status: "resolved",
    });
  } catch (error) {
    console.error("[admin.complaints.resolve] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to resolve complaint." });
  }
}

export async function addComplaintInternalNote(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const complaintId = toPositiveInt(req.body?.complaintId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const note = String(req.body?.note || "").trim();
    const metadata = req.body?.metadata || null;

    if (!complaintId || !note) {
      return res.status(400).json({ error: "complaintId and note are required." });
    }

    const pool = await getPool();
    const [complaintRows] = await pool.query(
      `SELECT id
       FROM admin_complaints
       WHERE id = ?
       LIMIT 1`,
      [complaintId]
    );

    if (complaintRows.length === 0) {
      return res.status(404).json({ error: "Complaint not found." });
    }

    const adminId = resolveAdminId(req);
    await addComplaintUpdate(pool, complaintId, "internal_note", note, metadata, adminId);
    await logAction(pool, adminId, "addComplaintInternalNote", complaintId, metadata);

    return res.status(201).json({
      success: true,
      complaintId,
      note,
    });
  } catch (error) {
    console.error("[admin.complaints.note] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to add internal note." });
  }
}
