import crypto from "crypto";
import { getPool } from "../db.js";
import {
  countTechnicianWalletBalances,
  createPayoutRecord,
  ensureTechnicianWallet,
  findPayoutByIdempotencyKey,
  getWalletCreditByPaymentIdForUpdate,
  listEligibleWallets,
  listTechnicianWalletBalances,
  listOpenWalletCreditsForUpdate,
  updatePaymentLedgerSnapshot,
  withTransaction,
} from "../repositories/marketplaceRepository.js";
import {
  PAYMENT_TO_TECHNICIAN_STATUS,
  PAYOUT_METHOD,
  PAYOUT_STATUS,
} from "../models/marketplaceConstants.js";
import { allocateWalletCreditToPayout } from "./marketplaceLedgerService.js";
import {
  debitTechnicianWalletForPayout,
  getTechnicianWalletSummary,
} from "./marketplaceWalletService.js";
import { roundMoney, subtractMoney } from "../utils/money.js";

function nextPayoutReference(prefix = "PAYOUT") {
  const nonce = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${Date.now()}-${nonce}`;
}

function csvEscape(value) {
  if (value == null) return "";
  const str = String(value);
  if (str.includes("\"") || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function buildPayoutIdempotencyKey({
  idempotencyKey,
  technicianId,
  paymentId = null,
  amount = null,
  externalReference = "",
}) {
  if (idempotencyKey) return String(idempotencyKey).trim();
  if (paymentId) return `payment-payout:${paymentId}`;
  return `wallet-payout:${technicianId}:${amount == null ? "full" : roundMoney(amount)}:${String(externalReference || "").trim() || "manual"}`;
}

function mapWalletBalanceRow(row) {
  return {
    walletId: Number(row.wallet_id || 0),
    technicianId: Number(row.technician_id),
    technicianName: row.technician_name,
    technicianEmail: row.technician_email,
    upiId: row.upi_id || null,
    upiName: row.upi_name || null,
    currency: String(row.currency || "INR").toUpperCase(),
    totalEarned: roundMoney(row.total_earned || 0),
    withdrawableBalance: roundMoney(row.withdrawable_balance || 0),
    totalPaidOut: roundMoney(row.total_paid_out || 0),
    onHoldBalance: roundMoney(row.on_hold_balance || 0),
    lastTransactionAt: row.last_transaction_at || null,
    walletUpdatedAt: row.wallet_updated_at || null,
  };
}

export async function settlePaymentToTechnician({
  paymentId,
  adminId,
  payoutMethod = PAYOUT_METHOD.manualUpi,
  notes = "",
  externalReference = "",
  idempotencyKey = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const resolvedIdempotencyKey = buildPayoutIdempotencyKey({
      idempotencyKey,
      paymentId,
      externalReference,
    });
    const existingPayout = await findPayoutByIdempotencyKey(conn, resolvedIdempotencyKey);
    if (existingPayout) {
      return {
        success: true,
        alreadyCompleted: true,
        paymentId,
        payoutId: Number(existingPayout.id),
        idempotencyReused: true,
      };
    }

    const [paymentRows] = await conn.query(
      `SELECT
         p.*,
         sr.technician_id,
         sr.id AS request_id,
         t.upi_id,
         JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id')) AS payment_details_upi_id
       FROM payments p
       JOIN service_requests sr ON sr.id = p.service_request_id
       LEFT JOIN technicians t ON t.id = sr.technician_id
       WHERE p.id = ?
       LIMIT 1
       FOR UPDATE`,
      [paymentId]
    );

    if (!paymentRows[0]) {
      throw new Error("Transaction not found.");
    }

    const paymentRow = paymentRows[0];
    const payoutStatus = String(paymentRow.payment_to_technician_status || "").trim().toLowerCase();
    if (payoutStatus === PAYMENT_TO_TECHNICIAN_STATUS.completed) {
      return {
        success: true,
        alreadyCompleted: true,
        paymentId,
        payoutId: null,
      };
    }

    if (!paymentRow.technician_id) {
      throw new Error("No technician is assigned to this transaction.");
    }

    if (String(paymentRow.payment_method || "").toLowerCase() === "cash") {
      await updatePaymentLedgerSnapshot(conn, paymentId, {
        paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.notApplicable,
      });
      return {
        success: true,
        alreadyCompleted: true,
        paymentId,
        payoutId: null,
      };
    }

    const walletCredit = await getWalletCreditByPaymentIdForUpdate(conn, paymentId);
    if (!walletCredit) {
      throw new Error("Wallet credit entry not found for this payment.");
    }

    const remainingAmount = roundMoney(subtractMoney(walletCredit.amount, walletCredit.allocated_amount || 0));
    if (remainingAmount <= 0) {
      await updatePaymentLedgerSnapshot(conn, paymentId, {
        paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.completed,
      });
      return {
        success: true,
        alreadyCompleted: true,
        paymentId,
        payoutId: null,
      };
    }

    const wallet = await ensureTechnicianWallet(conn, paymentRow.technician_id, paymentRow.currency || "INR");
    if (!wallet) {
      throw new Error("Technician wallet cannot be created because the technician no longer exists.");
    }
    const payoutId = await createPayoutRecord(conn, {
      payoutReference: nextPayoutReference(),
      idempotencyKey: resolvedIdempotencyKey,
      technicianId: paymentRow.technician_id,
      walletId: wallet.id,
      amount: remainingAmount,
      currency: paymentRow.currency || "INR",
      status: PAYOUT_STATUS.paid,
      payoutMethod,
      destinationReference: paymentRow.upi_id || paymentRow.payment_details_upi_id || null,
      externalReference: externalReference || null,
      notes: notes || `Manual payout for payment #${paymentId}`,
      createdBy: adminId || null,
      processedBy: adminId || null,
      processedAt: new Date(),
    });

    await allocateWalletCreditToPayout(conn, walletCredit, payoutId, remainingAmount);
    await debitTechnicianWalletForPayout(conn, {
      technicianId: paymentRow.technician_id,
      payoutId,
      amount: remainingAmount,
      currency: paymentRow.currency || "INR",
      description: `Manual payout for payment #${paymentId}`,
      idempotencyKey: `manual-payout:${payoutId}`,
      metadata: {
        paymentId,
        requestId: paymentRow.request_id,
        adminId: adminId || null,
      },
    });

    await updatePaymentLedgerSnapshot(conn, paymentId, {
      paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.completed,
    });

    return {
      success: true,
      alreadyCompleted: false,
      paymentId,
      payoutId,
      amount: remainingAmount,
      idempotencyReused: false,
    };
  });
}

