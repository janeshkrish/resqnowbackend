import { getPool } from "../db.js";
import * as mail from "./mailer.js";
import { socketService } from "./socket.js";

const DEFAULT_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 45;
const DEFAULT_INACTIVITY_REMINDER_MINUTES = 12 * 60;
const DEFAULT_REMINDER_COOLDOWN_MINUTES = 12 * 60;
const DEFAULT_REMINDER_BATCH_SIZE = 100;

const monitorState = {
  timer: null,
  running: false,
  lastRunAt: null,
  lastError: null,
};

let activeMonitorCyclePromise = null;

function toPositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function normalizeSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return normalized.slice(0, 64);
}

function safeJsonStringify(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function roundHoursFromSeconds(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(((parsed / 3600) + Number.EPSILON) * 100) / 100;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getMonitorIntervalMs() {
  return toPositiveInt(
    process.env.TECHNICIAN_ACTIVITY_MONITOR_INTERVAL_MS,
    DEFAULT_MONITOR_INTERVAL_MS,
    { min: 60 * 1000, max: 60 * 60 * 1000 }
  );
}

function getIdleTimeoutMinutes() {
  return toPositiveInt(
    process.env.TECHNICIAN_ACTIVITY_IDLE_TIMEOUT_MINUTES,
    DEFAULT_IDLE_TIMEOUT_MINUTES,
    { min: 5, max: 7 * 24 * 60 }
  );
}

function getInactivityReminderMinutes() {
  return toPositiveInt(
    process.env.TECHNICIAN_LOGIN_REMINDER_INACTIVITY_MINUTES,
    DEFAULT_INACTIVITY_REMINDER_MINUTES,
    { min: 30, max: 30 * 24 * 60 }
  );
}

function getReminderCooldownMinutes() {
  return toPositiveInt(
    process.env.TECHNICIAN_LOGIN_REMINDER_COOLDOWN_MINUTES,
    DEFAULT_REMINDER_COOLDOWN_MINUTES,
    { min: 30, max: 30 * 24 * 60 }
  );
}

function getReminderBatchSize() {
  return toPositiveInt(
    process.env.TECHNICIAN_LOGIN_REMINDER_BATCH_SIZE,
    DEFAULT_REMINDER_BATCH_SIZE,
    { min: 1, max: 500 }
  );
}

function isMonitorEnabled() {
  return toBoolean(process.env.TECHNICIAN_ACTIVITY_MONITOR_ENABLED, true);
}

async function fetchTechnicianActivitySnapshot(pool, technicianId) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) return null;

  const [rows] = await pool.query(
    `SELECT
       t.id AS technician_id,
       COALESCE(t.is_logged_in, 0) AS is_logged_in,
       t.last_login_at,
       t.last_logout_at,
       t.last_seen_at,
       t.login_reminder_sent_at,
       open_session.login_at AS current_session_login_at,
       COALESCE(session_rollup.logged_seconds_24h, 0) AS logged_seconds_24h,
       COALESCE(session_rollup.logged_seconds_total, 0) AS logged_seconds_total
     FROM technicians t
     LEFT JOIN (
       SELECT open_ref.technician_id, s.login_at
       FROM (
         SELECT technician_id, MAX(id) AS session_id
         FROM technician_login_sessions
         WHERE logout_at IS NULL
         GROUP BY technician_id
       ) open_ref
       JOIN technician_login_sessions s ON s.id = open_ref.session_id
     ) open_session ON open_session.technician_id = t.id
     LEFT JOIN (
       SELECT
         technician_id,
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
     ) session_rollup ON session_rollup.technician_id = t.id
     WHERE t.id = ?
     LIMIT 1`,
    [parsedTechnicianId]
  );

  const row = rows?.[0];
  if (!row) return null;

  const nowMs = Date.now();
  const currentSessionStartMs = row.current_session_login_at
    ? new Date(row.current_session_login_at).getTime()
    : null;
  const currentSessionSeconds =
    Number.isFinite(currentSessionStartMs) && currentSessionStartMs != null
      ? Math.max(0, Math.floor((nowMs - currentSessionStartMs) / 1000))
      : 0;

  const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
  const inactiveMinutes =
    Number.isFinite(lastSeenMs) && lastSeenMs != null
      ? Math.max(0, Math.round((((nowMs - lastSeenMs) / 60000) + Number.EPSILON) * 10) / 10)
      : null;

  return {
    technicianId: Number(row.technician_id),
    isLoggedIn: Boolean(row.is_logged_in),
    lastLoginAt: toIsoOrNull(row.last_login_at),
    lastLogoutAt: toIsoOrNull(row.last_logout_at),
    lastSeenAt: toIsoOrNull(row.last_seen_at),
    currentSessionStartedAt: toIsoOrNull(row.current_session_login_at),
    currentSessionHours: roundHoursFromSeconds(currentSessionSeconds),
    loggedInHours24h: roundHoursFromSeconds(row.logged_seconds_24h),
    loggedInHoursTotal: roundHoursFromSeconds(row.logged_seconds_total),
    inactiveMinutes,
    loginReminderSentAt: toIsoOrNull(row.login_reminder_sent_at),
  };
}

