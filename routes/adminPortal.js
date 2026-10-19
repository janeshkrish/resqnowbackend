import { adminActorId } from "../models/userIdentity.js";
import { recordId, isRecordId } from "../models/identifiers.js";
import { Router } from "express";
import * as db from "../db.js";
import { verifyAdmin } from "../middleware/auth.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";
import { getMonitoringRules } from "../services/operationsCommandCenterService.js";
import { getDispatchSettings } from "../services/dispatchQueueService.js";
import * as portal from "../services/adminPortalService.js";

// Reads for the redesigned admin portal. Every action (assign, refund, approve, pay out…) keeps
// using the existing admin endpoints; this router only adds the views those endpoints lacked.
export function createAdminPortalRouter({
  getPool = db.getPool,
  guard = verifyAdmin,
  ensureSchema = ensureAdminExtendedSchema,
  now = () => Date.now(),
} = {}) {
  const router = Router();
  router.use(guard);

  const read = (name, fn) => async (req, res) => {
    try {
      const pool = await getPool();
      const result = await fn(pool, req);
      if (result && result.notFound) return res.status(404).json({ error: "Not found." });
      if (result && result.error) return res.status(400).json({ error: result.error });
      return res.json(result);
    } catch (error) {
      console.error(`[admin.portal.${name}] failed:`, error?.message || error);
      return res.status(500).json({ error: "Could not load this. Try again." });
    }
  };
  const id = (req) => {
    const value = recordId(req.params.id);
    return isRecordId(value) ? value : null;
  };

  router.get("/nav-counts", read("navCounts", (pool) => portal.getNavCounts({ pool })));
  router.get("/today", read("today", (pool) => portal.getToday({ pool, now: now() })));
  router.get("/search", read("search", (pool, req) => portal.search({ pool, q: req.query.q })));
  router.get("/requests", read("requests", (pool, req) => portal.listRequests({ pool, query: req.query, now: now() })));
  router.get("/technicians", read("technicians", (pool, req) => portal.listTechnicians({ pool, query: req.query, now: now() })));
  router.get("/technicians/:id/payouts", read("technicianPayouts", (pool, req) => (id(req) ? portal.getTechnicianPayouts({ pool, technicianId: id(req) }) : { notFound: true })));
  router.get("/customers", read("customers", (pool, req) => portal.listCustomers({ pool, query: req.query, now: now() })));
  router.get("/customers/:id", read("customer", async (pool, req) => {
    await ensureSchema();
    const customer = id(req) ? await portal.getCustomer({ pool, customerId: id(req) }) : null;
    return customer || { notFound: true };
  }));
  router.post("/customers/:id/notes", read("customerNote", async (pool, req) => {
    await ensureSchema();
    if (!id(req)) return { notFound: true };
    return portal.addCustomerNote({ pool, customerId: id(req), note: req.body?.note, adminId: adminActorId(req) });
  }));
  router.get("/reports", read("reports", (pool, req) => portal.getReports({ pool, days: req.query.days, now: now() })));
  router.get("/services/stats", read("serviceStats", (pool) => portal.getServiceStats({ pool, now: now() })));
  router.get("/prices/medians", read("priceMedians", (pool) => portal.getPriceMedians({ pool })));
  router.get("/cash-dues", read("cashDues", (pool) => portal.getCashDues({ pool })));
  router.get("/alerts/handled", read("alertsHandled", (pool) => portal.getHandledAlerts({ pool, now: now() })));
  router.get("/alerts/rules", read("alertRules", async () => getMonitoringRules()));
  router.get("/audit", read("audit", (pool, req) => portal.listAudit({ pool, query: req.query, now: now() })));
  router.post("/notifications/read-all", read("notificationsReadAll", (pool) => portal.markAllNotificationsRead({ pool })));
  router.get("/settings", read("settings", async (_pool, req) => ({
    admin: { email: req.adminEmail || null },
    dispatch: getDispatchSettings(),
    monitoring: getMonitoringRules(),
    phoneSignIn: { configured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL) || process.env.GOOGLE_APPLICATION_CREDENTIALS) },
  })));
  return router;
}

export default createAdminPortalRouter();
