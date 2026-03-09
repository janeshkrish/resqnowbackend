import { Router } from "express";
import { verifyAdmin } from "../middleware/auth.js";
import {
  getActiveMonitoringAlerts,
  getOperationsCommandCenterMonitorState,
  getTechnicianTrackForRequest,
  prepareTechnicianCall,
  reassignMonitoredRequest,
  runOperationsCommandCenterCycle,
  triggerTechnicianReminder,
} from "../services/operationsCommandCenterService.js";
import { adminExtendedReRouteSearchRadius } from "../services/adminExtendedDispatchOverride.js";

const router = Router();

function toPositiveInt(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

router.use((req, res, next) => verifyAdmin(req, res, next));

router.get("/exceptions", async (_req, res) => {
  try {
    const data = await getActiveMonitoringAlerts();
    return res.json({
      title: "Operations Command Center",
      monitor: getOperationsCommandCenterMonitorState(),
      data,
    });
  } catch (error) {
    console.error("[admin.command-center.exceptions]", error);
    return res.status(500).json({ error: "Failed to fetch command center exceptions." });
  }
});

router.get("/tracks/:requestId", async (req, res) => {
  try {
    const requestId = toPositiveInt(req.params.requestId, "requestId");
    const limit = req.query.limit != null ? Number(req.query.limit) : 80;
    const data = await getTechnicianTrackForRequest(requestId, limit);
    return res.json(data);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to fetch technician track." });
  }
});

router.post("/actions/remind-technician", async (req, res) => {
  try {
    const requestId = toPositiveInt(req.body?.requestId, "requestId");
    const result = await triggerTechnicianReminder({
      requestId,
      adminId: req.adminEmail || req.admin?.email || "admin",
    });
    return res.json(result);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to send technician reminder." });
  }
});

router.post("/actions/call-technician", async (req, res) => {
  try {
    const requestId = toPositiveInt(req.body?.requestId, "requestId");
    const data = await prepareTechnicianCall({ requestId });
    return res.json({
      success: true,
      ...data,
      dialLink: data.technicianPhone ? `tel:${String(data.technicianPhone).replace(/\s+/g, "")}` : null,
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to prepare technician call." });
  }
});

router.post("/actions/reassign", async (req, res) => {
  try {
    const requestId = toPositiveInt(req.body?.requestId, "requestId");
    const radiusKm = Number(req.body?.radiusKm || 35);
    const maxCandidates = Number(req.body?.maxCandidates || 5);
    const result = await reassignMonitoredRequest({ requestId, radiusKm, maxCandidates });
    return res.json(result);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to reassign request." });
  }
});

router.post("/actions/escalate", async (req, res) => {
  try {
    const requestId = toPositiveInt(req.body?.requestId, "requestId");
    const radiusKm = Number(req.body?.radiusKm || 35);
    const result = await adminExtendedReRouteSearchRadius({ requestId, radiusKm });
    return res.json({ success: true, ...result });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    return res.status(statusCode).json({ error: error?.message || "Failed to escalate request." });
  }
});

router.post("/monitor/run", async (_req, res) => {
  try {
    const result = await runOperationsCommandCenterCycle({ trigger: "manual" });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("[admin.command-center.monitor.run]", error);
    return res.status(500).json({ error: "Failed to execute monitoring cycle." });
  }
});

export default router;
