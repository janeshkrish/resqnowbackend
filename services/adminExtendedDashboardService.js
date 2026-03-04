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
       WHERE LOWER(COALESCE(status, '')) IN ('pending', 'assigned', 'processing')`
    ),
    pool.query(
      `SELECT COUNT(*) AS count
       FROM technicians
       WHERE (
         LOWER(COALESCE(status, '')) = 'online'
         OR (
           LOWER(COALESCE(status, '')) = 'approved'
           AND is_active = TRUE
         )
       )
         AND is_available = TRUE`
    ),
    pool.query(
      `SELECT COUNT(*) AS count
       FROM service_requests
       WHERE LOWER(COALESCE(status, '')) = 'completed'
         AND DATE(COALESCE(updated_at, completed_at, created_at)) = CURDATE()`
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
      `SELECT IFNULL(SUM(p.amount), 0) AS total
       FROM payments p
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       WHERE LOWER(COALESCE(p.status, '')) = 'completed'
         AND DATE(p.created_at) = CURDATE()
         AND (sr.id IS NULL OR LOWER(COALESCE(sr.status, '')) <> 'cancelled')`
    ),
    pool.query(
      `SELECT COUNT(*) AS count
       FROM payments
       WHERE LOWER(COALESCE(status, '')) = 'processing'`
    ),
  ]);

  const activeRequests = adminExtendedToNumber(activeRequestsRows?.[0]?.count);
  const availableTechnicians = adminExtendedToNumber(availableTechniciansRows?.[0]?.count);
  const completedToday = adminExtendedToNumber(completedTodayRows?.[0]?.count);
  const avgResponseTime = Number(adminExtendedToNumber(avgResponseRows?.[0]?.avg_response_minutes).toFixed(2));
  const todayRevenue = Number(adminExtendedToNumber(todayRevenueRows?.[0]?.total).toFixed(2));
  const pendingPayments = adminExtendedToNumber(pendingPaymentsRows?.[0]?.count);

  return {
    activeRequests,
    availableTechnicians,
    completedToday,
    avgResponseTime,
    todayRevenue,
    pendingPayments,
    // Keep legacy keys for existing /api/admin-extended/dashboard consumers.
    activeRequestsCount: activeRequests,
    availableTechniciansCount: availableTechnicians,
  };
}

