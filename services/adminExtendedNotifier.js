import { socketService } from "./socket.js";

function adminExtendedBuildPayload({ type, adminId, title, message, metadata = null, technicianIds = null }) {
  return {
    type,
    adminId: String(adminId || "admin"),
    title: String(title || "Admin Broadcast"),
    message: String(message || ""),
    technicianIds: Array.isArray(technicianIds) ? technicianIds : null,
    metadata: metadata || null,
    timestamp: new Date().toISOString(),
  };
}

function adminExtendedEmitBroadcast(payload) {
  const technicianIds = Array.isArray(payload?.technicianIds)
    ? payload.technicianIds.filter((id) => Number.isInteger(Number(id)) && Number(id) > 0)
    : [];

  if (technicianIds.length > 0 && socketService.io) {
    technicianIds.forEach((technicianId) => {
      socketService.io.to(`technician_${String(technicianId)}`).emit("admin:broadcast", payload);
    });
  } else {
    socketService.broadcast("admin:broadcast", payload);
  }

  return payload;
}

export function adminExtendedSystemAnnouncement({ adminId, title, message, metadata = null }) {
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

export function adminExtendedTechnicianBroadcast({ adminId, title, message, metadata = null, technicianIds = null }) {
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

export function adminExtendedEmergencyMessage({ adminId, title, message, metadata = null }) {
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
