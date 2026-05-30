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

function buildLastSixMonthsSeries(requestRows, technicianRows) {
  const requestMap = new Map(
    (requestRows || []).map((row) => [row.year_month, Number(row.request_count || 0)])
  );
  const technicianMap = new Map(
    (technicianRows || []).map((row) => [row.year_month, Number(row.technician_count || 0)])
  );

  const output = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-US", { month: "short" });
    output.push({
      name: label,
      requests: requestMap.get(yearMonth) || 0,
      technicians: technicianMap.get(yearMonth) || 0,
    });
  }

  return output;
}

async function safeQuery(pool, label, sql, params = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  } catch (error) {
    console.error(`[admin.analytics] ${label} failed:`, error?.message || error);
    return [];
  }
}

export async function getAnalytics(req, res) {
  try {
    const daysBack = toPositiveInt(req.query?.days, 14, { min: 7, max: 90 });
    const peakLimit = toPositiveInt(req.query?.peakLimit, 8, { min: 3, max: 24 });

    const pool = await getPool();
    const [
      requestsOverTimeRows,
      peakHoursRows,
      serviceDistributionRows,
      utilizationRows,
      usersRows,
      techniciansRows,
      totalRequestsRows,
      completedRequestsRows,
      activeUsersRows,
      revenueRows,
      monthlyRequestRows,
      monthlyTechnicianRows,
    ] = await Promise.all([
      safeQuery(
        pool,
        "requestsOverTime",
        `SELECT DATE(created_at) AS day, COUNT(*) AS request_count
         FROM service_requests
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC`,
        [daysBack - 1]
      ),
      safeQuery(
        pool,
        "peakHours",
        `SELECT HOUR(created_at) AS hour_of_day, COUNT(*) AS request_count
         FROM service_requests
         GROUP BY HOUR(created_at)
         ORDER BY request_count DESC, hour_of_day ASC
         LIMIT ?`,
        [peakLimit]
      ),
      safeQuery(
        pool,
        "serviceDistribution",
        `SELECT COALESCE(service_type, 'unknown') AS issue_category, COUNT(*) AS request_count
         FROM service_requests
         GROUP BY service_type
         ORDER BY request_count DESC`
      ),
      safeQuery(
        pool,
        "technicianUtilization",
        `SELECT
           t.id AS technician_id,
           t.name AS technician_name,
           SUM(CASE WHEN LOWER(COALESCE(sr.status, '')) IN ('assigned', 'accepted', 'en_route_pickup', 'arrived_pickup', 'vehicle_loaded', 'enroute_drop', 'arrived_drop', 'service_completed', 'processing', 'en-route', 'on-the-way', 'arrived', 'in_progress', 'in-progress', 'awaiting_payment', 'payment_pending') THEN 1 ELSE 0 END) AS active_requests,
           COUNT(sr.id) AS total_assigned
         FROM technicians t
         LEFT JOIN service_requests sr ON sr.technician_id = t.id
         GROUP BY t.id, t.name
         ORDER BY total_assigned DESC, active_requests DESC`
      ),
      safeQuery(pool, "totalUsers", "SELECT COUNT(*) AS total FROM users"),
      safeQuery(pool, "totalTechnicians", "SELECT COUNT(*) AS total FROM technicians"),
      safeQuery(pool, "totalRequests", "SELECT COUNT(*) AS total FROM service_requests"),
      safeQuery(
        pool,
        "completedRequests",
        `SELECT COUNT(*) AS total
         FROM service_requests
         WHERE LOWER(COALESCE(status, '')) IN ('completed', 'paid')`
      ),
      safeQuery(
        pool,
        "activeUsers",
        `SELECT COUNT(DISTINCT user_id) AS total
         FROM service_requests
         WHERE user_id IS NOT NULL
           AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`
      ),
      safeQuery(
        pool,
        "totalRevenue",
        `SELECT IFNULL(SUM(p.amount), 0) AS total
         FROM payments p
         LEFT JOIN service_requests sr ON sr.id = p.service_request_id
         WHERE LOWER(COALESCE(p.status, '')) = 'completed'
           AND (sr.id IS NULL OR LOWER(COALESCE(sr.status, '')) <> 'cancelled')`
      ),
      safeQuery(
        pool,
        "monthlyRequests",
        `SELECT DATE_FORMAT(created_at, '%Y-%m') AS year_month, COUNT(*) AS request_count
         FROM service_requests
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
         GROUP BY DATE_FORMAT(created_at, '%Y-%m')
         ORDER BY year_month ASC`
      ),
      safeQuery(
        pool,
        "monthlyTechnicians",
        `SELECT DATE_FORMAT(created_at, '%Y-%m') AS year_month, COUNT(*) AS technician_count
         FROM technicians
         WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
         GROUP BY DATE_FORMAT(created_at, '%Y-%m')
         ORDER BY year_month ASC`
      ),
    ]);

    const requestsOverTime = (requestsOverTimeRows || []).map((row) => ({
      date: toDayKey(row.day),
      count: Number(row.request_count || 0),
    })).filter((row) => row.date);

    const requestsPerDay = buildDailySeries(requestsOverTimeRows, daysBack);
    const peakHours = peakHoursRows.map((row) => ({
      hourOfDay: Number(row.hour_of_day || 0),
      requestCount: Number(row.request_count || 0),
    }));
    const issueCategoryBreakdown = serviceDistributionRows.map((row) => ({
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

    const monthlyData = buildLastSixMonthsSeries(monthlyRequestRows, monthlyTechnicianRows);
    const serviceDistribution = issueCategoryBreakdown.map((item, index) => ({
      name: item.issueCategory,
      value: item.requestCount,
      color: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length],
    }));

    const totalTechnicians = Number(techniciansRows?.[0]?.total || 0);
    const totalUsers = Number(usersRows?.[0]?.total || 0);
    const activeUsers = Number(activeUsersRows?.[0]?.total || 0);
    const totalRequests = Number(totalRequestsRows?.[0]?.total || 0);
    const completedRequests = Number(completedRequestsRows?.[0]?.total || 0);
    const revenue = Number(revenueRows?.[0]?.total || 0);

    return res.json({
      totalTechnicians,
      totalRequests,
      completedRequests,
      activeUsers,
      revenue,
      requestsOverTime,
      serviceDistribution,
      requestsPerDay,
      peakHours,
      issueCategoryBreakdown,
      technicianUtilization,
      // Keep legacy keys for existing /admin analytics page compatibility.
      totalUsers,
      totalServiceRequests: totalRequests,
      totalRevenue: revenue,
      monthlyData,
    });
  } catch (error) {
    console.error("[admin.analytics] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch analytics." });
  }
}