async function broadcastActivityEvent({ eventType, technicianId, reason = null, source = null, includeSnapshot = false }) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) return null;

  let snapshot = null;
  if (includeSnapshot) {
    try {
      const pool = await getPool();
      snapshot = await fetchTechnicianActivitySnapshot(pool, parsedTechnicianId);
    } catch (error) {
      console.error("[TechnicianActivity] failed to load snapshot for broadcast:", error?.message || error);
    }
  }

  socketService.broadcast("admin:technician_activity_update", {
    eventType,
    technicianId: parsedTechnicianId,
    reason: reason || null,
    source: source || null,
    at: new Date().toISOString(),
    ...(snapshot ? { snapshot } : {}),
  });

  return snapshot;
}

export async function getTechnicianActivitySnapshot(technicianId) {
  const pool = await getPool();
  return fetchTechnicianActivitySnapshot(pool, technicianId);
}

export async function markTechnicianLogin({ technicianId, source = "unknown", metadata = null }) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) return null;

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE technician_login_sessions
       SET logout_at = COALESCE(last_seen_at, NOW()),
           ended_reason = 'new_login',
           duration_seconds = GREATEST(TIMESTAMPDIFF(SECOND, login_at, COALESCE(last_seen_at, NOW())), 0),
           updated_at = NOW()
       WHERE technician_id = ?
         AND logout_at IS NULL`,
      [parsedTechnicianId]
    );

    await conn.execute(
      `INSERT INTO technician_login_sessions (
         technician_id,
         login_at,
         last_seen_at,
         source,
         metadata
       ) VALUES (?, NOW(), NOW(), ?, ?)`,
      [parsedTechnicianId, normalizeSource(source), safeJsonStringify(metadata)]
    );

    await conn.execute(
      `UPDATE technicians
       SET is_logged_in = TRUE,
           last_login_at = NOW(),
           last_seen_at = NOW(),
           login_reminder_sent_at = NULL
       WHERE id = ?`,
      [parsedTechnicianId]
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return broadcastActivityEvent({
    eventType: "login",
    technicianId: parsedTechnicianId,
    source: normalizeSource(source),
    includeSnapshot: true,
  });
}

export async function markTechnicianHeartbeat({
  technicianId,
  source = "unknown",
  metadata = null,
  createSessionIfMissing = true,
}) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) return null;

  const normalizedSource = normalizeSource(source);
  const pool = await getPool();
  const conn = await pool.getConnection();
  let createdSession = false;
  let hasOpenSession = false;

  try {
    await conn.beginTransaction();

    const [openRows] = await conn.query(
      `SELECT id
       FROM technician_login_sessions
       WHERE technician_id = ?
         AND logout_at IS NULL
       ORDER BY login_at DESC
       LIMIT 1`,
      [parsedTechnicianId]
    );

    if (Array.isArray(openRows) && openRows.length > 0) {
      hasOpenSession = true;
      await conn.execute(
        `UPDATE technician_login_sessions
         SET last_seen_at = NOW(),
             source = ?,
             metadata = COALESCE(?, metadata),
             updated_at = NOW()
         WHERE id = ?`,
        [normalizedSource, safeJsonStringify(metadata), openRows[0].id]
      );
    } else if (createSessionIfMissing) {
      createdSession = true;
      hasOpenSession = true;
      await conn.execute(
        `INSERT INTO technician_login_sessions (
           technician_id,
           login_at,
           last_seen_at,
           source,
           metadata
         ) VALUES (?, NOW(), NOW(), ?, ?)`,
        [parsedTechnicianId, normalizedSource, safeJsonStringify(metadata)]
      );
    }

    if (hasOpenSession && createdSession) {
      await conn.execute(
        `UPDATE technicians
         SET is_logged_in = TRUE,
             last_login_at = NOW(),
             last_seen_at = NOW(),
             login_reminder_sent_at = NULL
         WHERE id = ?`,
        [parsedTechnicianId]
      );
    } else if (hasOpenSession) {
      await conn.execute(
        `UPDATE technicians
         SET last_seen_at = NOW(),
             is_logged_in = TRUE,
             login_reminder_sent_at = NULL
         WHERE id = ?`,
        [parsedTechnicianId]
      );
    } else {
      await conn.execute(
        `UPDATE technicians
         SET last_seen_at = NOW()
         WHERE id = ?`,
        [parsedTechnicianId]
      );
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  if (!hasOpenSession) {
    return null;
  }

  const eventType = createdSession ? "login" : "heartbeat";
  return broadcastActivityEvent({
    eventType,
    technicianId: parsedTechnicianId,
    source: normalizedSource,
    includeSnapshot: createdSession,
  });
}

export async function markTechnicianLogout({ technicianId, reason = "logout", source = "unknown" }) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) return null;

  const normalizedReason = String(reason || "logout").trim().slice(0, 64) || "logout";
  const normalizedSource = normalizeSource(source);
  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE technician_login_sessions
       SET logout_at = NOW(),
           last_seen_at = NOW(),
           ended_reason = ?,
           duration_seconds = GREATEST(TIMESTAMPDIFF(SECOND, login_at, NOW()), 0),
           updated_at = NOW()
       WHERE technician_id = ?
         AND logout_at IS NULL`,
      [normalizedReason, parsedTechnicianId]
    );

    await conn.execute(
      `UPDATE technicians
       SET is_logged_in = FALSE,
           is_active = FALSE,
           is_available = FALSE,
           last_logout_at = NOW(),
           last_seen_at = NOW()
       WHERE id = ?`,
      [parsedTechnicianId]
    );

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  socketService.broadcast("technician:status_update", {
    technicianId: parsedTechnicianId,
    active: false,
  });

  return broadcastActivityEvent({
    eventType: "logout",
    technicianId: parsedTechnicianId,
    source: normalizedSource,
    reason: normalizedReason,
    includeSnapshot: true,
  });
}

