import {
  appendWalletCreditEntry,
  appendWalletDebitEntry,
} from "./marketplaceLedgerService.js";
import {
  ensureTechnicianWallet,
  getTechnicianWalletSnapshot,
  getWalletCreditByPaymentIdForUpdate,
  listTechnicianWalletTransactions,
  updatePaymentLedgerSnapshot,
  updateTechnicianWalletSnapshot,
  withTransaction,
} from "../repositories/marketplaceRepository.js";
import {
  PAYMENT_LEDGER_STATUS,
  PAYMENT_TO_TECHNICIAN_STATUS,
} from "../models/marketplaceConstants.js";
import { addMoney, roundMoney, subtractMoney } from "../utils/money.js";

export async function creditTechnicianWalletForPayment(conn, payload) {
  if (!payload?.technicianId || !payload?.paymentId || !payload?.amount) {
    return { credited: false, walletTransactionId: null, duplicate: false, skipped: true };
  }

  const existingWalletCredit = await getWalletCreditByPaymentIdForUpdate(conn, payload.paymentId);
  if (existingWalletCredit) {
    await updatePaymentLedgerSnapshot(conn, payload.paymentId, {
      ledgerStatus: PAYMENT_LEDGER_STATUS.posted,
      walletTransactionId: existingWalletCredit.id,
      paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.pending,
    });
    return {
      credited: false,
      walletTransactionId: Number(existingWalletCredit.id),
      duplicate: true,
      skipped: false,
    };
  }

  const wallet = await ensureTechnicianWallet(conn, payload.technicianId, payload.currency || "INR");
  if (!wallet) {
    console.warn(
      `[Marketplace Wallet] Skipping payment credit ${payload.paymentId}: technician ${payload.technicianId} was not found.`
    );
    return {
      credited: false,
      walletTransactionId: null,
      duplicate: false,
      skipped: true,
    };
  }

  const amount = roundMoney(payload.amount);
  const balanceBefore = roundMoney(wallet.withdrawable_balance || 0);
  const balanceAfter = addMoney(balanceBefore, amount);
  const totalEarned = addMoney(wallet.total_earned || 0, amount);

  const walletTransactionId = await appendWalletCreditEntry(conn, {
    walletId: wallet.id,
    technicianId: payload.technicianId,
    serviceRequestId: payload.serviceRequestId || null,
    paymentId: payload.paymentId,
    amount,
    balanceBefore,
    balanceAfter,
    description: payload.description || "Marketplace payment credited to technician wallet.",
    referenceType: "payment",
    referenceId: String(payload.paymentId),
    idempotencyKey: payload.idempotencyKey || `payment-credit:${payload.paymentId}`,
    metadata: payload.metadata || null,
  });

  await updateTechnicianWalletSnapshot(conn, wallet.id, {
    totalEarned,
    withdrawableBalance: balanceAfter,
    totalPaidOut: roundMoney(wallet.total_paid_out || 0),
    onHoldBalance: roundMoney(wallet.on_hold_balance || 0),
    lastTransactionAt: new Date(),
  });

  await updatePaymentLedgerSnapshot(conn, payload.paymentId, {
    ledgerStatus: PAYMENT_LEDGER_STATUS.posted,
    walletTransactionId,
    paymentToTechnicianStatus: PAYMENT_TO_TECHNICIAN_STATUS.pending,
  });

  return {
    credited: true,
    walletTransactionId,
    duplicate: false,
    skipped: false,
  };
}

