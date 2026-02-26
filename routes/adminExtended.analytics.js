import { Router } from "express";
import { getPool } from "../db.js";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";

const router = Router();

function adminExtendedFormatDayKey(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function adminExtendedBuildDailySeries(rows, daysBack) {
  const map = new Map();
  for (const row of rows) {
    const dayKey = adminExtendedFormatDayKey(row.day);
    if (!dayKey) continue;
    map.set(dayKey, Number(row.request_count || 0));
  }

  const result = [];
  for (let index = daysBack - 1; index >= 0; index -= 1) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - index);
    const dayKey = day.toISOString().slice(0, 10);
    result.push({
      day: dayKey,
      requestCount: map.get(dayKey) || 0,
    });
  }
  return result;
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.analytics] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.get("/analytics/pilot", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.analytics.pilotAnalyticsEngine";
  try {
    const daysBack = Math.min(Math.max(Number(req.query.days) || 14, 3), 90);
    const peakLimit = Math.min(Math.max(Number(req.query.peakLimit) || 6, 1), 24);
    const pool = await getPool();

    const [
      [requestsPerDayRows],
      [peakHoursRows],
      [issueBreakdownRows],
      [utilizationRows],
    ] = await Promise.all([
      pool.query(
        `SELECT DATE(created_at) AS day, COUNT(*) AS request_count
         FROM service_requests
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC`,
        [daysBack - 1]
      ),
      pool.query(
        `SELECT HOUR(created_at) AS hour_of_day, COUNT(*) AS request_count
         FROM service_requests
         GROUP BY HOUR(created_at)
         ORDER BY request_count DESC, hour_of_day ASC
         LIMIT ?`,
        [peakLimit]
      ),
      pool.query(
        `SELECT service_type AS issue_category, COUNT(*) AS request_count
         FROM service_requests
         GROUP BY service_type
         ORDER BY request_count DESC`
      ),
      pool.query(
        `SELECT
           t.id AS technician_id,
           t.name AS technician_name,
           t.is_available,
           COUNT(sr.id) AS total_assigned,
           SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 1 ELSE 0 END) AS completed_requests,
           SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('assigned', 'accepted', 'en-route', 'on-the-way', 'arrived', 'in-progress', 'payment_pending') THEN 1 ELSE 0 END) AS active_requests
         FROM technicians t
         LEFT JOIN service_requests sr ON sr.technician_id = t.id
         GROUP BY t.id, t.name, t.is_available
         ORDER BY total_assigned DESC, completed_requests DESC`
      ),
    ]);

    const requestsPerDay = adminExtendedBuildDailySeries(requestsPerDayRows, daysBack);
    const peakHours = peakHoursRows.map((row) => ({
      hourOfDay: Number(row.hour_of_day || 0),
      requestCount: Number(row.request_count || 0),
    }));
    const issueCategoryBreakdown = issueBreakdownRows.map((row) => ({
      issueCategory: row.issue_category || "unknown",
      requestCount: Number(row.request_count || 0),
    }));
    const technicianUtilization = utilizationRows.map((row) => {
      const totalAssigned = Number(row.total_assigned || 0);
      const activeRequests = Number(row.active_requests || 0);
      const completedRequests = Number(row.completed_requests || 0);
      const utilizationRate = totalAssigned > 0
        ? Number(((activeRequests / totalAssigned) * 100).toFixed(2))
        : 0;

      return {
        technicianId: row.technician_id,
        technicianName: row.technician_name,
        isAvailable: Boolean(row.is_available),
        totalAssigned,
        completedRequests,
        activeRequests,
        utilizationRate,
      };
    });

    return res.json({
      requestsPerDay,
      peakHours,
      issueCategoryBreakdown,
      technicianUtilization,
    });
  } catch (error) {
    console.error("[adminExtended.analytics] pilot analytics failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch pilot analytics." });
  }
});

export default router;

