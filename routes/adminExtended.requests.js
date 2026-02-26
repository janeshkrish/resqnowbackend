import { Router } from "express";
import { getPool } from "../db.js";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { adminExtendedLogAdminAction } from "../services/adminExtendedActionLogService.js";
import {
  adminExtendedForceAssign,
  adminExtendedManualCloseRequest,
  adminExtendedReRouteSearchRadius,
} from "../services/adminExtendedDispatchOverride.js";

const router = Router();

function adminExtendedResolveAdminId(req) {
  return String(req.adminExtended?.adminId || req.adminEmail || req.admin?.email || "admin");
}

async function adminExtendedEnsureRequestExists(requestId) {
  const pool = await getPool();
  const [rows] = await pool.query(
    "SELECT id, status, technician_id FROM service_requests WHERE id = ? LIMIT 1",
    [requestId]
  );
  return rows?.[0] || null;
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.requests] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.post("/requests/manual-assign", async (req, res) => {
  const { requestId, technicianId } = req.body || {};
  req.adminExtendedActionType = "adminExtended.requests.manualAssignTechnician";

  try {
    const result = await adminExtendedForceAssign({ requestId, technicianId });
    const adminId = adminExtendedResolveAdminId(req);

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "manualAssignTechnician",
      targetType: "service_request",
      targetId: requestId,
      metadata: {
        technicianId,
        success: Boolean(result?.success),
        reason: result?.reason || null,
      },
    });

    if (!result?.success) {
      return res.status(409).json({ error: result?.reason || "Failed to assign technician.", result });
    }
    return res.json({ success: true, result });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to assign technician." });
  }
});

router.post("/requests/escalate", async (req, res) => {
  const { requestId, radiusKm, reason } = req.body || {};
  req.adminExtendedActionType = "adminExtended.requests.escalateRequest";

  try {
    const requestRow = await adminExtendedEnsureRequestExists(requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Service request not found." });
    }

    const rerouteResult = await adminExtendedReRouteSearchRadius({
      requestId,
      radiusKm: radiusKm ?? 35,
    });
    const adminId = adminExtendedResolveAdminId(req);

    await adminExtendedLogAdminAction({
      adminId,
      actionType: "escalateRequest",
      targetType: "service_request",
      targetId: requestId,
      metadata: {
        reason: reason || null,
        radiusKm: rerouteResult.radiusKm,
        candidatesFound: rerouteResult.candidatesFound,
      },
    });

    return res.json({ success: true, request: requestRow, reroute: rerouteResult });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to escalate request." });
  }
});

router.post("/requests/high-priority", async (req, res) => {
  const { requestId, note } = req.body || {};
  req.adminExtendedActionType = "adminExtended.requests.markHighPriority";

  try {
    const requestRow = await adminExtendedEnsureRequestExists(requestId);
    if (!requestRow) {
      return res.status(404).json({ error: "Service request not found." });
    }

    const adminId = adminExtendedResolveAdminId(req);
    await adminExtendedLogAdminAction({
      adminId,
      actionType: "markHighPriority",
      targetType: "service_request",
      targetId: requestId,
      metadata: {
        note: note || null,
        currentStatus: requestRow.status,
        technicianId: requestRow.technician_id,
      },
    });

    return res.json({
      success: true,
      requestId: Number(requestId),
      highPriority: true,
      note: note || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Failed to mark request as high priority." });
  }
});

router.post("/dispatch/force-assign", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.dispatch.forceAssign";
  const { requestId, technicianId } = req.body || {};

  try {
    const result = await adminExtendedForceAssign({ requestId, technicianId });
    await adminExtendedLogAdminAction({
      adminId: adminExtendedResolveAdminId(req),
      actionType: "forceAssign",
      targetType: "service_request",
      targetId: requestId,
      metadata: { technicianId, success: Boolean(result?.success), reason: result?.reason || null },
    });

    if (!result?.success) {
      return res.status(409).json({ error: result?.reason || "Failed to force-assign request.", result });
    }
    return res.json({ success: true, result });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to force-assign request." });
  }
});

router.post("/dispatch/reroute", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.dispatch.reRouteSearchRadius";
  const { requestId, radiusKm } = req.body || {};

  try {
    const result = await adminExtendedReRouteSearchRadius({ requestId, radiusKm });
    await adminExtendedLogAdminAction({
      adminId: adminExtendedResolveAdminId(req),
      actionType: "reRouteSearchRadius",
      targetType: "service_request",
      targetId: requestId,
      metadata: {
        radiusKm: result.radiusKm,
        candidatesFound: result.candidatesFound,
      },
    });

    return res.json({ success: true, result });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to reroute dispatch." });
  }
});

router.post("/dispatch/manual-close", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.dispatch.manualCloseRequest";
  const { requestId, status, reason } = req.body || {};

  try {
    const result = await adminExtendedManualCloseRequest({ requestId, status, reason });
    await adminExtendedLogAdminAction({
      adminId: adminExtendedResolveAdminId(req),
      actionType: "manualCloseRequest",
      targetType: "service_request",
      targetId: requestId,
      metadata: {
        status: result.status,
        reason: reason || null,
        alreadyTerminal: result.alreadyTerminal,
      },
    });

    return res.json({ success: true, result });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to manually close request." });
  }
});

export default router;

