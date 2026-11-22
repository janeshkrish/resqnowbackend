import { randomUUID } from 'node:crypto';
import { getPool } from '../db.js';

export async function recordPageVisit({
  id: providedId,
  ipAddress,
  pageVisited,
  previousPage,
  timeSpentSeconds = 0,
  device = 'Unknown',
  browser = 'Unknown',
  location = 'Local/Unknown',
  sessionId,
  userName = null,
  userEmail = null,
  userPhone = null,
  userRole = null,
  poolLike,
}) {
  const pool = poolLike || (await getPool());
  const id = providedId && typeof providedId === 'string' && /^[0-9a-f-]{36}$/i.test(providedId)
    ? providedId
    : randomUUID();

  const timeSpent = Math.max(0, Math.min(86400, parseInt(timeSpentSeconds, 10) || 0));
  const cleanPage = String(pageVisited || '/').slice(0, 255);
  const cleanPrev = String(previousPage || 'direct').slice(0, 255);
  const cleanDevice = String(device || 'Unknown').slice(0, 100);
  const cleanBrowser = String(browser || 'Unknown').slice(0, 100);
  const cleanLocation = String(location || 'Local/Unknown').slice(0, 150);
  const cleanSession = String(sessionId || id).slice(0, 64);
  const cleanIp = String(ipAddress || '127.0.0.1').slice(0, 45);
  const cleanName = userName ? String(userName).slice(0, 120) : null;
  const cleanEmail = userEmail ? String(userEmail).slice(0, 150) : null;
  const cleanPhone = userPhone ? String(userPhone).slice(0, 40) : null;
  const cleanRole = userRole ? String(userRole).slice(0, 40) : null;

  const sql = `
    INSERT INTO page_visit (
      id, ip_address, page_visited, previous_page, time_spent_seconds,
      device, browser, location, session_id, user_name, user_email, user_phone, user_role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
    ON DUPLICATE KEY UPDATE
      time_spent_seconds = VALUES(time_spent_seconds),
      user_name = COALESCE(VALUES(user_name), user_name),
      user_email = COALESCE(VALUES(user_email), user_email),
      user_phone = COALESCE(VALUES(user_phone), user_phone),
      user_role = COALESCE(VALUES(user_role), user_role)
  `;

  await pool.execute(sql, [
    id,
    cleanIp,
    cleanPage,
    cleanPrev,
    timeSpent,
    cleanDevice,
    cleanBrowser,
    cleanLocation,
    cleanSession,
    cleanName,
    cleanEmail,
    cleanPhone,
    cleanRole,
  ]);

  return { id, success: true };
}

function resolveDateFilter(range = 'today') {
  switch (range) {
    case 'today':
      return 'created_at >= CURDATE()';
    case '7d':
      return 'created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    case '30d':
      return 'created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    case '90d':
      return 'created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)';
    case 'all':
      return '1=1';
    default:
      return 'created_at >= CURDATE()';
  }
}

export async function getPageVisitSummary({ range = 'today', poolLike } = {}) {
  const pool = poolLike || (await getPool());
  const dateFilter = resolveDateFilter(range);

  // 1. Overall counts
  const [statsRows] = await pool.query(`
    SELECT
      COUNT(DISTINCT ip_address) AS visitorsToday,
      COUNT(*) AS pageViewsToday,
      COALESCE(AVG(time_spent_seconds), 0) AS avgTimeOnPageSeconds
    FROM page_visit
    WHERE ${dateFilter}
  `);

  const visitorsToday = Number(statsRows[0]?.visitorsToday || 0);
  const pageViewsToday = Number(statsRows[0]?.pageViewsToday || 0);
  const avgTimeOnPageSeconds = Math.round(Number(statsRows[0]?.avgTimeOnPageSeconds || 0));

  // 2. Top page
  const [topPageRows] = await pool.query(`
    SELECT page_visited, COUNT(*) AS count
    FROM page_visit
    WHERE ${dateFilter}
    GROUP BY page_visited
    ORDER BY count DESC
    LIMIT 1
  `);

  const topPageToday = topPageRows[0]?.page_visited || null;
  const topPageViews = Number(topPageRows[0]?.count || 0);

  // 3. Top source
  const [topSourceRows] = await pool.query(`
    SELECT previous_page, COUNT(*) AS count
    FROM page_visit
    WHERE ${dateFilter}
    GROUP BY previous_page
    ORDER BY count DESC
    LIMIT 1
  `);

  const topSourceToday = topSourceRows[0]?.previous_page || null;
  const topSourceVisits = Number(topSourceRows[0]?.count || 0);

  return {
    visitorsToday,
    pageViewsToday,
    avgTimeOnPageSeconds,
    topPageToday,
    topPageViews,
    topSourceToday,
    topSourceVisits,
  };
}

