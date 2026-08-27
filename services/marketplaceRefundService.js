import crypto from "crypto";
import Razorpay from "razorpay";
import { getPool } from "../db.js";
import {
  createWalletTransaction,
  ensureTechnicianWallet,
  findPaymentRefundByIdempotencyKey,
  getWalletCreditByPaymentIdForUpdate,
  updatePaymentLedgerSnapshot,
  updateTechnicianWalletSnapshot,
  withTransaction,
} from "../repositories/marketplaceRepository.js";
import {
  PAYMENT_TO_TECHNICIAN_STATUS,
  WALLET_ENTRY_DIRECTION,
  WALLET_ENTRY_TYPE,
} from "../models/marketplaceConstants.js";
import { roundMoney, subtractMoney } from "../utils/money.js";

const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "");
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "");
const hasRazorpayConfig = Boolean(
  RAZORPAY_KEY_ID &&
  RAZORPAY_KEY_SECRET &&
  !RAZORPAY_KEY_ID.includes("placeholder") &&
  !RAZORPAY_KEY_SECRET.includes("placeholder")
);

const razorpay = hasRazorpayConfig
  ? new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    })
  : null;

function nextRefundReference() {
  const nonce = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `REFUND-${Date.now()}-${nonce}`;
}

function buildRefundStatus(totalAmount, refundedAmount) {
  const total = roundMoney(totalAmount);
  const refunded = roundMoney(refundedAmount);
  if (refunded <= 0) return "none";
  if (refunded >= total) return "fully_refunded";
  return "partially_refunded";
}

function buildRefundIdempotencyKey({ paymentId, refundAmount = null, idempotencyKey = "" }) {
  if (String(idempotencyKey || "").trim()) {
    return String(idempotencyKey).trim();
  }
  return `refund:${paymentId}:${refundAmount == null ? "full" : roundMoney(refundAmount)}`;
}

function mapExistingRefundRow(row) {
  return {
    success: true,
    alreadyProcessed: true,
    refundId: Number(row.id),
    paymentId: Number(row.payment_id),
    refundedAmount: roundMoney(row.amount || 0),
    totalRefundedAmount: null,
    refundStatus: row.status || "processed",
    technicianAdjustmentAmount: roundMoney(row.technician_adjustment_amount || 0),
    gatewayRefundId: row.external_reference || null,
  };
}

