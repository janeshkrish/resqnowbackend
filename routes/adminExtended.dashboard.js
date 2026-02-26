import { Router } from "express";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { adminExtendedGetDashboardMetrics } from "../services/adminExtendedDashboardService.js";

const router = Router();

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.dashboard] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.get("/dashboard", async (req, res) => {
  try {
    req.adminExtendedActionType = "adminExtended.dashboard.metrics";
    const metrics = await adminExtendedGetDashboardMetrics();
    return res.json(metrics);
  } catch (error) {
    console.error("[adminExtended.dashboard] metrics failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch dashboard metrics." });
  }
});

export default router;

