import { getPool } from "../db.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { sendManualTechnicianLoginReminder } from "../services/technicianActivityService.js";
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
  "awaiting_payment",
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
    const loginStatusFilter = String(req.query?.loginStatus || "").trim().toLowerCase();
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

    if (["logged_in", "logged-in", "loggedin", "in"].includes(loginStatusFilter)) {
      whereClauses.push("(COALESCE(t.is_logged_in, 0) = 1 OR tls.current_session_login_at IS NOT NULL)");
    } else if (["logged_out", "logged-out", "loggedout", "out"].includes(loginStatusFilter)) {
      whereClauses.push("(COALESCE(t.is_logged_in, 0) = 0 AND tls.current_session_login_at IS NULL)");
    }

    if (visibilityFilter === "visible") {
      whereClauses.push("COALESCE(v.is_visible, 1) = 1");
    } else if (visibilityFilter === "hidden") {
      whereClauses.push("COALESCE(v.is_visible, 1) = 0");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const nowMs = Date.now();
    const [rows] = await pool.query(
      `SELECT
         t.id AS technician_id,
         t.name,
         t.email,
         COALESCE(t.rating, 0) AS rating,
         COALESCE(t.is_active, 0) AS is_active,
         COALESCE(t.is_available, 0) AS is_available,
         COALESCE(t.is_logged_in, 0) AS is_logged_in,
         t.last_login_at,
         t.last_logout_at,
         t.last_seen_at,
         t.login_reminder_sent_at,
         COALESCE(v.is_visible, 1) AS is_visible,
         COALESCE(n.note_text, '') AS admin_note,
         COALESCE(tls.current_session_login_at, NULL) AS current_session_login_at,
         tls.latest_login_at,
         tls.latest_logout_at,
         tls.latest_seen_at,
         COALESCE(tls.logged_seconds_24h, 0) AS logged_seconds_24h,
         COALESCE(tls.logged_seconds_total, 0) AS logged_seconds_total,
         COALESCE(SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN (${sqlPlaceholders(ACTIVE_JOB_STATUSES)}) THEN 1 ELSE 0 END), 0) AS active_jobs
       FROM technicians t
       LEFT JOIN service_requests sr ON sr.technician_id = t.id
       LEFT JOIN (
         SELECT
           technician_id,
           MAX(CASE WHEN logout_at IS NULL THEN login_at END) AS current_session_login_at,
           MAX(login_at) AS latest_login_at,
           MAX(logout_at) AS latest_logout_at,
           MAX(COALESCE(last_seen_at, logout_at, login_at)) AS latest_seen_at,
           SUM(
             CASE
               WHEN COALESCE(logout_at, NOW()) > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 THEN GREATEST(
                   TIMESTAMPDIFF(
                     SECOND,
                     GREATEST(login_at, DATE_SUB(NOW(), INTERVAL 24 HOUR)),
                     COALESCE(logout_at, NOW())
                   ),
                   0
                 )
               ELSE 0
             END
           ) AS logged_seconds_24h,
           SUM(GREATEST(TIMESTAMPDIFF(SECOND, login_at, COALESCE(logout_at, NOW())), 0)) AS logged_seconds_total
         FROM technician_login_sessions
         GROUP BY technician_id
       ) tls ON tls.technician_id = t.id
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
       GROUP BY
         t.id,
         t.name,
         t.email,
         t.rating,
         t.is_active,
         t.is_available,
         t.is_logged_in,
         t.last_login_at,
         t.last_logout_at,
         t.last_seen_at,
         t.login_reminder_sent_at,
         v.is_visible,
         n.note_text,
         tls.current_session_login_at,
         tls.latest_login_at,
         tls.latest_logout_at,
         tls.latest_seen_at,
         tls.logged_seconds_24h,
         tls.logged_seconds_total
       ORDER BY active_jobs DESC, t.name ASC
       LIMIT ? OFFSET ?`,
      [...ACTIVE_JOB_STATUSES, ...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM technicians t
       LEFT JOIN (
         SELECT
           technician_id,
           MAX(CASE WHEN logout_at IS NULL THEN login_at END) AS current_session_login_at
         FROM technician_login_sessions
         GROUP BY technician_id
       ) tls ON tls.technician_id = t.id
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
      data: rows.map((row) => {
        const hasOpenSession = Boolean(row.current_session_login_at);
        const isLoggedIn = Boolean(row.is_logged_in) || hasOpenSession;
        const lastLoginAt = row.last_login_at || row.latest_login_at || row.current_session_login_at || null;
        const lastLogoutAt = row.last_logout_at || row.latest_logout_at || null;
        const lastSeenAt =
          row.last_seen_at ||
          row.latest_seen_at ||
          row.current_session_login_at ||
          row.latest_login_at ||
          null;

        return {
        technicianId: row.technician_id,
        name: row.name,
        status: row.is_active && row.is_available ? "Online" : "Offline",
        loginStatus: isLoggedIn ? "Logged In" : "Logged Out",
        activeJobs: Number(row.active_jobs || 0),
        rating: Number(row.rating || 0),
        visibility: normalizeVisibility(row.is_visible, true),
        adminNote: row.admin_note || "",
        lastLoginAt,
        lastLogoutAt,
        lastSeenAt,
        currentSessionStartedAt: row.current_session_login_at || null,
        currentSessionHours: (() => {
          if (!row.current_session_login_at) return 0;
          const startedAtMs = new Date(row.current_session_login_at).getTime();
          if (!Number.isFinite(startedAtMs)) return 0;
          return Number(Math.max(0, (nowMs - startedAtMs) / 3600000).toFixed(2));
        })(),
        loggedInHours24h: Number((Number(row.logged_seconds_24h || 0) / 3600).toFixed(2)),
        loggedInHoursTotal: Number((Number(row.logged_seconds_total || 0) / 3600).toFixed(2)),
        inactivityAlertSentAt: row.login_reminder_sent_at || null,
      };
      }),
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

export async function sendTechnicianLoginReminder(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const technicianId = toPositiveInt(req.body?.technicianId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
    const message = String(req.body?.message || "").trim();

    if (!technicianId) {
      return res.status(400).json({ error: "technicianId is required." });
    }

    const adminId = resolveAdminId(req);
    const result = await sendManualTechnicianLoginReminder({
      technicianId,
      adminId,
      message: message || null,
    });

    const pool = await getPool();
    await logAction(pool, adminId, "sendTechnicianLoginReminder", technicianId, {
      manual: true,
      ...(message ? { message } : {}),
    });

    return res.status(201).json(result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 0);
    if (statusCode >= 400 && statusCode < 500) {
      return res.status(statusCode).json({ error: error?.message || "Failed to send login reminder." });
    }
    console.error("[admin.technicians.loginReminder] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to send login reminder." });
  }
}

export async function getTechnicianLoginActivity(req, res) {
  try {
    await ensureAdminExtendedSchema();

    const technicianId = toPositiveInt(req.params?.technicianId, 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
    const sessionLimit = toPositiveInt(req.query?.sessionLimit, 50, { min: 1, max: 500 });
    const alertLimit = toPositiveInt(req.query?.alertLimit, 50, { min: 1, max: 500 });

    if (!technicianId) {
      return res.status(400).json({ error: "Valid technicianId is required." });
    }

    const pool = await getPool();
    const nowMs = Date.now();

    const [technicianRows] = await pool.query(
      `SELECT
         t.id AS technician_id,
         t.name,
         t.email,
         t.status AS approval_status,
         COALESCE(t.is_active, 0) AS is_active,
         COALESCE(t.is_available, 0) AS is_available,
         COALESCE(t.is_logged_in, 0) AS is_logged_in,
         t.last_login_at,
         t.last_logout_at,
         t.last_seen_at,
         t.login_reminder_sent_at,
         COALESCE(v.is_visible, 1) AS is_visible,
         COALESCE(rollup.current_session_login_at, NULL) AS current_session_login_at,
         rollup.latest_login_at,
         rollup.latest_logout_at,
         rollup.latest_seen_at,
         COALESCE(rollup.logged_seconds_24h, 0) AS logged_seconds_24h,
         COALESCE(rollup.logged_seconds_7d, 0) AS logged_seconds_7d,
         COALESCE(rollup.logged_seconds_total, 0) AS logged_seconds_total
       FROM technicians t
       LEFT JOIN (
         SELECT
           technician_id,
           MAX(CASE WHEN logout_at IS NULL THEN login_at END) AS current_session_login_at,
           MAX(login_at) AS latest_login_at,
           MAX(logout_at) AS latest_logout_at,
           MAX(COALESCE(last_seen_at, logout_at, login_at)) AS latest_seen_at,
           SUM(
             CASE
               WHEN COALESCE(logout_at, NOW()) > DATE_SUB(NOW(), INTERVAL 24 HOUR)
                 THEN GREATEST(
                   TIMESTAMPDIFF(
                     SECOND,
                     GREATEST(login_at, DATE_SUB(NOW(), INTERVAL 24 HOUR)),
                     COALESCE(logout_at, NOW())
                   ),
                   0
                 )
               ELSE 0
             END
           ) AS logged_seconds_24h,
           SUM(
             CASE
               WHEN COALESCE(logout_at, NOW()) > DATE_SUB(NOW(), INTERVAL 7 DAY)
                 THEN GREATEST(
                   TIMESTAMPDIFF(
                     SECOND,
                     GREATEST(login_at, DATE_SUB(NOW(), INTERVAL 7 DAY)),
                     COALESCE(logout_at, NOW())
                   ),
                   0
                 )
               ELSE 0
             END
           ) AS logged_seconds_7d,
           SUM(GREATEST(TIMESTAMPDIFF(SECOND, login_at, COALESCE(logout_at, NOW())), 0)) AS logged_seconds_total
         FROM technician_login_sessions
         GROUP BY technician_id
       ) rollup ON rollup.technician_id = t.id
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
       WHERE t.id = ?
       LIMIT 1`,
      [technicianId]
    );

    const technician = technicianRows?.[0];
    if (!technician) {
      return res.status(404).json({ error: "Technician not found." });
    }

    const [sessionRows] = await pool.query(
      `SELECT
         id,
         login_at,
         last_seen_at,
         logout_at,
         ended_reason,
         duration_seconds,
         source,
         metadata,
         created_at,
         updated_at
       FROM technician_login_sessions
       WHERE technician_id = ?
       ORDER BY login_at DESC
       LIMIT ?`,
      [technicianId, sessionLimit]
    );

    const [alertRows] = await pool.query(
      `SELECT
         id,
         alert_type,
         status,
         message,
         metadata,
         sent_at,
         created_at
       FROM technician_activity_alerts
       WHERE technician_id = ?
       ORDER BY sent_at DESC, id DESC
       LIMIT ?`,
      [technicianId, alertLimit]
    );

    const hasOpenSession = Boolean(technician.current_session_login_at);
    const isLoggedIn = Boolean(technician.is_logged_in) || hasOpenSession;
    const lastLoginAt =
      technician.last_login_at ||
      technician.latest_login_at ||
      technician.current_session_login_at ||
      null;
    const lastLogoutAt = technician.last_logout_at || technician.latest_logout_at || null;
    const lastSeenAt =
      technician.last_seen_at ||
      technician.latest_seen_at ||
      technician.current_session_login_at ||
      technician.latest_login_at ||
      null;

    const currentSessionHours = (() => {
      if (!technician.current_session_login_at) return 0;
      const startedAtMs = new Date(technician.current_session_login_at).getTime();
      if (!Number.isFinite(startedAtMs)) return 0;
      return Number(Math.max(0, (nowMs - startedAtMs) / 3600000).toFixed(2));
    })();

    return res.json({
      technician: {
        technicianId: Number(technician.technician_id),
        name: technician.name || "Technician",
        email: technician.email || "",
        approvalStatus: String(technician.approval_status || "").trim().toLowerCase() || "pending",
        availabilityStatus:
          technician.is_active && technician.is_available ? "Online" : "Offline",
        loginStatus: isLoggedIn ? "Logged In" : "Logged Out",
        visibility: normalizeVisibility(technician.is_visible, true),
        lastLoginAt: lastLoginAt || null,
        lastLogoutAt: lastLogoutAt || null,
        lastSeenAt: lastSeenAt || null,
        inactivityAlertSentAt: technician.login_reminder_sent_at || null,
        currentSessionStartedAt: technician.current_session_login_at || null,
        currentSessionHours,
        loggedInHours24h: Number((Number(technician.logged_seconds_24h || 0) / 3600).toFixed(2)),
        loggedInHours7d: Number((Number(technician.logged_seconds_7d || 0) / 3600).toFixed(2)),
        loggedInHoursTotal: Number((Number(technician.logged_seconds_total || 0) / 3600).toFixed(2)),
      },
      sessions: (sessionRows || []).map((row) => {
        const loginMs = row.login_at ? new Date(row.login_at).getTime() : null;
        const logoutMs = row.logout_at ? new Date(row.logout_at).getTime() : null;
        const derivedSeconds =
          Number.isFinite(loginMs) && loginMs != null
            ? Math.max(0, Math.floor(((Number.isFinite(logoutMs) && logoutMs != null ? logoutMs : nowMs) - loginMs) / 1000))
            : 0;
        const baseDurationSeconds = Number(row.duration_seconds || 0);
        const durationSeconds = baseDurationSeconds > 0 ? baseDurationSeconds : derivedSeconds;

        return {
          sessionId: Number(row.id),
          loginAt: row.login_at || null,
          lastSeenAt: row.last_seen_at || null,
          logoutAt: row.logout_at || null,
          isActive: !row.logout_at,
          endedReason: row.ended_reason || null,
          source: row.source || null,
          durationSeconds: Number(durationSeconds),
          durationHours: Number((durationSeconds / 3600).toFixed(2)),
          metadata: parseJson(row.metadata, null),
          createdAt: row.created_at || null,
          updatedAt: row.updated_at || null,
        };
      }),
      alerts: (alertRows || []).map((row) => ({
        alertId: Number(row.id),
        alertType: row.alert_type || "unknown",
        status: row.status || "sent",
        message: row.message || "",
        sentAt: row.sent_at || null,
        createdAt: row.created_at || null,
        metadata: parseJson(row.metadata, null),
      })),
    });
  } catch (error) {
    console.error("[admin.technicians.loginActivity] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technician login activity." });
  }
}
