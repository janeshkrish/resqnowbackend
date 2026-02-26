import { Router } from "express";
import { getPool } from "../db.js";
import { requireAdminExtendedAccess } from "../middleware/adminExtendedAccess.js";
import { adminExtendedAuditLogger } from "../middleware/adminExtendedAuditLogger.js";
import { ensureAdminExtendedSchema } from "../services/adminExtendedSchema.js";

const router = Router();

function adminExtendedEscapeCsv(value) {
  if (value == null) return "";
  const asString = String(value);
  if (asString.includes("\"") || asString.includes(",") || asString.includes("\n")) {
    return `"${asString.replace(/"/g, "\"\"")}"`;
  }
  return asString;
}

function adminExtendedBuildCsv(rows) {
  const headers = [
    "payment_id",
    "service_request_id",
    "user_id",
    "payment_method",
    "status",
    "amount",
    "platform_fee",
    "technician_amount",
    "is_settled",
    "razorpay_order_id",
    "razorpay_payment_id",
    "created_at",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((header) => adminExtendedEscapeCsv(row[header]));
    lines.push(values.join(","));
  }
  return `${lines.join("\n")}\n`;
}

router.use(requireAdminExtendedAccess);
router.use(async (_req, res, next) => {
  try {
    await ensureAdminExtendedSchema();
    return next();
  } catch (error) {
    console.error("[adminExtended.finance] schema ensure failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to initialize adminExtended schema." });
  }
});
router.use(adminExtendedAuditLogger);

router.get("/finance/transaction-audit-list", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.finance.transactionAuditList";
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const statusFilter = String(req.query.status || "").trim().toLowerCase();
    const methodFilter = String(req.query.paymentMethod || "").trim().toLowerCase();

    const whereClauses = [];
    const values = [];
    if (statusFilter) {
      whereClauses.push("LOWER(COALESCE(p.status, '')) = ?");
      values.push(statusFilter);
    }
    if (methodFilter) {
      whereClauses.push("LOWER(COALESCE(p.payment_method, '')) = ?");
      values.push(methodFilter);
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         p.id AS payment_id,
         p.service_request_id,
         p.user_id,
         p.payment_method,
         p.status,
         p.amount,
         p.platform_fee,
         p.technician_amount,
         p.is_settled,
         p.razorpay_order_id,
         p.razorpay_payment_id,
         p.created_at,
         sr.status AS request_status,
         sr.payment_status AS request_payment_status,
         u.full_name AS user_name,
         t.name AS technician_name
       FROM payments p
       LEFT JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM payments p
       ${whereSql}`,
      values
    );

    return res.json({
      transactionAuditList: rows,
      pagination: {
        limit,
        offset,
        total: Number(countRows?.[0]?.total || 0),
      },
    });
  } catch (error) {
    console.error("[adminExtended.finance] transaction audit failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch payment transaction audit list." });
  }
});

router.get("/finance/flagged-payments", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.finance.flaggedPayments";
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const pool = await getPool();

    const [rows] = await pool.query(
      `SELECT
         p.id AS payment_id,
         p.service_request_id,
         p.user_id,
         p.payment_method,
         p.status,
         p.amount,
         p.platform_fee,
         p.technician_amount,
         p.is_settled,
         p.razorpay_order_id,
         p.razorpay_payment_id,
         p.created_at,
         CASE
           WHEN LOWER(COALESCE(p.status, '')) IN ('pending', 'processing')
            AND p.created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
             THEN 'stale_pending'
           WHEN LOWER(COALESCE(p.payment_method, '')) = 'razorpay'
            AND (COALESCE(p.razorpay_order_id, '') = '' OR COALESCE(p.razorpay_payment_id, '') = '')
             THEN 'missing_razorpay_reference'
           WHEN LOWER(COALESCE(p.status, '')) = 'completed'
            AND COALESCE(p.amount, 0) <= 0
             THEN 'invalid_completed_amount'
           ELSE 'manual_review'
         END AS flag_reason
       FROM payments p
       WHERE (
         (LOWER(COALESCE(p.status, '')) IN ('pending', 'processing')
           AND p.created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
         OR
         (LOWER(COALESCE(p.payment_method, '')) = 'razorpay'
           AND (COALESCE(p.razorpay_order_id, '') = '' OR COALESCE(p.razorpay_payment_id, '') = ''))
         OR
         (LOWER(COALESCE(p.status, '')) = 'completed' AND COALESCE(p.amount, 0) <= 0)
       )
       ORDER BY p.created_at DESC
       LIMIT ?`,
      [limit]
    );

    return res.json({
      flaggedPayments: rows,
      totalFlagged: rows.length,
    });
  } catch (error) {
    console.error("[adminExtended.finance] flagged payments failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch flagged payments." });
  }
});

router.get("/finance/export-payments-csv", async (req, res) => {
  req.adminExtendedActionType = "adminExtended.finance.exportPaymentsCSV";
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         id AS payment_id,
         service_request_id,
         user_id,
         payment_method,
         status,
         amount,
         platform_fee,
         technician_amount,
         is_settled,
         razorpay_order_id,
         razorpay_payment_id,
         created_at
       FROM payments
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY created_at DESC`,
      [days]
    );

    const csv = adminExtendedBuildCsv(rows);
    const fileName = `adminExtended_payments_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error("[adminExtended.finance] export csv failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to export payments CSV." });
  }
});

export default router;

