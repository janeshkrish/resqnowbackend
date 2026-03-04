import { getPool } from "../db.js";
import {
  adminExtendedEmergencyMessage,
  adminExtendedSystemAnnouncement,
  adminExtendedTechnicianBroadcast,
} from "../services/adminExtendedNotifier.js";
import { resolveAdminId } from "./utils.js";

function normalizeTechnicianIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function logAction(pool, adminId, actionType, metadata = null) {
  await pool.execute(
    `INSERT INTO admin_actions_log (admin_id, action_type, target_type, target_id, metadata)
     VALUES (?, ?, 'broadcast', 'notifications', ?)`,
    [adminId, actionType, JSON.stringify(metadata)]
  );
}

export async function broadcastNotification(req, res) {
  try {
    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();
    const type = String(req.body?.type || "system").trim().toLowerCase();
    const technicianIds = normalizeTechnicianIds(req.body?.technicianIds);

    if (!title || !message) {
      return res.status(400).json({ error: "title and message are required." });
    }

    const adminId = resolveAdminId(req);

    let payload;
    let notificationType = "system_announcement";

    if (type === "technician") {
      notificationType = "technician_broadcast";
      payload = adminExtendedTechnicianBroadcast({
        adminId,
        title,
        message,
        technicianIds,
        metadata: req.body?.metadata || null,
      });
    } else if (type === "emergency") {
      notificationType = "emergency_message";
      payload = adminExtendedEmergencyMessage({
        adminId,
        title,
        message,
        metadata: req.body?.metadata || null,
      });
    } else {
      payload = adminExtendedSystemAnnouncement({
        adminId,
        title,
        message,
        metadata: req.body?.metadata || null,
      });
    }

    const pool = await getPool();
    const [insertResult] = await pool.execute(
      `INSERT INTO notifications (type, title, message, is_read)
       VALUES (?, ?, ?, 0)`,
      [notificationType, title, message]
    );

    await logAction(pool, adminId, "broadcastNotification", {
      type: notificationType,
      technicianCount: technicianIds.length,
      notificationId: insertResult.insertId,
    });

    return res.status(201).json({
      success: true,
      notificationId: insertResult.insertId,
      payload,
    });
  } catch (error) {
    console.error("[admin.notifications.broadcast] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to broadcast notification." });
  }
}