export async function createTechnicianWalletPayout({
  technicianId,
  amount = null,
  adminId,
  payoutMethod = PAYOUT_METHOD.manualUpi,
  notes = "",
  externalReference = "",
  idempotencyKey = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const resolvedIdempotencyKey = buildPayoutIdempotencyKey({
      idempotencyKey,
      technicianId,
      amount,
      externalReference,
    });
    const existingPayout = await findPayoutByIdempotencyKey(conn, resolvedIdempotencyKey);
    if (existingPayout) {
      return {
        success: true,
        payoutId: Number(existingPayout.id),
        technicianId: Number(existingPayout.technician_id),
        amount: roundMoney(existingPayout.amount || 0),
        alreadyProcessed: true,
        idempotencyReused: true,
        wallet: await getTechnicianWalletSummary(conn, Number(existingPayout.technician_id)),
      };
    }

    const wallet = await ensureTechnicianWallet(conn, technicianId, "INR");
    if (!wallet) {
      throw new Error("Technician wallet cannot be created because the technician no longer exists.");
    }
    const maxPayoutAmount = roundMoney(wallet.withdrawable_balance || 0);
    const payoutAmount = amount == null ? maxPayoutAmount : roundMoney(amount);

    if (payoutAmount <= 0) {
      throw new Error("No withdrawable balance available for payout.");
    }
    if (payoutAmount > maxPayoutAmount) {
      throw new Error("Requested payout exceeds withdrawable balance.");
    }

    const [techRows] = await conn.query(
      `SELECT
         name,
         COALESCE(NULLIF(TRIM(upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id'))), '')) AS upi_id
       FROM technicians
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [technicianId]
    );
    if (!techRows[0]) {
      throw new Error("Technician not found.");
    }

    const payoutId = await createPayoutRecord(conn, {
      payoutReference: nextPayoutReference(),
      idempotencyKey: resolvedIdempotencyKey,
      technicianId,
      walletId: wallet.id,
      amount: payoutAmount,
      currency: wallet.currency || "INR",
      status: PAYOUT_STATUS.paid,
      payoutMethod,
      destinationReference: techRows[0].upi_id || null,
      externalReference: externalReference || null,
      notes: notes || `Manual payout for technician #${technicianId}`,
      createdBy: adminId || null,
      processedBy: adminId || null,
      processedAt: new Date(),
    });

    let remainingAmount = payoutAmount;
    const openCredits = await listOpenWalletCreditsForUpdate(conn, technicianId);
    for (const creditRow of openCredits) {
      if (remainingAmount <= 0) break;
      const openAmount = roundMoney(subtractMoney(creditRow.amount, creditRow.allocated_amount || 0));
      if (openAmount <= 0) continue;

      const appliedAmount = Math.min(openAmount, remainingAmount);
      await allocateWalletCreditToPayout(conn, creditRow, payoutId, appliedAmount);
      remainingAmount = roundMoney(subtractMoney(remainingAmount, appliedAmount));
    }

    if (remainingAmount > 0) {
      throw new Error("Not enough open wallet credits were available to allocate this payout.");
    }

    await debitTechnicianWalletForPayout(conn, {
      technicianId,
      payoutId,
      amount: payoutAmount,
      currency: wallet.currency || "INR",
      description: `Manual wallet payout for technician #${technicianId}`,
      idempotencyKey: `wallet-payout:${payoutId}`,
      metadata: {
        technicianId,
        adminId: adminId || null,
      },
    });

    return {
      success: true,
      payoutId,
      technicianId,
      amount: payoutAmount,
      alreadyProcessed: false,
      idempotencyReused: false,
      wallet: await getTechnicianWalletSummary(conn, technicianId),
    };
  });
}

