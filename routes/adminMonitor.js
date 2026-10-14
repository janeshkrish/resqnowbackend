import { Router } from "express";
import * as db from "../db.js";
import { verifyAdmin } from "../middleware/auth.js";
import { getLiveTrackingRuntime } from "../services/liveTrackingRuntime.js";
import { recordRequestEvent } from "../services/requestEvents.js";
import {
  getLiveRequests,
  getRequestMonitor,
  getRequestReplay,
  getTechnicianJobs,
  getTechnicianRecord,
  getTechnicianReviews,
} from "../services/adminMonitorService.js";

// Admin live monitoring and the technician record. Every answer is read fresh from the
// database, the live-tracking store and the shared ETA cache.

const positiveInt = (value) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function runtimeOrNull() {
  try {
    return getLiveTrackingRuntime();
  } catch {
    return null;
  }
}

export function createAdminMonitorRouter({ getPool = db.getPool, getRuntime = runtimeOrNull, record = recordRequestEvent, guard = verifyAdmin } = {}) {
  const router = Router();
  router.use(guard);

  const handle = (fn) => async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      console.error("[admin.monitor]", req.method, req.path, error?.message || error);
      return res.status(500).json({ error: "Could not load this right now." });
    }
  };

  router.get("/live", handle(async (_req, res) => {
    const pool = await getPool();
    res.json(await getLiveRequests({ pool, runtime: getRuntime() }));
  }));

  router.get("/requests/:id", handle(async (req, res) => {
    const requestId = positiveInt(req.params.id);
    if (!requestId) return res.status(400).json({ error: "Invalid request id." });
    const pool = await getPool();
    const data = await getRequestMonitor({ pool, requestId, runtime: getRuntime() });
    if (!data) return res.status(404).json({ error: "Request not found." });
    return res.json(data);
  }));

  router.get("/requests/:id/replay", handle(async (req, res) => {
    const requestId = positiveInt(req.params.id);
    if (!requestId) return res.status(400).json({ error: "Invalid request id." });
    const pool = await getPool();
    const data = await getRequestReplay({ pool, requestId });
    if (!data) return res.status(404).json({ error: "Request not found." });
    return res.json(data);
  }));

  router.post("/requests/:id/notes", handle(async (req, res) => {
    const requestId = positiveInt(req.params.id);
    const note = String(req.body?.note || "").trim();
    if (!requestId) return res.status(400).json({ error: "Invalid request id." });
    if (!note) return res.status(400).json({ error: "Write the note first." });
    if (note.length > 1000) return res.status(400).json({ error: "Keep the note under 1000 letters." });
    const row = await record(
      { requestId, eventType: "admin_note", actorType: "admin", actorId: req.adminEmail || req.admin?.email || "admin", description: note },
      { getPool }
    );
    if (!row) return res.status(500).json({ error: "The note could not be saved." });
    return res.status(201).json({ success: true, event: row });
  }));

  router.get("/technicians/:id/record", handle(async (req, res) => {
    const technicianId = positiveInt(req.params.id);
    if (!technicianId) return res.status(400).json({ error: "Invalid technician id." });
    const pool = await getPool();
    const data = await getTechnicianRecord({ pool, technicianId });
    if (!data) return res.status(404).json({ error: "Technician not found." });
    return res.json(data);
  }));

  router.get("/technicians/:id/jobs", handle(async (req, res) => {
    const technicianId = positiveInt(req.params.id);
    if (!technicianId) return res.status(400).json({ error: "Invalid technician id." });
    const pool = await getPool();
    const days = positiveInt(req.query.days);
    const status = ["all", "done", "active", "cancelled"].includes(String(req.query.status)) ? String(req.query.status) : "all";
    return res.json(await getTechnicianJobs({
      pool, technicianId, page: positiveInt(req.query.page) || 1, limit: Math.min(50, positiveInt(req.query.limit) || 20), days, status, search: req.query.search,
    }));
  }));

  router.get("/technicians/:id/reviews", handle(async (req, res) => {
    const technicianId = positiveInt(req.params.id);
    if (!technicianId) return res.status(400).json({ error: "Invalid technician id." });
    const pool = await getPool();
    return res.json(await getTechnicianReviews({ pool, technicianId, page: positiveInt(req.query.page) || 1, limit: Math.min(50, positiveInt(req.query.limit) || 20) }));
  }));

  return router;
}

export default createAdminMonitorRouter();
