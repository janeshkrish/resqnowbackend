import { getPool } from "../db.js";
import { buildPagination, likeFilter, toNumber, toPositiveInt } from "./utils.js";
import {
  createTechnicianWalletPayout,
  exportEligiblePayoutQueueCsv,
  getEligiblePayoutQueue,
  getPayoutHistory as getMarketplacePayoutHistory,
  getTechnicianWalletBalances,
  settlePaymentToTechnician,
} from "../services/marketplacePayoutService.js";
import { refundMarketplacePayment } from "../services/marketplaceRefundService.js";

const PAYMENT_TO_TECHNICIAN_STATUS = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  notApplicable: "not_applicable",
});

function roundMoney(value) {
  return Number((toNumber(value) + Number.EPSILON).toFixed(2));
}

function normalizePaymentToTechnicianStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === PAYMENT_TO_TECHNICIAN_STATUS.completed) {
    return PAYMENT_TO_TECHNICIAN_STATUS.completed;
  }
  if (normalized === PAYMENT_TO_TECHNICIAN_STATUS.processing) {
    return PAYMENT_TO_TECHNICIAN_STATUS.processing;
  }
  if (normalized === PAYMENT_TO_TECHNICIAN_STATUS.notApplicable) {
    return PAYMENT_TO_TECHNICIAN_STATUS.notApplicable;
  }
  return PAYMENT_TO_TECHNICIAN_STATUS.pending;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows) {
  const headers = [
    "transactionId",
    "requestId",
    "user",
    "technician",
    "upiId",
    "amount",
    "platformFee",
    "paymentFee",
    "platformRevenue",
    "technicianAmount",
    "paymentToTechnicianStatus",
    "status",
    "date",
  ];
  const lines = [headers.join(",")];

  rows.forEach((row) => {
    lines.push([
      csvEscape(row.transactionId),
      csvEscape(row.requestId),
      csvEscape(row.user),
      csvEscape(row.technician),
      csvEscape(row.upiId),
      csvEscape(row.amount),
      csvEscape(row.platformFee),
      csvEscape(row.paymentFee),
      csvEscape(row.platformRevenue),
      csvEscape(row.technicianAmount),
      csvEscape(row.paymentToTechnicianStatus),
      csvEscape(row.status),
      csvEscape(row.date),
    ].join(","));
  });

  return `${lines.join("\n")}\n`;
}

function resolvePaymentBreakdown(row) {
  const totalAmount = roundMoney(row?.amount || 0);
  const explicitTechnicianAmount = toNumber(row?.technician_amount);
  const explicitPlatformFee = toNumber(row?.platform_fee);
  const explicitPaymentFee = toNumber(row?.payment_fee);

  const technicianAmount = explicitTechnicianAmount > 0
    ? roundMoney(explicitTechnicianAmount)
    : roundMoney(Math.max(0, totalAmount - Math.max(0, explicitPlatformFee)));
  const platformFee = explicitPlatformFee >= 0
    ? roundMoney(explicitPlatformFee)
    : roundMoney(Math.max(0, totalAmount - technicianAmount));
  const paymentFee = explicitPaymentFee >= 0 ? roundMoney(explicitPaymentFee) : 0;

  return {
    totalAmount,
    technicianAmount,
    platformFee,
    paymentFee,
    platformRevenue: roundMoney(platformFee + paymentFee),
  };
}