export async function getTechnicianWalletBalances({
  page = 1,
  limit = 20,
  search = "",
  onlyPositiveBalance = false,
} = {}) {
  const pool = await getPool();
  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  const [rows, total] = await Promise.all([
    listTechnicianWalletBalances(pool, {
      search,
      onlyPositiveBalance,
      limit,
      offset,
    }),
    countTechnicianWalletBalances(pool, {
      search,
      onlyPositiveBalance,
    }),
  ]);

  return {
    data: rows.map(mapWalletBalanceRow),
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.max(1, Math.ceil(total / Number(limit))),
    },
  };
}

export async function getPayoutHistory({
  page = 1,
  limit = 20,
  search = "",
} = {}) {
  const pool = await getPool();
  const offset = Math.max(0, (Number(page) - 1) * Number(limit));
  const like = `%${String(search || "").trim().toLowerCase()}%`;
  const hasSearch = String(search || "").trim().length > 0;
  const whereSql = hasSearch
    ? `WHERE (
         LOWER(COALESCE(t.name, '')) LIKE ?
         OR LOWER(COALESCE(po.payout_reference, '')) LIKE ?
         OR LOWER(COALESCE(po.external_reference, '')) LIKE ?
         OR CAST(po.technician_id AS CHAR) LIKE ?
       )`
    : "";
  const params = hasSearch ? [like, like, like, like] : [];

  const [rows] = await pool.query(
    `SELECT
       po.id,
       po.payout_reference,
       po.idempotency_key,
       po.withdrawal_request_id,
       po.technician_id,
       t.name AS technician_name,
       COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id,
       COALESCE(
         NULLIF(TRIM(t.upi_name), ''),
         NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_name'))), ''),
         NULLIF(TRIM(t.proprietor_name), ''),
         NULLIF(TRIM(t.name), '')
       ) AS upi_name,
       po.amount,
       po.currency,
       po.status,
       po.payout_method,
       po.external_reference,
       po.destination_reference,
       po.destination_name,
       po.notes,
       po.processed_by,
       po.processed_at,
       po.created_at
     FROM payouts po
     JOIN technicians t ON t.id = po.technician_id
     ${whereSql}
     ORDER BY COALESCE(po.processed_at, po.created_at) DESC, po.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM payouts po
     JOIN technicians t ON t.id = po.technician_id
     ${whereSql}`,
    params
  );

  return {
    data: (rows || []).map((row) => ({
      id: Number(row.id),
      payoutReference: row.payout_reference,
      idempotencyKey: row.idempotency_key || null,
      withdrawalRequestId: row.withdrawal_request_id != null ? Number(row.withdrawal_request_id) : null,
      technicianId: Number(row.technician_id),
      technicianName: row.technician_name,
      upiId: row.upi_id || null,
      upiName: row.upi_name || row.destination_name || null,
      amount: roundMoney(row.amount || 0),
      currency: String(row.currency || "INR").toUpperCase(),
      status: row.status,
      payoutMethod: row.payout_method || null,
      externalReference: row.external_reference || null,
      destinationReference: row.destination_reference || null,
      destinationName: row.destination_name || null,
      notes: row.notes || null,
      processedBy: row.processed_by || null,
      processedAt: row.processed_at || null,
      createdAt: row.created_at,
    })),
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: Number(countRows?.[0]?.total || 0),
      totalPages: Math.max(1, Math.ceil(Number(countRows?.[0]?.total || 0) / Number(limit))),
    },
  };
}