export async function debitTechnicianWalletForPayout(conn, payload) {
  const wallet = await ensureTechnicianWallet(conn, payload.technicianId, payload.currency || "INR");
  if (!wallet) {
    throw new Error("Technician wallet cannot be created because the technician no longer exists.");
  }
  const amount = roundMoney(payload.amount);
  const balanceBefore = roundMoney(wallet.withdrawable_balance || 0);
  const balanceAfter = roundMoney(subtractMoney(balanceBefore, amount));
  if (balanceAfter < 0) {
    throw new Error("Withdrawable balance is insufficient for this payout.");
  }

  const totalPaidOut = addMoney(wallet.total_paid_out || 0, amount);

  const walletTransactionId = await appendWalletDebitEntry(conn, {
    walletId: wallet.id,
    technicianId: payload.technicianId,
    payoutId: payload.payoutId,
    amount,
    balanceBefore,
    balanceAfter,
    description: payload.description || "Manual payout debited from technician wallet.",
    referenceType: "payout",
    referenceId: String(payload.payoutId),
    idempotencyKey: payload.idempotencyKey || `payout-debit:${payload.payoutId}`,
    metadata: payload.metadata || null,
  });

  await updateTechnicianWalletSnapshot(conn, wallet.id, {
    totalEarned: roundMoney(wallet.total_earned || 0),
    withdrawableBalance: balanceAfter,
    totalPaidOut,
    onHoldBalance: roundMoney(wallet.on_hold_balance || 0),
    lastTransactionAt: new Date(),
  });

  return {
    walletId: wallet.id,
    walletTransactionId,
    balanceAfter,
  };
}

export async function getTechnicianWalletSummary(pool, technicianId) {
  const wallet = await getTechnicianWalletSnapshot(pool, technicianId);
  if (!wallet) {
    return {
      total_earned: 0,
      withdrawable_balance: 0,
      total_paid_out: 0,
      on_hold_balance: 0,
      currency: "INR",
    };
  }

  return {
    total_earned: roundMoney(wallet.total_earned || 0),
    withdrawable_balance: roundMoney(wallet.withdrawable_balance || 0),
    total_paid_out: roundMoney(wallet.total_paid_out || 0),
    on_hold_balance: roundMoney(wallet.on_hold_balance || 0),
    currency: String(wallet.currency || "INR").toUpperCase(),
    last_transaction_at: wallet.last_transaction_at || null,
  };
}

export async function getTechnicianWalletTransactionHistory(pool, technicianId, limit = 20) {
  const rows = await listTechnicianWalletTransactions(pool, technicianId, limit);
  return rows.map((row) => ({
    id: Number(row.id),
    payment_id: row.payment_id || null,
    payout_id: row.payout_id || null,
    entry_type: row.entry_type,
    direction: row.direction,
    amount: roundMoney(row.amount || 0),
    allocated_amount: roundMoney(row.allocated_amount || 0),
    balance_before: roundMoney(row.balance_before || 0),
    balance_after: roundMoney(row.balance_after || 0),
    service_request_id: row.service_request_id || null,
    service_type: row.service_type || null,
    vehicle_type: row.vehicle_type || null,
    vehicle_model: row.vehicle_model || null,
    address: row.address || null,
    payment_status: row.payment_status || null,
    payout_status: row.payout_status || null,
    payout_reference: row.payout_reference || null,
    external_reference: row.external_reference || null,
    created_at: row.created_at,
  }));
}

export async function backfillMarketplaceWalletCredits(pool) {
  const [rows] = await pool.query(
    `SELECT
       p.id AS payment_id,
       p.service_request_id,
       sr.technician_id,
       COALESCE(p.base_amount, p.technician_amount) AS base_amount,
       p.currency,
       p.payment_method
     FROM payments p
     JOIN service_requests sr ON sr.id = p.service_request_id
     WHERE sr.technician_id IS NOT NULL
       AND LOWER(COALESCE(p.status, '')) = 'completed'
       AND LOWER(COALESCE(p.payment_method, '')) = 'razorpay'
       AND COALESCE(p.wallet_transaction_id, 0) = 0`
  );

  let creditsCreated = 0;
  for (const row of rows || []) {
    try {
      await withTransaction(pool, async (conn) => {
        const result = await creditTechnicianWalletForPayment(conn, {
          technicianId: row.technician_id,
          paymentId: row.payment_id,
          serviceRequestId: row.service_request_id,
          amount: row.base_amount,
          currency: row.currency || "INR",
          description: "Backfilled marketplace wallet credit from completed Razorpay payment.",
          idempotencyKey: `payment-credit:${row.payment_id}`,
          metadata: {
            backfilled: true,
          },
        });
        if (result.credited) {
          creditsCreated += 1;
        }
      });
    } catch (error) {
      console.error(
        `[Marketplace Wallet] Backfill skipped for payment ${row.payment_id}:`,
        error?.message || error
      );
    }
  }

  return {
    creditsCreated,
    scannedPayments: rows.length || 0,
  };
}
