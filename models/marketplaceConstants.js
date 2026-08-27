export const PAYMENT_TO_TECHNICIAN_STATUS = Object.freeze({
  pending: "pending",
  processing: "processing",
  completed: "completed",
  notApplicable: "not_applicable",
});

export const PAYMENT_LEDGER_STATUS = Object.freeze({
  pending: "pending",
  posted: "posted",
  skipped: "skipped",
});

export const WALLET_ENTRY_DIRECTION = Object.freeze({
  credit: "credit",
  debit: "debit",
});

export const WALLET_ENTRY_TYPE = Object.freeze({
  paymentCredit: "payment_credit",
  payoutDebit: "payout_debit",
  adjustmentCredit: "adjustment_credit",
  adjustmentDebit: "adjustment_debit",
});

export const PAYOUT_STATUS = Object.freeze({
  draft: "draft",
  processing: "processing",
  paid: "paid",
  failed: "failed",
  cancelled: "cancelled",
});

export const PAYOUT_METHOD = Object.freeze({
  manualUpi: "manual_upi",
  manualBankTransfer: "manual_bank_transfer",
  other: "other",
});

export const WITHDRAWAL_REQUEST_STATUS = Object.freeze({
  pending: "pending",
  processing: "processing",
  paid: "paid",
  rejected: "rejected",
  cancelled: "cancelled",
});
