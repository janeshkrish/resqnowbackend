import { getPool } from "../db.js";
import { buildPagination, likeFilter, toNumber, toPositiveInt } from "./utils.js";

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows) {
  const headers = ["transactionId", "user", "technician", "amount", "status", "date"];
  const lines = [headers.join(",")];

  rows.forEach((row) => {
    lines.push([
      csvEscape(row.transactionId),
      csvEscape(row.user),
      csvEscape(row.technician),
      csvEscape(row.amount),
      csvEscape(row.status),
      csvEscape(row.date),
    ].join(","));
  });

  return `${lines.join("\n")}\n`;
}

function mapTransaction(row) {
  return {
    transactionId: row.transaction_id,
    requestId: row.request_id ?? null,
    user: row.user_name,
    technician: row.technician_name,
    amount: Number(row.amount || 0),
    status: row.status,
    date: row.created_at,
  };
}

export async function getFinanceSummary(_req, res) {
  try {
    const pool = await getPool();

    const [
      [todayRevenueRows],
      [pendingPaymentsRows],
      [completedTransactionsRows],
    ] = await Promise.all([
      pool.query(
        `SELECT IFNULL(SUM(p.amount), 0) AS total
         FROM payments p
         LEFT JOIN service_requests sr ON sr.id = p.service_request_id
         WHERE LOWER(COALESCE(
           CASE
             WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
             WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
             ELSE p.status
           END,
           ''
         )) = 'completed'
           AND DATE(p.created_at) = CURDATE()`
      ),
      pool.query(
        `SELECT COUNT(*) AS count
         FROM payments p
         LEFT JOIN service_requests sr ON sr.id = p.service_request_id
         WHERE LOWER(COALESCE(
           CASE
             WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
             WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
             ELSE p.status
           END,
           ''
         )) IN ('pending', 'processing')`
      ),
      pool.query(
        `SELECT COUNT(*) AS count
         FROM payments p
         LEFT JOIN service_requests sr ON sr.id = p.service_request_id
         WHERE LOWER(COALESCE(
           CASE
             WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
             WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
             ELSE p.status
           END,
           ''
         )) = 'completed'`
      ),
    ]);

    return res.json({
      todayRevenue: Number(toNumber(todayRevenueRows?.[0]?.total).toFixed(2)),
      pendingPayments: Number(pendingPaymentsRows?.[0]?.count || 0),
      completedTransactions: Number(completedTransactionsRows?.[0]?.count || 0),
    });
  } catch (error) {
    console.error("[admin.finance.summary] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch finance summary." });
  }
}

export async function getFinanceTransactions(req, res) {
  try {
    const { page, limit, offset } = buildPagination(req.query);
    const search = String(req.query?.search || "").trim();
    const status = String(req.query?.status || "").trim().toLowerCase();

    const whereClauses = [];
    const values = [];

    if (search) {
      const like = likeFilter(search.toLowerCase());
      whereClauses.push(`(
        CAST(p.id AS CHAR) LIKE ?
        OR LOWER(COALESCE(u.full_name, '')) LIKE ?
        OR LOWER(COALESCE(t.name, '')) LIKE ?
      )`);
      values.push(like, like, like);
    }

    if (status && status !== "all") {
      whereClauses.push(`LOWER(COALESCE(
        CASE
          WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
          WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
          ELSE p.status
        END,
        ''
      )) = ?`);
      values.push(status);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         p.id AS transaction_id,
         p.service_request_id AS request_id,
         COALESCE(u.full_name, CONCAT('User #', p.user_id)) AS user_name,
         COALESCE(t.name, 'Unassigned') AS technician_name,
         p.amount,
         CASE
           WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
           WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
           ELSE p.status
         END AS status,
         p.created_at
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       ${whereSql}`,
      values
    );

    const total = Number(countRows?.[0]?.total || 0);

    return res.json({
      data: rows.map(mapTransaction),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error("[admin.finance.transactions] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch transactions." });
  }
}

export async function exportFinanceCsv(req, res) {
  try {
    const days = toPositiveInt(req.query?.days, 30, { min: 1, max: 365 });
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         p.id AS transaction_id,
         p.service_request_id AS request_id,
         COALESCE(u.full_name, CONCAT('User #', p.user_id)) AS user_name,
         COALESCE(t.name, 'Unassigned') AS technician_name,
         p.amount,
         CASE
           WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
           WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
           ELSE p.status
         END AS status,
         p.created_at
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       WHERE p.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY p.created_at DESC`,
      [days]
    );

    const csv = buildCsv(rows.map(mapTransaction));
    const fileName = `admin_finance_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error("[admin.finance.export] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to export CSV." });
  }
}

export async function getFlaggedPayments(req, res) {
  try {
    const limit = toPositiveInt(req.query?.limit, 100, { min: 1, max: 500 });
    const pool = await getPool();

    const [rows] = await pool.query(
      `SELECT
         p.id AS transaction_id,
         p.service_request_id AS request_id,
         COALESCE(u.full_name, CONCAT('User #', p.user_id)) AS user_name,
         COALESCE(t.name, 'Unassigned') AS technician_name,
         p.amount,
         CASE
           WHEN LOWER(COALESCE(sr.status, '')) = 'cancelled' THEN 'cancelled'
           WHEN LOWER(COALESCE(sr.status, '')) IN ('completed', 'paid') THEN 'completed'
           ELSE p.status
         END AS status,
         p.created_at,
         CASE
           WHEN LOWER(COALESCE(p.status, '')) IN ('pending', 'processing')
            AND p.created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
             THEN 'stale_pending'
           WHEN LOWER(COALESCE(p.payment_method, '')) = 'razorpay'
            AND (COALESCE(p.razorpay_order_id, '') = '' OR COALESCE(p.razorpay_payment_id, '') = '')
             THEN 'missing_razorpay_reference'
           WHEN LOWER(COALESCE(p.status, '')) = 'completed' AND COALESCE(p.amount, 0) <= 0
             THEN 'invalid_completed_amount'
           ELSE 'manual_review'
         END AS flag_reason
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       WHERE (
         (LOWER(COALESCE(p.status, '')) IN ('pending', 'processing')
           AND p.created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
         OR (LOWER(COALESCE(p.payment_method, '')) = 'razorpay'
           AND (COALESCE(p.razorpay_order_id, '') = '' OR COALESCE(p.razorpay_payment_id, '') = ''))
         OR (LOWER(COALESCE(p.status, '')) = 'completed' AND COALESCE(p.amount, 0) <= 0)
       )
       AND (sr.id IS NULL OR LOWER(COALESCE(sr.status, '')) <> 'cancelled')
       ORDER BY p.created_at DESC
       LIMIT ?`,
      [limit]
    );

    return res.json({
      data: rows.map((row) => ({
        ...mapTransaction(row),
        flagReason: row.flag_reason,
      })),
      totalFlagged: rows.length,
    });
  } catch (error) {
    console.error("[admin.finance.flagged] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch flagged payments." });
  }
}
