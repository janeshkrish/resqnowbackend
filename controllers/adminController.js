import { getPool } from "../db.js";
import { toNumber, toPositiveInt } from "./utils.js";

export async function getDashboard(req, res) {
  try {
    const pool = await getPool();

    const [
      [activeRequestsRows],
      [availableTechniciansRows],
      [completedTodayRows],
      [avgResponseRows],
      [todayRevenueRows],
      [pendingPaymentsRows],
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count
         FROM service_requests
         WHERE LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'paid')`
      ),
      pool.query(
        `SELECT COUNT(*) AS count
         FROM technicians
         WHERE LOWER(COALESCE(status, '')) = 'approved'
           AND COALESCE(is_active, 0) = 1
           AND COALESCE(is_available, 0) = 1`
      ),
      pool.query(
        `SELECT COUNT(*) AS count
         FROM service_requests
         WHERE LOWER(COALESCE(status, '')) IN ('completed', 'paid')
           AND DATE(COALESCE(completed_at, updated_at, created_at)) = CURDATE()`
      ),
      pool.query(
        `SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, COALESCE(started_at, updated_at))) AS avg_response_minutes
         FROM service_requests
         WHERE technician_id IS NOT NULL
           AND COALESCE(started_at, updated_at) IS NOT NULL
           AND COALESCE(started_at, updated_at) >= created_at
           AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
      ),
      pool.query(
        `SELECT IFNULL(SUM(amount), 0) AS total
         FROM payments
         WHERE LOWER(COALESCE(status, '')) = 'completed'
           AND DATE(created_at) = CURDATE()`
      ),
      pool.query(
        `SELECT COUNT(*) AS count
         FROM payments
         WHERE LOWER(COALESCE(status, '')) IN ('pending', 'processing')`
      ),
    ]);

    return res.json({
      activeRequests: toNumber(activeRequestsRows?.[0]?.count),
      availableTechnicians: toNumber(availableTechniciansRows?.[0]?.count),
      completedToday: toNumber(completedTodayRows?.[0]?.count),
      avgResponseTime: Number(toNumber(avgResponseRows?.[0]?.avg_response_minutes).toFixed(2)),
      todayRevenue: Number(toNumber(todayRevenueRows?.[0]?.total).toFixed(2)),
      pendingPayments: toNumber(pendingPaymentsRows?.[0]?.count),
    });
  } catch (error) {
    console.error("[admin.dashboard] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch dashboard data." });
  }
}

export async function getAdminAuditLogs(req, res) {
  try {
    const limit = toPositiveInt(req.query?.limit, 50, { min: 1, max: 200 });
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT id, admin_id, action_type, target_type, target_id, metadata, created_at
       FROM admin_actions_log
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    return res.json({
      data: rows,
      total: rows.length,
    });
  } catch (error) {
    console.error("[admin.auditLogs] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch audit logs." });
  }
}