async function expireIdleSessions(pool) {
  const idleTimeoutMinutes = getIdleTimeoutMinutes();
  const [rows] = await pool.query(
    `SELECT id, technician_id
     FROM technician_login_sessions
     WHERE logout_at IS NULL
       AND TIMESTAMPDIFF(MINUTE, COALESCE(last_seen_at, login_at), NOW()) >= ?
     LIMIT 500`,
    [idleTimeoutMinutes]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return { expiredSessions: 0, technicianIds: [] };
  }

  const sessionIds = rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const technicianIds = Array.from(
    new Set(
      rows
        .map((row) => Number(row.technician_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  if (sessionIds.length === 0 || technicianIds.length === 0) {
    return { expiredSessions: 0, technicianIds: [] };
  }

  const sessionPlaceholders = sessionIds.map(() => "?").join(", ");
  await pool.query(
    `UPDATE technician_login_sessions
     SET logout_at = COALESCE(last_seen_at, NOW()),
         ended_reason = 'idle_timeout',
         duration_seconds = GREATEST(TIMESTAMPDIFF(SECOND, login_at, COALESCE(last_seen_at, NOW())), 0),
         updated_at = NOW()
     WHERE id IN (${sessionPlaceholders})`,
    sessionIds
  );

  await Promise.allSettled(
    technicianIds.map((technicianId) =>
      pool.execute(
        `UPDATE technicians
         SET is_logged_in = FALSE,
             is_active = FALSE,
             is_available = FALSE,
             last_logout_at = COALESCE(
               (
                 SELECT MAX(COALESCE(logout_at, last_seen_at, login_at))
                 FROM technician_login_sessions
                 WHERE technician_id = ?
               ),
               NOW()
             )
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM technician_login_sessions
             WHERE technician_id = ?
               AND logout_at IS NULL
           )`,
        [technicianId, technicianId, technicianId]
      )
    )
  );

  return {
    expiredSessions: sessionIds.length,
    technicianIds,
  };
}

async function dispatchTechnicianLoginReminder(
  pool,
  {
    technicianId,
    technicianName,
    technicianEmail,
    inactivityMinutes = null,
    lastSeenAt = null,
    alertType = "login_inactivity_reminder",
    title = "Please log in to ResQNow",
    message,
    adminId = null,
  }
) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) {
    throw new Error("Invalid technicianId for login reminder.");
  }

  const normalizedAlertType = String(alertType || "login_inactivity_reminder")
    .trim()
    .toLowerCase()
    .slice(0, 64);
  const normalizedTitle = String(title || "Please log in to ResQNow").trim();
  const normalizedMessage = String(
    message ||
      "You have been inactive for a while. Log in to keep receiving job requests."
  ).trim();

  const payload = {
    technicianId: parsedTechnicianId,
    title: normalizedTitle,
    message: normalizedMessage,
    inactivityMinutes:
      inactivityMinutes == null ? null : Math.max(0, Number(inactivityMinutes) || 0),
    lastSeenAt: toIsoOrNull(lastSeenAt),
    type: normalizedAlertType,
    priority: "HIGH",
    adminId: adminId ? String(adminId) : null,
    createdAt: new Date().toISOString(),
  };

  try {
    socketService.notifyTechnician(parsedTechnicianId, "technician:login_reminder", payload);
  } catch (error) {
    console.error("[TechnicianActivity] reminder socket/push failed:", error?.message || error);
  }

  const recipientEmail = String(technicianEmail || "").trim();
  if (recipientEmail) {
    try {
      await mail.sendMail({
        to: recipientEmail,
        subject: normalizedTitle,
        html: `Hello ${String(technicianName || "Technician")},<br/><br/>${normalizedMessage}<br/><br/>Regards,<br/>ResQNow Team`,
      });
    } catch (error) {
      console.error("[TechnicianActivity] reminder email failed:", error?.message || error);
    }
  }

  await pool.execute(
    `INSERT INTO technician_activity_alerts (
       technician_id,
       alert_type,
       status,
       message,
       metadata,
       sent_at
     ) VALUES (?, ?, 'sent', ?, ?, NOW())`,
    [parsedTechnicianId, normalizedAlertType, normalizedMessage, safeJsonStringify(payload)]
  );

  await pool.execute(
    `UPDATE technicians
     SET login_reminder_sent_at = NOW()
     WHERE id = ?`,
    [parsedTechnicianId]
  );

  socketService.broadcast("admin:technician_inactivity_alert", payload);
  return payload;
}

async function sendInactivityLoginReminders(pool) {
  const inactivityMinutes = getInactivityReminderMinutes();
  const cooldownMinutes = getReminderCooldownMinutes();
  const batchSize = getReminderBatchSize();

  const [rows] = await pool.query(
    `SELECT
       id,
       name,
       email,
       last_seen_at,
       last_login_at,
       last_logout_at,
       login_reminder_sent_at
     FROM technicians
     WHERE LOWER(COALESCE(status, '')) = 'approved'
       AND COALESCE(is_logged_in, 0) = 0
       AND COALESCE(last_seen_at, last_logout_at, last_login_at, created_at) <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND (
         login_reminder_sent_at IS NULL
         OR login_reminder_sent_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       )
     ORDER BY COALESCE(last_seen_at, last_logout_at, last_login_at, created_at) ASC
     LIMIT ?`,
    [inactivityMinutes, cooldownMinutes, batchSize]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return 0;
  }

  let sentCount = 0;
  for (const row of rows) {
    const technicianId = Number(row.id);
    if (!Number.isInteger(technicianId) || technicianId <= 0) continue;

    const message =
      `You have been inactive for more than ${Math.round(inactivityMinutes / 60)} hours. ` +
      "Log in to keep receiving job requests.";

    await dispatchTechnicianLoginReminder(pool, {
      technicianId,
      technicianName: row.name,
      technicianEmail: row.email,
      inactivityMinutes,
      lastSeenAt: row.last_seen_at || row.last_logout_at || row.last_login_at,
      alertType: "login_inactivity_reminder",
      title: "Please log in to ResQNow",
      message,
    });
    sentCount += 1;
  }

  return sentCount;
}

export async function sendManualTechnicianLoginReminder({
  technicianId,
  adminId = null,
  message = null,
}) {
  const parsedTechnicianId = Number(technicianId);
  if (!Number.isInteger(parsedTechnicianId) || parsedTechnicianId <= 0) {
    const error = new Error("technicianId must be a positive integer.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT
       id,
       name,
       email,
       status,
       COALESCE(is_logged_in, 0) AS is_logged_in,
       last_seen_at,
       last_login_at,
       last_logout_at
     FROM technicians
     WHERE id = ?
     LIMIT 1`,
    [parsedTechnicianId]
  );

  const technician = rows?.[0];
  if (!technician) {
    const error = new Error("Technician not found.");
    error.statusCode = 404;
    throw error;
  }

  if (String(technician.status || "").trim().toLowerCase() !== "approved") {
    const error = new Error("Login reminders can only be sent to approved technicians.");
    error.statusCode = 409;
    throw error;
  }

  if (Boolean(technician.is_logged_in)) {
    const error = new Error("Technician is already logged in.");
    error.statusCode = 409;
    throw error;
  }

  const referenceDate =
    technician.last_seen_at || technician.last_logout_at || technician.last_login_at || null;
  const referenceMs = referenceDate ? new Date(referenceDate).getTime() : null;
  const inactivityMinutes =
    Number.isFinite(referenceMs) && referenceMs != null
      ? Math.max(0, Math.round((Date.now() - referenceMs) / 60000))
      : null;

  const reminderMessage = String(
    message ||
      "You have pending opportunities on ResQNow. Please log in to the technician portal."
  ).trim();

  const payload = await dispatchTechnicianLoginReminder(pool, {
    technicianId: parsedTechnicianId,
    technicianName: technician.name,
    technicianEmail: technician.email,
    inactivityMinutes,
    lastSeenAt: referenceDate,
    alertType: "manual_login_reminder",
    title: "Admin Reminder: Please log in to ResQNow",
    message: reminderMessage,
    adminId: adminId || null,
  });

  return {
    success: true,
    technicianId: parsedTechnicianId,
    technicianName: technician.name,
    payload,
  };
}

async function executeMonitorCycle({ trigger = "scheduler" } = {}) {
  const pool = await getPool();
  const expiredResult = await expireIdleSessions(pool);
  const remindersSent = await sendInactivityLoginReminders(pool);

  for (const technicianId of expiredResult.technicianIds) {
    socketService.broadcast("technician:status_update", {
      technicianId,
      active: false,
    });
    await broadcastActivityEvent({
      eventType: "logout",
      technicianId,
      reason: "idle_timeout",
      includeSnapshot: true,
    });
  }

  const result = {
    trigger,
    expiredSessions: expiredResult.expiredSessions,
    remindersSent,
    at: new Date().toISOString(),
  };

  socketService.broadcast("admin:technician_activity_cycle", result);
  return result;
}

export async function runTechnicianActivityMonitorCycle({ trigger = "scheduler" } = {}) {
  if (activeMonitorCyclePromise) {
    return activeMonitorCyclePromise;
  }

  monitorState.running = true;
  activeMonitorCyclePromise = (async () => {
    try {
      const result = await executeMonitorCycle({ trigger });
      monitorState.lastRunAt = result.at;
      monitorState.lastError = null;
      return result;
    } catch (error) {
      monitorState.lastError = error?.message || "Technician activity monitor failed.";
      throw error;
    } finally {
      monitorState.running = false;
      activeMonitorCyclePromise = null;
    }
  })();

  return activeMonitorCyclePromise;
}

export function startTechnicianActivityMonitor() {
  if (!isMonitorEnabled()) {
    console.log("[TechnicianActivity] monitor is disabled.");
    return;
  }
  if (monitorState.timer) return;

  const intervalMs = getMonitorIntervalMs();
  const tick = async () => {
    try {
      await runTechnicianActivityMonitorCycle({ trigger: "scheduler" });
    } catch (error) {
      console.error("[TechnicianActivity] monitor tick failed:", error?.message || error);
    }
  };

  monitorState.timer = setInterval(tick, intervalMs);
  void tick();
}

export function stopTechnicianActivityMonitor() {
  if (!monitorState.timer) return;
  clearInterval(monitorState.timer);
  monitorState.timer = null;
}

export function getTechnicianActivityMonitorState() {
  return {
    running: monitorState.running,
    intervalMs: getMonitorIntervalMs(),
    idleTimeoutMinutes: getIdleTimeoutMinutes(),
    inactivityReminderMinutes: getInactivityReminderMinutes(),
    reminderCooldownMinutes: getReminderCooldownMinutes(),
    lastRunAt: monitorState.lastRunAt,
    lastError: monitorState.lastError,
    enabled: isMonitorEnabled(),
  };
}