export async function getEligiblePayoutQueue({ limit = 500 } = {}) {
  const pool = await getPool();
  const rows = await listEligibleWallets(pool, { limit });
  return rows.map((row) => ({
    walletId: Number(row.wallet_id),
    technicianId: Number(row.technician_id),
    technicianName: row.technician_name,
    technicianEmail: row.technician_email,
    upiId: row.upi_id || null,
    upiName: row.upi_name || null,
    currency: String(row.currency || "INR").toUpperCase(),
    totalEarned: roundMoney(row.total_earned || 0),
    withdrawableBalance: roundMoney(row.withdrawable_balance || 0),
    totalPaidOut: roundMoney(row.total_paid_out || 0),
    lastTransactionAt: row.last_transaction_at || null,
  }));
}

export async function exportEligiblePayoutQueueCsv({ limit = 500 } = {}) {
  const rows = await getEligiblePayoutQueue({ limit });
  const headers = [
    "technician_id",
    "technician_name",
    "technician_email",
    "upi_id",
    "upi_name",
    "currency",
    "withdrawable_balance",
    "total_earned",
    "total_paid_out",
    "last_transaction_at",
  ];
  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push([
      csvEscape(row.technicianId),
      csvEscape(row.technicianName),
      csvEscape(row.technicianEmail),
      csvEscape(row.upiId),
      csvEscape(row.upiName),
      csvEscape(row.currency),
      csvEscape(row.withdrawableBalance),
      csvEscape(row.totalEarned),
      csvEscape(row.totalPaidOut),
      csvEscape(row.lastTransactionAt),
    ].join(","));
  });
  return `${lines.join("\n")}\n`;
}
