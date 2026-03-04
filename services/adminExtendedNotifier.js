import { socketService } from "./socket.js";
import { getPool } from "../db.js";
import { notificationService } from "./notificationService.js";

function adminExtendedBuildPayload({ type, adminId, title, message, metadata = null, technicianIds = null }) {
  const resolvedTechnicianIds = Array.isArray(technicianIds)
    ? Array.from(
      new Set(
        technicianIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    )
    : [];

  const isEmergency = type === "emergencyMessage";
  return {
    type,
    adminId: String(adminId || "admin"),
    title: String(title || "Admin Broadcast"),
    message: String(message || ""),
    technicianIds: resolvedTechnicianIds,
    channels: ["mobile_push", "browser_push"],
    priority: isEmergency ? "HIGH" : "NORMAL",
    sound: isEmergency,
    metadata: metadata || null,
    timestamp: new Date().toISOString(),
  };
}

async function adminExtendedResolveTechnicianIds(technicianIds) {
  const explicitIds = Array.isArray(technicianIds)
    ? Array.from(
      new Set(
        technicianIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    )
    : [];

  if (explicitIds.length > 0) {
    return explicitIds;
  }

  const pool = await getPool();
  const [rows] = await pool.query("SELECT id FROM technicians");
  return rows
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function adminExtendedMapEventByType(type) {
  if (type === "emergencyMessage") return "admin:emergency_message";
  if (type === "technicianBroadcast") return "admin:technician_broadcast";
  return "admin:system_announcement";
}

async function adminExtendedEmitBroadcast(payload) {
  const targetTechnicianIds = await adminExtendedResolveTechnicianIds(payload?.technicianIds);
  const eventName = adminExtendedMapEventByType(payload?.type);

  if (socketService.io) {
    targetTechnicianIds.forEach((technicianId) => {
      socketService.io.to(`technician_${String(technicianId)}`).emit("admin:broadcast", payload);
      socketService.io.to(`technician_${String(technicianId)}`).emit(eventName, payload);
    });
  }

  await Promise.allSettled(
    targetTechnicianIds.map((technicianId) =>
      notificationService.sendPushNotification(
        technicianId,
        "technician",
        eventName,
        payload
      )
    )
  );

  return {
    ...payload,
    technicianIds: targetTechnicianIds,
    targetCount: targetTechnicianIds.length,
  };
}

export async function adminExtendedSystemAnnouncement({ adminId, title, message, metadata = null }) {
  return adminExtendedEmitBroadcast(
    adminExtendedBuildPayload({
      type: "systemAnnouncement",
      adminId,
      title,
      message,
      metadata,
    })
  );
}

export async function adminExtendedTechnicianBroadcast({
  adminId,
  title,
  message,
  metadata = null,
  technicianIds = null,
}) {
  return adminExtendedEmitBroadcast(
    adminExtendedBuildPayload({
      type: "technicianBroadcast",
      adminId,
      title,
      message,
      metadata,
      technicianIds,
    })
  );
}

export async function adminExtendedEmergencyMessage({ adminId, title, message, metadata = null }) {
  return adminExtendedEmitBroadcast(
    adminExtendedBuildPayload({
      type: "emergencyMessage",
      adminId,
      title: title || "Emergency",
      message,
      metadata,
    })
  );
}
