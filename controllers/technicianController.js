import { getPool } from "../db.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { buildPagination, likeFilter, parseJson, resolveAdminId, toPositiveInt } from "./utils.js";

const ACTIVE_JOB_STATUSES = [
  "assigned",
  "accepted",
  "processing",
  "en-route",
  "on-the-way",
  "arrived",
  "in_progress",
  "in-progress",
  "payment_pending",
];

function sqlPlaceholders(values) {
  return values.map(() => "?").join(", ");
}

function normalizeVisibility(value, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return fallback;
}

async function logAction(pool, adminId, actionType, targetId, metadata = null) {
  await pool.execute(
    `INSERT INTO admin_actions_log (admin_id, action_type, target_type, target_id, metadata)
     VALUES (?, ?, 'technician', ?, ?)`,
    [adminId, actionType, String(targetId), JSON.stringify(metadata)]
  );
}

export async function getTechnicians(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const { page, limit, offset } = buildPagination(req.query);
    const search = String(req.query?.search || "").trim();
    const statusFilter = String(req.query?.status || "").trim().toLowerCase();
    const visibilityFilter = String(req.query?.visibility || "").trim().toLowerCase();

    const whereClauses = [];
    const values = [];

    if (search) {
      const like = likeFilter(search.toLowerCase());
      whereClauses.push(`(
        CAST(t.id AS CHAR) LIKE ?
        OR LOWER(COALESCE(t.name, '')) LIKE ?
        OR LOWER(COALESCE(t.email, '')) LIKE ?
      )`);
      values.push(like, like, like);
    }

    if (statusFilter === "online") {
      whereClauses.push("COALESCE(t.is_active, 0) = 1 AND COALESCE(t.is_available, 0) = 1");
    } else if (statusFilter === "offline") {
      whereClauses.push("NOT (COALESCE(t.is_active, 0) = 1 AND COALESCE(t.is_available, 0) = 1)");
    }

    if (visibilityFilter === "visible") {
      whereClauses.push("COALESCE(v.is_visible, 1) = 1");
    } else if (visibilityFilter === "hidden") {
      whereClauses.push("COALESCE(v.is_visible, 1) = 0");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         t.id AS technician_id,
         t.name,
         t.email,
         COALESCE(t.rating, 0) AS rating,
         COALESCE(t.is_active, 0) AS is_active,
         COALESCE(t.is_available, 0) AS is_available,
         COALESCE(v.is_visible, 1) AS is_visible,
         COALESCE(n.note_text, '') AS admin_note,
         COALESCE(SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN (${sqlPlaceholders(ACTIVE_JOB_STATUSES)}) THEN 1 ELSE 0 END), 0) AS active_jobs
       FROM technicians t
       LEFT JOIN service_requests sr ON sr.technician_id = t.id
       LEFT JOIN (
         SELECT tan.technician_id,
                JSON_EXTRACT(tan.metadata, '$.isVisible') AS is_visible
         FROM technician_admin_notes tan
         INNER JOIN (
           SELECT technician_id, MAX(id) AS max_id
           FROM technician_admin_notes
           WHERE note_type = 'visibility'
           GROUP BY technician_id
         ) latest ON latest.max_id = tan.id
       ) v ON v.technician_id = t.id
       LEFT JOIN (
         SELECT tan.technician_id,
                tan.note_text
         FROM technician_admin_notes tan
         INNER JOIN (
           SELECT technician_id, MAX(id) AS max_id
           FROM technician_admin_notes
           WHERE note_type <> 'visibility'
           GROUP BY technician_id
         ) latest ON latest.max_id = tan.id
       ) n ON n.technician_id = t.id
       ${whereSql}
       GROUP BY t.id, t.name, t.email, t.rating, t.is_active, t.is_available, v.is_visible, n.note_text
       ORDER BY active_jobs DESC, t.name ASC
       LIMIT ? OFFSET ?`,
      [...ACTIVE_JOB_STATUSES, ...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM technicians t
       LEFT JOIN (
         SELECT tan.technician_id,
                JSON_EXTRACT(tan.metadata, '$.isVisible') AS is_visible
         FROM technician_admin_notes tan
         INNER JOIN (
           SELECT technician_id, MAX(id) AS max_id
           FROM technician_admin_notes
           WHERE note_type = 'visibility'
           GROUP BY technician_id
         ) latest ON latest.max_id = tan.id
       ) v ON v.technician_id = t.id
       ${whereSql}`,
      values
    );

    const total = Number(countRows?.[0]?.total || 0);

    return res.json({
      data: rows.map((row) => ({
        technicianId: row.technician_id,
        name: row.name,
        status: row.is_active && row.is_available ? "Online" : "Offline",
        activeJobs: Number(row.active_jobs || 0),
        rating: Number(row.rating || 0),
        visibility: normalizeVisibility(row.is_visible, true),
        adminNote: row.admin_note || "",
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("[admin.technicians.list] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technicians." });
  }
}

export async function toggleTechnicianVisibility(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const technicianId = toPositiveInt(req.body?.technicianId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const requestedVisibility = req.body?.isVisible;
    const note = String(req.body?.note || "").trim();

    if (!technicianId) {
      return res.status(400).json({ error: "technicianId is required." });
    }

    const pool = await getPool();
    const [techRows] = await pool.query(
      `SELECT id, name
       FROM technicians
       WHERE id = ?
       LIMIT 1`,
      [technicianId]
    );
    if (techRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const [visibilityRows] = await pool.query(
      `SELECT metadata
       FROM technician_admin_notes
       WHERE technician_id = ? AND note_type = 'visibility'
       ORDER BY id DESC
       LIMIT 1`,
      [technicianId]
    );

    const latestMetadata = parseJson(visibilityRows?.[0]?.metadata, null);
    const currentVisibility = normalizeVisibility(latestMetadata?.isVisible, true);
    const isVisible =
      requestedVisibility == null
        ? !currentVisibility
        : normalizeVisibility(requestedVisibility, currentVisibility);

    const metadata = {
      isVisible,
      previousIsVisible: currentVisibility,
      updatedAt: new Date().toISOString(),
    };

    await pool.execute(
      `INSERT INTO technician_admin_notes (technician_id, admin_id, note_type, note_text, metadata)
       VALUES (?, ?, 'visibility', ?, ?)`,
      [
        technicianId,
        resolveAdminId(req),
        note || "Visibility updated by admin.",
        JSON.stringify(metadata),
      ]
    );

    await logAction(pool, resolveAdminId(req), "toggleTechnicianVisibility", technicianId, metadata);

    return res.json({
      success: true,
      technicianId,
      isVisible,
    });
  } catch (error) {
    console.error("[admin.technicians.toggle] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to update technician visibility." });
  }
}

export async function addTechnicianNote(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const technicianId = toPositiveInt(req.body?.technicianId, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
    const note = String(req.body?.note || "").trim();

    if (!technicianId || !note) {
      return res.status(400).json({ error: "technicianId and note are required." });
    }

    const pool = await getPool();
    const [techRows] = await pool.query(
      `SELECT id
       FROM technicians
       WHERE id = ?
       LIMIT 1`,
      [technicianId]
    );
    if (techRows.length === 0) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const [result] = await pool.execute(
      `INSERT INTO technician_admin_notes (technician_id, admin_id, note_type, note_text, metadata)
       VALUES (?, ?, 'note', ?, NULL)`,
      [technicianId, resolveAdminId(req), note]
    );

    await logAction(pool, resolveAdminId(req), "addTechnicianNote", technicianId, {
      noteId: result.insertId,
    });

    return res.status(201).json({
      success: true,
      noteId: result.insertId,
      technicianId,
      note,
    });
  } catch (error) {
    console.error("[admin.technicians.note] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to add technician note." });
  }
}