function mapTransaction(row) {
  const { totalAmount, technicianAmount, platformFee, paymentFee, platformRevenue } = resolvePaymentBreakdown(row);
  return {
    transactionId: row.transaction_id,
    requestId: row.request_id ?? null,
    user: row.user_name,
    technician: row.technician_name,
    upiId: row.upi_id || null,
    amount: totalAmount,
    platformFee,
    paymentFee,
    platformRevenue,
    technicianAmount,
    paymentToTechnicianStatus: normalizePaymentToTechnicianStatus(row.payment_to_technician_status),
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
        `SELECT IFNULL(SUM(COALESCE(p.platform_fee, 0) + COALESCE(p.payment_fee, 0)), 0) AS total
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
        OR LOWER(COALESCE(NULLIF(TRIM(t.upi_id), ''), JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id')), '')) LIKE ?
      )`);
      values.push(like, like, like, like);
    }

    if (status && status !== "all") {
      if (status === "payment_pending") {
        whereClauses.push(
          "LOWER(COALESCE(NULLIF(TRIM(p.payment_to_technician_status), ''), 'pending')) = ?"
        );
        values.push(PAYMENT_TO_TECHNICIAN_STATUS.pending);
      } else if (status === "payment_completed") {
        whereClauses.push(
          "LOWER(COALESCE(NULLIF(TRIM(p.payment_to_technician_status), ''), 'pending')) = ?"
        );
        values.push(PAYMENT_TO_TECHNICIAN_STATUS.completed);
      } else {
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
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const pool = await getPool();
    const [rows] = await pool.query(
      `SELECT
         p.id AS transaction_id,
         p.service_request_id AS request_id,
         COALESCE(u.full_name, CONCAT('User #', p.user_id)) AS user_name,
         COALESCE(t.name, 'Unassigned') AS technician_name,
         COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id,
         p.amount,
         p.platform_fee,
         p.payment_fee,
         p.technician_amount,
         COALESCE(NULLIF(LOWER(TRIM(p.payment_to_technician_status)), ''), 'pending') AS payment_to_technician_status,
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
         COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id,
         p.amount,
         p.platform_fee,
         p.payment_fee,
         p.technician_amount,
         COALESCE(NULLIF(LOWER(TRIM(p.payment_to_technician_status)), ''), 'pending') AS payment_to_technician_status,
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

export async function markTechnicianPaymentCompleted(req, res) {
  try {
    const transactionId = Number.parseInt(String(req.params?.transactionId || req.params?.id || ""), 10);
    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({ error: "Invalid transaction id." });
    }
    const result = await settlePaymentToTechnician({
      paymentId: transactionId,
      adminId: String(req.adminEmail || req.admin?.email || "admin"),
      payoutMethod: String(req.body?.payoutMethod || "").trim() || undefined,
      notes: String(req.body?.notes || "").trim(),
      externalReference: String(req.body?.externalReference || "").trim(),
      idempotencyKey:
        String(
          req.body?.idempotencyKey ||
          req.headers["x-idempotency-key"] ||
          ""
        ).trim() || `payment-payout:${transactionId}`,
    });

    req.io?.emit?.("admin:payment_update", {
      transactionId,
      paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.completed,
      at: new Date().toISOString(),
    });
    req.io?.emit?.("admin:payout_update", {
      payoutId: result.payoutId || null,
      transactionId,
      at: new Date().toISOString(),
    });

    return res.json({
      success: true,
      transactionId,
      paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.completed,
      alreadyCompleted: !!result.alreadyCompleted,
      payoutId: result.payoutId || null,
      idempotencyReused: !!result.idempotencyReused,
    });
  } catch (error) {
    console.error("[admin.finance.payTechnician] failed:", error?.message || error);
    if (String(error?.message || "").toLowerCase().includes("not found")) {
      return res.status(404).json({ error: error.message });
    }
    if (String(error?.message || "").toLowerCase().includes("no technician")) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to update technician payment status." });
  }
}

export async function getWalletBalances(req, res) {
  try {
    const { page, limit } = buildPagination(req.query);
    const search = String(req.query?.search || "").trim();
    const onlyPositiveBalance = parseBoolean(req.query?.onlyPositiveBalance, false);
    const result = await getTechnicianWalletBalances({
      page,
      limit,
      search,
      onlyPositiveBalance,
    });
    return res.json(result);
  } catch (error) {
    console.error("[admin.finance.walletBalances] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch technician wallet balances." });
  }
}

export async function triggerWalletPayout(req, res) {
  try {
    const technicianId = Number.parseInt(String(req.body?.technicianId || ""), 10);
    if (!Number.isInteger(technicianId) || technicianId <= 0) {
      return res.status(400).json({ error: "Invalid technician id." });
    }

    const amount =
      req.body?.amount == null || req.body?.amount === ""
        ? null
        : Number(req.body.amount);
    if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
      return res.status(400).json({ error: "Invalid payout amount." });
    }

    const result = await createTechnicianWalletPayout({
      technicianId,
      amount,
      adminId: String(req.adminEmail || req.admin?.email || "admin"),
      payoutMethod: String(req.body?.payoutMethod || "").trim() || undefined,
      notes: String(req.body?.notes || "").trim(),
      externalReference: String(req.body?.externalReference || "").trim(),
      idempotencyKey: String(req.body?.idempotencyKey || req.headers["x-idempotency-key"] || "").trim(),
    });

    req.io?.emit?.("admin:payout_update", {
      payoutId: result.payoutId || null,
      technicianId,
      amount: result.amount,
      at: new Date().toISOString(),
    });
    req.io?.emit?.("admin:payment_update", {
      technicianId,
      at: new Date().toISOString(),
    });

    return res.status(result.alreadyProcessed ? 200 : 201).json(result);
  } catch (error) {
    console.error("[admin.finance.triggerPayout] failed:", error?.message || error);
    const message = String(error?.message || "Failed to trigger payout.");
    if (
      message.includes("No withdrawable balance") ||
      message.includes("Requested payout exceeds") ||
      message.includes("Technician not found")
    ) {
      return res.status(409).json({ error: message });
    }
    return res.status(500).json({ error: "Failed to trigger payout." });
  }
}

export async function getPayoutQueue(req, res) {
  try {
    const limit = toPositiveInt(req.query?.limit, 500, { min: 1, max: 1000 });
    const data = await getEligiblePayoutQueue({ limit });
    return res.json({
      data,
      total: data.length,
    });
  } catch (error) {
    console.error("[admin.finance.payoutQueue] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch payout queue." });
  }
}

export async function exportPayoutQueueCsv(req, res) {
  try {
    const limit = toPositiveInt(req.query?.limit, 500, { min: 1, max: 1000 });
    const csv = await exportEligiblePayoutQueueCsv({ limit });
    const fileName = `payout_queue_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error("[admin.finance.exportPayoutQueue] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to export payout queue." });
  }
}