export async function listPageVisits({
  page = 1,
  limit = 25,
  range = 'today',
  source,
  device,
  browser,
  search,
  poolLike,
} = {}) {
  const pool = poolLike || (await getPool());
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 25));
  const offset = (safePage - 1) * safeLimit;

  const conditions = [resolveDateFilter(range)];
  const params = [];

  if (source && typeof source === 'string') {
    conditions.push('previous_page = ?');
    params.push(source.trim());
  }

  if (device && typeof device === 'string') {
    conditions.push('device = ?');
    params.push(device.trim());
  }

  if (browser && typeof browser === 'string') {
    conditions.push('browser = ?');
    params.push(browser.trim());
  }

  if (search && typeof search === 'string' && search.trim()) {
    const q = `%${search.trim()}%`;
    conditions.push('(page_visited LIKE ? OR ip_address LIKE ? OR location LIKE ? OR previous_page LIKE ? OR user_name LIKE ? OR user_email LIKE ? OR user_phone LIKE ?)');
    params.push(q, q, q, q, q, q, q);
  }

  const whereClause = conditions.join(' AND ');

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM page_visit WHERE ${whereClause}`,
    params
  );
  const total = Number(countRows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));

  const [rows] = await pool.query(
    `
    SELECT
      id,
      ip_address,
      page_visited,
      previous_page,
      time_spent_seconds,
      device,
      browser,
      location,
      session_id,
      user_name,
      user_email,
      user_phone,
      user_role,
      created_at
    FROM page_visit
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
    `,
    [...params, safeLimit, offset]
  );

  const [sourcesRows] = await pool.query(
    `SELECT DISTINCT previous_page FROM page_visit WHERE ${resolveDateFilter(range)} ORDER BY previous_page ASC LIMIT 50`
  );
  const [devicesRows] = await pool.query(
    `SELECT DISTINCT device FROM page_visit WHERE ${resolveDateFilter(range)} ORDER BY device ASC LIMIT 50`
  );
  const [browsersRows] = await pool.query(
    `SELECT DISTINCT browser FROM page_visit WHERE ${resolveDateFilter(range)} ORDER BY browser ASC LIMIT 50`
  );

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages,
    sources: sourcesRows.map((r) => r.previous_page).filter(Boolean),
    devices: devicesRows.map((r) => r.device).filter(Boolean),
    browsers: browsersRows.map((r) => r.browser).filter(Boolean),
  };
}

export async function purgeExpiredPageVisits({ poolLike, retentionDays } = {}) {
  const pool = poolLike || (await getPool());
  const days = Math.max(1, parseInt(retentionDays || process.env.PAGE_VISIT_RETENTION_DAYS || '90', 10));

  const [result] = await pool.query(
    'DELETE FROM page_visit WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1000',
    [days]
  );
  return result?.affectedRows || 0;
}

export function startPageVisitMaintenance({ intervalMs = 3600000, enabled = () => true } = {}) {
  let inFlight = false;
  async function runCleanup() {
    if (!enabled() || inFlight) return;
    inFlight = true;
    try {
      let deleted = 0;
      do {
        deleted = await purgeExpiredPageVisits();
      } while (deleted === 1000);
    } catch (err) {
      console.warn('[PageVisitMaintenance] Cleanup warning:', err?.message || err);
    } finally {
      inFlight = false;
    }
  }

  setTimeout(() => void runCleanup(), 60000);
  const timer = setInterval(() => void runCleanup(), intervalMs);
  timer.unref?.();

  return {
    runCleanup,
    stop: () => clearInterval(timer),
  };
}
