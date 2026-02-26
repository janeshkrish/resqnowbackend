import { Router } from "express";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { adminExtendedLogAdminAction } from "../services/adminExtendedActionLogService.js";
import {
  adminExtendedEmergencyMessage,
  adminExtendedSystemAnnouncement,
  adminExtendedTechnicianBroadcast,
} from "../services/adminExtendedNotifier.js";

const router = Router();

function adminExtendedResolveAdminId(req) {
  return String(req.adminExtended?.adminId || req.adminEmail || req.admin?.email || "admin");
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.notifications] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.post("/notifications/system-announcement", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.notifications.systemAnnouncement";
  try {
    const adminId = adminExtendedResolveAdminId(req);
    const payload = adminExtendedSystemAnnouncement({
      adminId,
      title: req.body?.title || "System Announcement",
      message: req.body?.message || "",
      metadata: req.body?.metadata || null,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "systemAnnouncement",
      targetType: "broadcast",
      targetId: "all",
      metadata: { title: payload.title },
    });

    return res.json({ success: true, payload });
  } catch (error) {
    console.error("[adminExtended.notifications] system announcement failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to send system announcement." });
  }
});

router.post("/notifications/technician-broadcast", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.notifications.technicianBroadcast";
  try {
    const adminId = adminExtendedResolveAdminId(req);
    const technicianIds = Array.isArray(req.body?.technicianIds)
      ? req.body.technicianIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : null;

    const payload = adminExtendedTechnicianBroadcast({
      adminId,
      title: req.body?.title || "Technician Broadcast",
      message: req.body?.message || "",
      metadata: req.body?.metadata || null,
      technicianIds,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "technicianBroadcast",
      targetType: "broadcast",
      targetId: technicianIds && technicianIds.length > 0 ? technicianIds.join(",") : "all_technicians",
      metadata: { title: payload.title, technicianCount: technicianIds?.length || 0 },
    });

    return res.json({ success: true, payload });
  } catch (error) {
    console.error("[adminExtended.notifications] technician broadcast failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to send technician broadcast." });
  }
});

router.post("/notifications/emergency-message", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.notifications.emergencyMessage";
  try {
    const adminId = adminExtendedResolveAdminId(req);
    const payload = adminExtendedEmergencyMessage({
      adminId,
      title: req.body?.title || "Emergency",
      message: req.body?.message || "",
      metadata: req.body?.metadata || null,
    });

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "emergencyMessage",
      targetType: "broadcast",
      targetId: "all",
      metadata: { title: payload.title },
    });

    return res.json({ success: true, payload });
  } catch (error) {
    console.error("[adminExtended.notifications] emergency message failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to send emergency message." });
  }
});

export default router;

