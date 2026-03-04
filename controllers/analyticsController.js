import { getPool } from "../db.js";
import { toPositiveInt } from "./utils.js";

const DISTRIBUTION_COLORS = [
  "#ef4444",
  "#0ea5e9",
  "#14b8a6",
  "#f59e0b",
  "#10b981",
  "#6366f1",
  "#f97316",
  "#8b5cf6",
];

function toDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function buildDailySeries(rows, daysBack) {
  const countMap = new Map();
  rows.forEach((row) => {
    const day = toDayKey(row.day);
    if (day) {
      countMap.set(day, Number(row.request_count || 0));
    }
  });

  const result = [];
  for (let index = daysBack - 1; index >= 0; index -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - index);
    const day = date.toISOString().slice(0, 10);
    result.push({ day, requestCount: countMap.get(day) || 0 });
  }

  return result;
}

function buildLastSixMonthsSeries(rows) {
  const monthMap = new Map();
  rows.forEach((row) => {
    monthMap.set(row.year_month, {
      name: row.month_label,
      requests: Number(row.request_count || 0),
      technicians: Number(row.technician_count || 0),
    });
  });

  const output = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-US", { month: "short" });
    const row = monthMap.get(yearMonth) || { name: label, requests: 0, technicians: 0 };
    output.push({ name: row.name || label, requests: row.requests || 0, technicians: row.technicians || 0 });
  }

  return output;
}

export async function getAnalytics(req, res) {
  try {
    const daysBack = toPositiveInt(req.query?.days, 14, { min: 7, max: 90 });
    const peakLimit = toPositiveInt(req.query?.peakLimit, 8, { min: 3, max: 24 });

    const pool = await getPool();
    const [
      [requestsPerDayRows],
      [peakHoursRows],
      [issueCategoryRows],
      [utilizationRows],
      [totalsRows],
      [monthlyRows],
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
        `SELECT COALESCE(service_type, 'unknown') AS issue_category, COUNT(*) AS request_count
         FROM service_requests
         GROUP BY service_type
         ORDER BY request_count DESC`
      ),
      pool.query(
        `SELECT
           t.id AS technician_id,
           t.name AS technician_name,
           SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('assigned', 'accepted', 'en-route', 'on-the-way', 'arrived', 'in-progress', 'payment_pending') THEN 1 ELSE 0 END) AS active_requests,
           COUNT(sr.id) AS total_assigned
         FROM technicians t
         LEFT JOIN service_requests sr ON sr.technician_id = t.id
         GROUP BY t.id, t.name
         ORDER BY total_assigned DESC, active_requests DESC`
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM technicians) AS total_technicians,
           (SELECT COUNT(*) FROM users) AS total_users,
           (SELECT COUNT(DISTINCT user_id) FROM service_requests WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS active_users,
           (SELECT COUNT(*) FROM service_requests) AS total_service_requests,
           (
             SELECT IFNULL(SUM(p.amount), 0)
             FROM payments p
             LEFT JOIN service_requests sr ON sr.id = p.service_request_id
             WHERE LOWER(COALESCE(p.status, '')) = 'completed'
               AND (sr.id IS NULL OR LOWER(COALESCE(sr.status, '')) <> 'cancelled')
           ) AS total_revenue`
      ),
      pool.query(
        `SELECT
           DATE_FORMAT(m.month_start, '%Y-%m') AS year_month,
           DATE_FORMAT(m.month_start, '%b') AS month_label,
           COALESCE(sr.request_count, 0) AS request_count,
           COALESCE(t.technician_count, 0) AS technician_count
         FROM (
           SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL seq MONTH), '%Y-%m-01') AS month_start
           FROM (
             SELECT 0 AS seq UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
           ) month_seq
         ) m
         LEFT JOIN (
           SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS request_count
           FROM service_requests
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
           GROUP BY DATE_FORMAT(created_at, '%Y-%m')
         ) sr ON sr.ym = DATE_FORMAT(m.month_start, '%Y-%m')
         LEFT JOIN (
           SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS technician_count
           FROM technicians
           WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
           GROUP BY DATE_FORMAT(created_at, '%Y-%m')
         ) t ON t.ym = DATE_FORMAT(m.month_start, '%Y-%m')
         ORDER BY year_month ASC`
      ),
    ]);

    const requestsPerDay = buildDailySeries(requestsPerDayRows, daysBack);
    const peakHours = peakHoursRows.map((row) => ({
      hourOfDay: Number(row.hour_of_day || 0),
      requestCount: Number(row.request_count || 0),
    }));
    const issueCategoryBreakdown = issueCategoryRows.map((row) => ({
      issueCategory: row.issue_category || "unknown",
      requestCount: Number(row.request_count || 0),
    }));
    const technicianUtilization = utilizationRows.map((row) => {
      const totalAssigned = Number(row.total_assigned || 0);
      const activeRequests = Number(row.active_requests || 0);
      return {
        technicianId: row.technician_id,
        technicianName: row.technician_name,
        activeRequests,
        totalAssigned,
        utilizationRate: totalAssigned > 0 ? Number(((activeRequests / totalAssigned) * 100).toFixed(2)) : 0,
      };
    });

    const totals = totalsRows?.[0] || {};
    const monthlyData = buildLastSixMonthsSeries(monthlyRows || []);
    const serviceDistribution = issueCategoryBreakdown.map((item, index) => ({
      name: item.issueCategory,
      value: item.requestCount,
      color: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length],
    }));

    return res.json({
      requestsPerDay,
      peakHours,
      issueCategoryBreakdown,
      technicianUtilization,
      // Keep legacy keys for existing /admin analytics page compatibility.
      totalTechnicians: Number(totals.total_technicians || 0),
      totalUsers: Number(totals.total_users || 0),
      activeUsers: Number(totals.active_users || 0),
      totalServiceRequests: Number(totals.total_service_requests || 0),
      totalRevenue: Number(totals.total_revenue || 0),
      monthlyData,
      serviceDistribution,
    });
  } catch (error) {
    console.error("[admin.analytics] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch analytics." });
  }
}