export async function getPayoutHistory(req, res) {
  try {
    const { page, limit } = buildPagination(req.query);
    const search = String(req.query?.search || "").trim();
    const result = await getMarketplacePayoutHistory({ page, limit, search });
    return res.json(result);
  } catch (error) {
    console.error("[admin.finance.payoutHistory] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch payout history." });
  }
}

export async function refundTransaction(req, res) {
  try {
    const transactionId = Number.parseInt(String(req.params?.transactionId || req.params?.id || ""), 10);
    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({ error: "Invalid transaction id." });
    }

    const refundAmount =
      req.body?.refundAmount == null || req.body?.refundAmount === ""
        ? null
        : Number(req.body.refundAmount);
    if (refundAmount != null && (!Number.isFinite(refundAmount) || refundAmount <= 0)) {
      return res.status(400).json({ error: "Invalid refund amount." });
    }

    const result = await refundMarketplacePayment({
      paymentId: transactionId,
      refundAmount,
      reason: String(req.body?.reason || "").trim(),
      externalReference: String(req.body?.externalReference || "").trim(),
      adminId: String(req.adminEmail || req.admin?.email || "admin"),
      idempotencyKey: String(req.body?.idempotencyKey || req.headers["x-idempotency-key"] || "").trim(),
      useGateway: parseBoolean(req.body?.useGateway, true),
      gatewayRefundId: String(req.body?.gatewayRefundId || "").trim(),
    });

    req.io?.emit?.("admin:payment_update", {
      transactionId,
      refundStatus: result.refundStatus,
      at: new Date().toISOString(),
    });

    return res.json(result);
  } catch (error) {
    console.error("[admin.finance.refund] failed:", error?.message || error);
    const message = String(error?.message || "Failed to process refund.");
    if (error?.gatewayRefundId) {
      return res.status(502).json({
        error: `${message} Gateway refund was created, but internal ledger sync needs a retry.`,
        gatewayRefundId: error.gatewayRefundId,
      });
    }
    if (
      message.includes("not found") ||
      message.includes("Only completed payments") ||
      message.includes("Refund amount") ||
      message.includes("Cannot auto-refund") ||
      message.includes("insufficient")
    ) {
      return res.status(409).json({ error: message });
    }
    return res.status(500).json({ error: "Failed to process refund." });
  }
}

