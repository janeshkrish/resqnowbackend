import {
  createPayoutAllocation,
  createWalletTransaction,
  updatePaymentLedgerSnapshot,
  updateWalletTransactionAllocation,
} from "../repositories/marketplaceRepository.js";
import {
  PAYMENT_TO_TECHNICIAN_STATUS,
  WALLET_ENTRY_DIRECTION,
  WALLET_ENTRY_TYPE,
} from "../models/marketplaceConstants.js";
import { roundMoney, subtractMoney } from "../utils/money.js";

function resolvePayoutStatusFromAllocation(amount, allocatedAmount) {
  const total = roundMoney(amount);
  const allocated = roundMoney(allocatedAmount);
  if (allocated <= 0) return PAYMENT_TO_TECHNICIAN_STATUS.pending;
  if (allocated >= total) return PAYMENT_TO_TECHNICIAN_STATUS.completed;
  return PAYMENT_TO_TECHNICIAN_STATUS.processing;
}

export async function appendWalletCreditEntry(conn, payload) {
  return createWalletTransaction(conn, {
    ...payload,
    direction: WALLET_ENTRY_DIRECTION.credit,
    entryType: WALLET_ENTRY_TYPE.paymentCredit,
    allocatedAmount: 0,
  });
}

export async function appendWalletDebitEntry(conn, payload) {
  return createWalletTransaction(conn, {
    ...payload,
    direction: WALLET_ENTRY_DIRECTION.debit,
    entryType: WALLET_ENTRY_TYPE.payoutDebit,
    allocatedAmount: 0,
  });
}

export async function allocateWalletCreditToPayout(conn, walletCreditRow, payoutId, amount) {
  const allocationAmount = roundMoney(amount);
  const nextAllocatedAmount = roundMoney(walletCreditRow.allocated_amount || 0) + allocationAmount;

  await createPayoutAllocation(conn, {
    payoutId,
    walletTransactionId: walletCreditRow.id,
    paymentId: walletCreditRow.payment_id || null,
    serviceRequestId: walletCreditRow.service_request_id || null,
    amount: allocationAmount,
  });

  await updateWalletTransactionAllocation(conn, walletCreditRow.id, nextAllocatedAmount);

  if (walletCreditRow.payment_id) {
    await updatePaymentLedgerSnapshot(conn, walletCreditRow.payment_id, {
      paymentToTechnicianStatus: resolvePayoutStatusFromAllocation(walletCreditRow.amount, nextAllocatedAmount),
    });
  }

  return {
    allocationAmount,
    remainingAmount: roundMoney(subtractMoney(walletCreditRow.amount, nextAllocatedAmount)),
    paymentToTechnicianStatus: resolvePayoutStatusFromAllocation(walletCreditRow.amount, nextAllocatedAmount),
  };
}