async function lookupExistingRefundByIdempotencyKey(pool, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await pool.query(
    `SELECT *
     FROM payment_refunds
     WHERE idempotency_key = ?
     LIMIT 1`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

async function getPaymentRefundGatewayContext(paymentId) {
  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT
       p.id,
       p.amount,
       p.refunded_amount,
       p.razorpay_payment_id,
       p.payment_method,
       p.status,
       sr.id AS request_id
     FROM payments p
     JOIN service_requests sr ON sr.id = p.service_request_id
     WHERE p.id = ?
     LIMIT 1`,
    [paymentId]
  );
  return rows[0] || null;
}

export async function processPaymentRefund({
  paymentId,
  refundAmount = null,
  reason = "",
  adminId,
  externalReference = "",
  idempotencyKey = "",
  gatewayMetadata = null,
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const existingRefund = await findPaymentRefundByIdempotencyKey(conn, idempotencyKey);
    if (existingRefund) {
      return mapExistingRefundRow(existingRefund);
    }

    const [paymentRows] = await conn.query(
      `SELECT
         p.*,
         sr.id AS request_id,
         sr.payment_status AS request_payment_status,
         sr.status AS request_status,
         sr.technician_id
       FROM payments p
       JOIN service_requests sr ON sr.id = p.service_request_id
       WHERE p.id = ?
       LIMIT 1
       FOR UPDATE`,
      [paymentId]
    );

    const paymentRow = paymentRows[0];
    if (!paymentRow) {
      throw new Error("Transaction not found.");
    }

    if (String(paymentRow.payment_method || "").toLowerCase() !== "razorpay") {
      throw new Error("Refunds are supported only for platform-collected Razorpay payments.");
    }

    const effectiveStatus = String(paymentRow.status || "").toLowerCase();
    if (!["completed", "partially_refunded"].includes(effectiveStatus) && roundMoney(paymentRow.refunded_amount || 0) <= 0) {
      throw new Error("Only completed payments can be refunded.");
    }

    const alreadyRefunded = roundMoney(paymentRow.refunded_amount || 0);
    const totalAmount = roundMoney(paymentRow.amount || 0);
    const remainingRefundable = roundMoney(subtractMoney(totalAmount, alreadyRefunded));
    const targetRefundAmount = refundAmount == null ? remainingRefundable : roundMoney(refundAmount);

    if (targetRefundAmount <= 0) {
      throw new Error("Refund amount must be greater than zero.");
    }
    if (targetRefundAmount > remainingRefundable) {
      throw new Error("Refund amount exceeds the remaining refundable amount.");
    }

    let walletTransactionId = null;
    let technicianAdjustmentAmount = 0;

    if (paymentRow.technician_id) {
      const payoutStatus = String(paymentRow.payment_to_technician_status || "").trim().toLowerCase();
      if (payoutStatus === PAYMENT_TO_TECHNICIAN_STATUS.completed) {
        throw new Error("Cannot auto-refund after technician payout is completed. Manual recovery is required.");
      }

      const walletCredit = await getWalletCreditByPaymentIdForUpdate(conn, paymentId);
      if (!walletCredit) {
        throw new Error("Wallet credit record not found for this payment.");
      }

      const creditAmount = roundMoney(walletCredit.amount || 0);
      const creditRemaining = roundMoney(subtractMoney(creditAmount, walletCredit.allocated_amount || 0));
      const refundRatio = totalAmount > 0 ? targetRefundAmount / totalAmount : 0;
      technicianAdjustmentAmount = roundMoney((paymentRow.base_amount || paymentRow.technician_amount || 0) * refundRatio);
      if (technicianAdjustmentAmount > creditRemaining) {
        throw new Error("Refund would exceed the technician wallet credit available for reversal.");
      }

      if (technicianAdjustmentAmount > 0) {
        const wallet = await ensureTechnicianWallet(conn, paymentRow.technician_id, paymentRow.currency || "INR");
        if (!wallet) {
          throw new Error("Technician wallet cannot be created because the technician no longer exists.");
        }
        const balanceBefore = roundMoney(wallet.withdrawable_balance || 0);
        const balanceAfter = roundMoney(subtractMoney(balanceBefore, technicianAdjustmentAmount));
        if (balanceAfter < 0) {
          throw new Error("Technician wallet balance is insufficient to reverse this refund automatically.");
        }

        walletTransactionId = await createWalletTransaction(conn, {
          walletId: wallet.id,
          technicianId: paymentRow.technician_id,
          serviceRequestId: paymentRow.request_id,
          paymentId,
          entryType: WALLET_ENTRY_TYPE.adjustmentDebit,
          direction: WALLET_ENTRY_DIRECTION.debit,
          amount: technicianAdjustmentAmount,
          allocatedAmount: 0,
          balanceBefore,
          balanceAfter,
          description: `Refund reversal for payment #${paymentId}`,
          referenceType: "refund",
          referenceId: String(paymentId),
          idempotencyKey: `refund-adjustment:${paymentId}:${alreadyRefunded + targetRefundAmount}`,
          metadata: {
            paymentId,
            refundAmount: targetRefundAmount,
            adminId: adminId || null,
            gatewayRefundId: externalReference || null,
          },
        });

        await updateTechnicianWalletSnapshot(conn, wallet.id, {
          totalEarned: Math.max(0, roundMoney(subtractMoney(wallet.total_earned || 0, technicianAdjustmentAmount))),
          withdrawableBalance: balanceAfter,
          totalPaidOut: roundMoney(wallet.total_paid_out || 0),
          onHoldBalance: roundMoney(wallet.on_hold_balance || 0),
          lastTransactionAt: new Date(),
        });
      }
    }

    const nextRefundedAmount = roundMoney(alreadyRefunded + targetRefundAmount);
    const refundStatus = buildRefundStatus(totalAmount, nextRefundedAmount);

    const [refundResult] = await conn.execute(
      `INSERT INTO payment_refunds (
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
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nextRefundReference(),
        idempotencyKey || null,
        paymentId,
        paymentRow.request_id,
        paymentRow.technician_id || null,
        walletTransactionId,
        targetRefundAmount,
        technicianAdjustmentAmount,
        "processed",
        reason || null,
        externalReference || null,
        adminId || null,
        new Date(),
        JSON.stringify({
          paymentStatusBefore: paymentRow.status,
          refundedAmountBefore: alreadyRefunded,
          gateway: gatewayMetadata || null,
        }),
      ]
    );

    await conn.execute(
      `UPDATE payments
       SET refunded_amount = ?,
           refund_status = ?,
           status = ?
       WHERE id = ?`,
      [
        nextRefundedAmount,
        refundStatus,
        refundStatus === "fully_refunded" ? "refunded" : "partially_refunded",
        paymentId,
      ]
    );

    await updatePaymentLedgerSnapshot(conn, paymentId, {
      paymentToTechnicianStatus:
        refundStatus === "fully_refunded"
          ? PAYMENT_TO_TECHNICIAN_STATUS.notApplicable
          : PAYMENT_TO_TECHNICIAN_STATUS.pending,
    });

    await conn.execute(
      `UPDATE service_requests
       SET payment_status = ?
       WHERE id = ?`,
      [refundStatus === "fully_refunded" ? "refunded" : "partially_refunded", paymentRow.request_id]
    );

    return {
      success: true,
      refundId: Number(refundResult.insertId),
      paymentId,
      refundedAmount: targetRefundAmount,
      totalRefundedAmount: nextRefundedAmount,
      refundStatus,
      technicianAdjustmentAmount,
      gatewayRefundId: externalReference || null,
      alreadyProcessed: false,
    };
  });
}

async function createGatewayRefund({
  paymentId,
  gatewayPaymentId,
  refundAmount,
  reason = "",
  idempotencyKey,
}) {
  if (!hasRazorpayConfig || !razorpay) {
    throw new Error("Razorpay refund gateway is not configured.");
  }
  if (!gatewayPaymentId) {
    throw new Error("Razorpay payment reference is missing for this transaction.");
  }

  const notes = {
    paymentId: String(paymentId),
    refund_request_key: String(idempotencyKey || ""),
  };
  if (reason) {
    notes.reason = reason.slice(0, 100);
  }

  const refundPayload = {
    amount: Math.round(roundMoney(refundAmount) * 100),
    speed: "normal",
    notes,
  };

  return razorpay.payments.refund(gatewayPaymentId, refundPayload);
}

export async function refundMarketplacePayment({
  paymentId,
  refundAmount = null,
  reason = "",
  adminId,
  externalReference = "",
  idempotencyKey = "",
  useGateway = true,
  gatewayRefundId = "",
}) {
  const pool = await getPool();
  const resolvedIdempotencyKey = buildRefundIdempotencyKey({
    paymentId,
    refundAmount,
    idempotencyKey,
  });

  const existingRefund = await lookupExistingRefundByIdempotencyKey(pool, resolvedIdempotencyKey);
  if (existingRefund) {
    return mapExistingRefundRow(existingRefund);
  }

  let gatewayResponse = null;
  let resolvedExternalReference = String(externalReference || "").trim();

  if (String(gatewayRefundId || "").trim()) {
    resolvedExternalReference = String(gatewayRefundId).trim();
  } else if (useGateway) {
    const gatewayContext = await getPaymentRefundGatewayContext(paymentId);
    if (!gatewayContext) {
      throw new Error("Transaction not found.");
    }
    if (String(gatewayContext.payment_method || "").toLowerCase() !== "razorpay") {
      throw new Error("Refunds are supported only for platform-collected Razorpay payments.");
    }

    const alreadyRefunded = roundMoney(gatewayContext.refunded_amount || 0);
    const totalAmount = roundMoney(gatewayContext.amount || 0);
    const remainingRefundable = roundMoney(subtractMoney(totalAmount, alreadyRefunded));
    const targetRefundAmount = refundAmount == null ? remainingRefundable : roundMoney(refundAmount);
    if (targetRefundAmount <= 0) {
      throw new Error("Refund amount must be greater than zero.");
    }

    gatewayResponse = await createGatewayRefund({
      paymentId,
      gatewayPaymentId: gatewayContext.razorpay_payment_id,
      refundAmount: targetRefundAmount,
      reason,
      idempotencyKey: resolvedIdempotencyKey,
    });
    resolvedExternalReference = gatewayResponse?.id || resolvedExternalReference;
  }

  try {
    return await processPaymentRefund({
      paymentId,
      refundAmount,
      reason,
      adminId,
      externalReference: resolvedExternalReference,
      idempotencyKey: resolvedIdempotencyKey,
      gatewayMetadata: gatewayResponse,
    });
  } catch (error) {
    if (resolvedExternalReference) {
      error.gatewayRefundId = resolvedExternalReference;
    }
    throw error;
  }
}
