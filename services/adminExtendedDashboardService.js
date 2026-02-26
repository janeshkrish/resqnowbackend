import { getPool } from "../db.js";

function adminExtendedToNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function adminExtendedGetDashboardMetrics() {
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
         AND is_active = TRUE
         AND is_available = TRUE`
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

  return {
    activeRequestsCount: adminExtendedToNumber(activeRequestsRows?.[0]?.count),
    availableTechniciansCount: adminExtendedToNumber(availableTechniciansRows?.[0]?.count),
    completedToday: adminExtendedToNumber(completedTodayRows?.[0]?.count),
    avgResponseTime: Number(adminExtendedToNumber(avgResponseRows?.[0]?.avg_response_minutes).toFixed(2)),
    todayRevenue: Number(adminExtendedToNumber(todayRevenueRows?.[0]?.total).toFixed(2)),
    pendingPayments: adminExtendedToNumber(pendingPaymentsRows?.[0]?.count),
  };
}