export async function getRefundHistory(req, res) {
  try {
    const transactionId = Number.parseInt(String(req.params?.transactionId || req.params?.id || ""), 10);
    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return res.status(400).json({ error: "Invalid transaction id." });
    }

    const pool = await getPool();
    const [paymentRows] = await pool.query(
      `SELECT
         id,
         amount,
         refunded_amount,
         refund_status,
         status,
         payment_method,
         payment_to_technician_status
       FROM payments
       WHERE id = ?
       LIMIT 1`,
      [transactionId]
    );
    const paymentRow = paymentRows?.[0];
    if (!paymentRow) {
      return res.status(404).json({ error: "Transaction not found." });
    }

    const [refundRows] = await pool.query(
      `SELECT
         id,
         refund_reference,
         idempotency_key,
         payment_id,
         service_request_id,
         technician_id,
         wallet_transaction_id,
         amount,
         technician_adjustment_amount,
         status,
         reason,
         external_reference,
         requested_by,
         processed_at,
         created_at,
         metadata
       FROM payment_refunds
       WHERE payment_id = ?
       ORDER BY created_at DESC, id DESC`,
      [transactionId]
    );

    const totalAmount = roundMoney(paymentRow.amount || 0);
    const refundedAmount = roundMoney(paymentRow.refunded_amount || 0);
    const remainingRefundable = Math.max(0, roundMoney(totalAmount - refundedAmount));

    return res.json({
      paymentId: transactionId,
      totalAmount,
      refundedAmount,
      remainingRefundable,
      refundStatus: paymentRow.refund_status || "none",
      paymentStatus: paymentRow.status || null,
      paymentMethod: paymentRow.payment_method || null,
      paymentToTechnicianStatus: paymentRow.payment_to_technician_status || null,
      refunds: (refundRows || []).map((row) => ({
        id: Number(row.id),
        refundReference: row.refund_reference,
        idempotencyKey: row.idempotency_key || null,
        paymentId: Number(row.payment_id),
        serviceRequestId: Number(row.service_request_id),
        technicianId: row.technician_id != null ? Number(row.technician_id) : null,
        walletTransactionId: row.wallet_transaction_id != null ? Number(row.wallet_transaction_id) : null,
        amount: roundMoney(row.amount || 0),
        technicianAdjustmentAmount: roundMoney(row.technician_adjustment_amount || 0),
        status: row.status || "processed",
        reason: row.reason || null,
        externalReference: row.external_reference || null,
        requestedBy: row.requested_by || null,
        processedAt: row.processed_at || null,
        createdAt: row.created_at || null,
        metadata: safeJsonParse(row.metadata, null),
      })),
    });
  } catch (error) {
    console.error("[admin.finance.refundHistory] failed:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch refund history." });
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
         COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id,
         p.amount,
         p.platform_fee,
         p.payment_fee,
         p.technician_amount,
         COALESCE(NULLIF(LOWER(TRIM(p.payment_to_technician_status)), ''), 'pending') AS payment_to_technician_status,
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
