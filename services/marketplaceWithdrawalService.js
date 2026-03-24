import crypto from "crypto";
import { getPool } from "../db.js";
import {
  countAdminWithdrawalRequests,
  countTechnicianWithdrawalRequests,
  createPayoutRecord,
  createWalletTransaction,
  createWithdrawalRequestRecord,
  findPayoutByWithdrawalRequestIdForUpdate,
  findRecentMatchingActiveWithdrawalRequest,
  findWithdrawalRequestByIdempotencyKey,
  getTechnicianPayoutProfileForUpdate,
  getWithdrawalRequestByIdForUpdate,
  listAdminWithdrawalRequests,
  listOpenWalletCreditsForUpdate,
  listTechnicianWithdrawalRequests,
  recalculateTechnicianWalletSnapshot,
  updatePayoutRecord,
  updateWithdrawalRequestRecord,
  withTransaction,
} from "../repositories/marketplaceRepository.js";
import {
  PAYOUT_METHOD,
  PAYOUT_STATUS,
  WALLET_ENTRY_DIRECTION,
  WALLET_ENTRY_TYPE,
  WITHDRAWAL_REQUEST_STATUS,
} from "../models/marketplaceConstants.js";
import { allocateWalletCreditToPayout } from "./marketplaceLedgerService.js";
import { buildUpiDeepLink } from "../utils/upi.js";
import { roundMoney, subtractMoney } from "../utils/money.js";

function nextWithdrawalReference(prefix = "WDR") {
  const nonce = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${Date.now()}-${nonce}`;
}

function nextPayoutReference(prefix = "PAYOUT") {
  const nonce = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${Date.now()}-${nonce}`;
}

function normalizeStatus(value, fallback = WITHDRAWAL_REQUEST_STATUS.pending) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || fallback;
}

function mapWalletSnapshot(wallet) {
  if (!wallet) {
    return {
      walletId: null,
      technicianId: null,
      totalEarned: 0,
      withdrawableBalance: 0,
      totalPaidOut: 0,
      onHoldBalance: 0,
      currency: "INR",
      lastTransactionAt: null,
    };
  }

  return {
    walletId: Number(wallet.id || wallet.wallet_id || 0) || null,
    technicianId: Number(wallet.technician_id || 0) || null,
    totalEarned: roundMoney(wallet.total_earned || 0),
    withdrawableBalance: roundMoney(wallet.withdrawable_balance || 0),
    totalPaidOut: roundMoney(wallet.total_paid_out || 0),
    onHoldBalance: roundMoney(wallet.on_hold_balance || 0),
    currency: String(wallet.currency || "INR").toUpperCase(),
    lastTransactionAt: wallet.last_transaction_at || null,
  };
}

function mapWithdrawalRow(row) {
  const amount = roundMoney(row.amount || 0);
  const upiId = row.upi_id || row.destination_reference || null;
  const beneficiaryName =
    row.beneficiary_name ||
    row.destination_name ||
    row.technician_name ||
    null;

  return {
    id: Number(row.id),
    withdrawalReference: row.withdrawal_reference,
    technicianId: Number(row.technician_id),
    technicianName: row.technician_name || null,
    technicianEmail: row.technician_email || null,
    walletId: Number(row.wallet_id || 0) || null,
    amount,
    currency: String(row.currency || "INR").toUpperCase(),
    status: normalizeStatus(row.status),
    upiId,
    beneficiaryName,
    note: row.note || null,
    rejectionReason: row.rejection_reason || null,
    externalReference: row.external_reference || row.payout_external_reference || null,
    requestedBy: row.requested_by || null,
    reviewedBy: row.reviewed_by || null,
    processedBy: row.processed_by || null,
    processingStartedAt: row.processing_started_at || null,
    paidAt: row.paid_at || null,
    rejectedAt: row.rejected_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    payoutId: row.payout_id != null ? Number(row.payout_id) : null,
    payoutReference: row.payout_reference || null,
    payoutStatus: row.payout_status || null,
    payoutMethod: row.payout_method || null,
    payoutProcessedAt: row.payout_processed_at || null,
    upiLink: buildUpiDeepLink({
      upiId,
      name: beneficiaryName,
      amount,
    }),
  };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildWithdrawalMetadata(existingMetadata, extraMetadata) {
  const base = parseJsonObject(existingMetadata);
  const next = extraMetadata && typeof extraMetadata === "object" ? extraMetadata : {};
  return { ...base, ...next };
}

async function createProcessingPayout({
  conn,
  requestRow,
  payoutProfile,
  adminId,
  payoutMethod,
  notes,
}) {
  return createPayoutRecord(conn, {
    payoutReference: nextPayoutReference(),
    idempotencyKey: `withdrawal-request:${requestRow.id}`,
    withdrawalRequestId: requestRow.id,
    technicianId: requestRow.technician_id,
    walletId: requestRow.wallet_id,
    amount: requestRow.amount,
    currency: requestRow.currency || "INR",
    status: PAYOUT_STATUS.processing,
    payoutMethod: payoutMethod || PAYOUT_METHOD.manualUpi,
    destinationReference: requestRow.upi_id || payoutProfile?.upi_id || null,
    destinationName: requestRow.beneficiary_name || payoutProfile?.upi_name || null,
    externalReference: requestRow.external_reference || null,
    notes: notes || null,
    createdBy: adminId || null,
    processedBy: null,
    processedAt: null,
  });
}

async function appendHeldWithdrawalDebitEntry(conn, { wallet, requestRow, payoutId, adminId }) {
  const amount = roundMoney(requestRow.amount || 0);
  const withdrawableBalance = roundMoney(wallet.withdrawable_balance || 0);
  const balanceBefore = roundMoney(withdrawableBalance + amount);
  const balanceAfter = withdrawableBalance;

  return createWalletTransaction(conn, {
    walletId: wallet.id,
    technicianId: requestRow.technician_id,
    payoutId,
    entryType: WALLET_ENTRY_TYPE.payoutDebit,
    direction: WALLET_ENTRY_DIRECTION.debit,
    amount,
    allocatedAmount: 0,
    balanceBefore,
    balanceAfter,
    description: `Withdrawal request #${requestRow.id} paid out manually.`,
    referenceType: "withdrawal_request",
    referenceId: String(requestRow.id),
    idempotencyKey: `withdrawal-payout:${requestRow.id}`,
    metadata: {
      withdrawalRequestId: requestRow.id,
      payoutId,
      adminId: adminId || null,
    },
  });
}

export async function createWithdrawalRequest({
  technicianId,
  amount,
  note = "",
  requestedBy = "",
  idempotencyKey = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
    if (normalizedIdempotencyKey) {
      const existing = await findWithdrawalRequestByIdempotencyKey(conn, normalizedIdempotencyKey);
      if (existing) {
        const wallet = await recalculateTechnicianWalletSnapshot(conn, technicianId, existing.currency || "INR");
        return {
          alreadyCreated: true,
          request: mapWithdrawalRow(existing),
          wallet: mapWalletSnapshot(wallet),
        };
      }
    }

    const wallet = await recalculateTechnicianWalletSnapshot(conn, technicianId, "INR");
    if (!wallet) {
      throw new Error("Technician wallet could not be found.");
    }

    const payoutProfile = await getTechnicianPayoutProfileForUpdate(conn, technicianId);
    if (!payoutProfile) {
      throw new Error("Technician not found.");
    }
    if (!String(payoutProfile.upi_id || "").trim()) {
      throw new Error("A valid UPI ID is required before requesting a withdrawal.");
    }
    if (!String(payoutProfile.upi_name || "").trim()) {
      throw new Error("A payout beneficiary name is required before requesting a withdrawal.");
    }

    const requestedAmount =
      amount == null || amount === ""
        ? roundMoney(wallet.withdrawable_balance || 0)
        : roundMoney(amount);

    if (requestedAmount <= 0) {
      throw new Error("Withdrawal amount must be greater than zero.");
    }
    if (requestedAmount > roundMoney(wallet.withdrawable_balance || 0)) {
      throw new Error("Requested withdrawal exceeds withdrawable balance.");
    }

    if (!normalizedIdempotencyKey) {
      const duplicate = await findRecentMatchingActiveWithdrawalRequest(conn, {
        technicianId,
        amount: requestedAmount,
      });
      if (duplicate) {
        const refreshedWallet = await recalculateTechnicianWalletSnapshot(conn, technicianId, wallet.currency || "INR");
        return {
          alreadyCreated: true,
          request: mapWithdrawalRow(duplicate),
          wallet: mapWalletSnapshot(refreshedWallet),
        };
      }
    }

    const withdrawalRequestId = await createWithdrawalRequestRecord(conn, {
      withdrawalReference: nextWithdrawalReference(),
      idempotencyKey: normalizedIdempotencyKey || null,
      technicianId,
      walletId: wallet.id,
      amount: requestedAmount,
      currency: wallet.currency || "INR",
      status: WITHDRAWAL_REQUEST_STATUS.pending,
      upiId: payoutProfile.upi_id,
      beneficiaryName: payoutProfile.upi_name,
      note: String(note || "").trim() || null,
      requestedBy: String(requestedBy || technicianId).trim() || String(technicianId),
      metadata: {
        source: "technician",
      },
    });

    const requestRow = await getWithdrawalRequestByIdForUpdate(conn, withdrawalRequestId);
    const refreshedWallet = await recalculateTechnicianWalletSnapshot(conn, technicianId, wallet.currency || "INR");

    return {
      alreadyCreated: false,
      request: mapWithdrawalRow({
        ...requestRow,
        technician_name: payoutProfile.name,
        technician_email: payoutProfile.email,
      }),
      wallet: mapWalletSnapshot(refreshedWallet),
    };
  });
}

export async function getTechnicianWithdrawalRequests({
  technicianId,
  page = 1,
  limit = 20,
}) {
  const pool = await getPool();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const [rows, total] = await Promise.all([
    listTechnicianWithdrawalRequests(pool, technicianId, { limit: safeLimit, offset }),
    countTechnicianWithdrawalRequests(pool, technicianId),
  ]);

  return {
    data: rows.map(mapWithdrawalRow),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export async function getAdminWithdrawalRequests({
  page = 1,
  limit = 20,
  status = "",
  search = "",
}) {
  const pool = await getPool();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const offset = (safePage - 1) * safeLimit;
  const [rows, total] = await Promise.all([
    listAdminWithdrawalRequests(pool, { status, search, limit: safeLimit, offset }),
    countAdminWithdrawalRequests(pool, { status, search }),
  ]);

  return {
    data: rows.map(mapWithdrawalRow),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export async function startWithdrawalRequestProcessing({
  withdrawalRequestId,
  adminId,
  payoutMethod = PAYOUT_METHOD.manualUpi,
  notes = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const requestRow = await getWithdrawalRequestByIdForUpdate(conn, withdrawalRequestId);
    if (!requestRow) {
      throw new Error("Withdrawal request not found.");
    }

    const wallet = await recalculateTechnicianWalletSnapshot(conn, requestRow.technician_id, requestRow.currency || "INR");
    const payoutProfile = await getTechnicianPayoutProfileForUpdate(conn, requestRow.technician_id);
    const existingPayout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);

    if (normalizeStatus(requestRow.status) === WITHDRAWAL_REQUEST_STATUS.paid) {
      return {
        alreadyProcessed: true,
        request: mapWithdrawalRow({
          ...requestRow,
          technician_name: payoutProfile?.name || null,
          technician_email: payoutProfile?.email || null,
          payout_id: existingPayout?.id || null,
          payout_reference: existingPayout?.payout_reference || null,
          payout_status: existingPayout?.status || null,
          payout_method: existingPayout?.payout_method || null,
          destination_reference: existingPayout?.destination_reference || null,
          destination_name: existingPayout?.destination_name || null,
          payout_external_reference: existingPayout?.external_reference || null,
          payout_processed_at: existingPayout?.processed_at || null,
        }),
        wallet: mapWalletSnapshot(wallet),
      };
    }

    if (
      [WITHDRAWAL_REQUEST_STATUS.rejected, WITHDRAWAL_REQUEST_STATUS.cancelled].includes(
        normalizeStatus(requestRow.status)
      )
    ) {
      throw new Error("Only pending withdrawal requests can be processed.");
    }

    let payout = existingPayout;
    let payoutId = existingPayout?.id ? Number(existingPayout.id) : null;
    if (!payoutId) {
      payoutId = await createProcessingPayout({
        conn,
        requestRow,
        payoutProfile,
        adminId,
        payoutMethod,
        notes,
      });
      payout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);
    } else {
      await updatePayoutRecord(conn, payoutId, {
        withdrawalRequestId: requestRow.id,
        status: PAYOUT_STATUS.processing,
        payoutMethod,
        destinationReference: requestRow.upi_id || payoutProfile?.upi_id || null,
        destinationName: requestRow.beneficiary_name || payoutProfile?.upi_name || null,
        notes: String(notes || "").trim() || existingPayout?.notes || null,
      });
      payout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);
    }

    await updateWithdrawalRequestRecord(conn, requestRow.id, {
      status: WITHDRAWAL_REQUEST_STATUS.processing,
      reviewedBy: adminId || null,
      processingStartedAt: requestRow.processing_started_at || new Date(),
      metadata: buildWithdrawalMetadata(requestRow.metadata, {
        adminNote: String(notes || "").trim() || undefined,
      }),
    });

    const updatedRequest = await getWithdrawalRequestByIdForUpdate(conn, requestRow.id);
    return {
      alreadyProcessed: false,
      request: mapWithdrawalRow({
        ...updatedRequest,
        technician_name: payoutProfile?.name || null,
        technician_email: payoutProfile?.email || null,
        payout_id: payout?.id || payoutId,
        payout_reference: payout?.payout_reference || null,
        payout_status: payout?.status || PAYOUT_STATUS.processing,
        payout_method: payout?.payout_method || payoutMethod,
        destination_reference: payout?.destination_reference || requestRow.upi_id || payoutProfile?.upi_id || null,
        destination_name: payout?.destination_name || requestRow.beneficiary_name || payoutProfile?.upi_name || null,
      }),
      wallet: mapWalletSnapshot(wallet),
    };
  });
}

export async function rejectWithdrawalRequest({
  withdrawalRequestId,
  adminId,
  reason = "",
  notes = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const requestRow = await getWithdrawalRequestByIdForUpdate(conn, withdrawalRequestId);
    if (!requestRow) {
      throw new Error("Withdrawal request not found.");
    }

    const existingPayout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);
    const payoutProfile = await getTechnicianPayoutProfileForUpdate(conn, requestRow.technician_id);

    if (normalizeStatus(requestRow.status) === WITHDRAWAL_REQUEST_STATUS.paid) {
      throw new Error("Paid withdrawal requests cannot be rejected.");
    }

    if (
      [WITHDRAWAL_REQUEST_STATUS.rejected, WITHDRAWAL_REQUEST_STATUS.cancelled].includes(
        normalizeStatus(requestRow.status)
      )
    ) {
      const wallet = await recalculateTechnicianWalletSnapshot(conn, requestRow.technician_id, requestRow.currency || "INR");
      return {
        alreadyProcessed: true,
        request: mapWithdrawalRow({
          ...requestRow,
          technician_name: payoutProfile?.name || null,
          technician_email: payoutProfile?.email || null,
          payout_id: existingPayout?.id || null,
          payout_reference: existingPayout?.payout_reference || null,
          payout_status: existingPayout?.status || null,
        }),
        wallet: mapWalletSnapshot(wallet),
      };
    }

    if (existingPayout && normalizeStatus(existingPayout.status, "") === PAYOUT_STATUS.paid) {
      throw new Error("Paid withdrawal requests cannot be rejected.");
    }

    if (existingPayout) {
      await updatePayoutRecord(conn, existingPayout.id, {
        status: PAYOUT_STATUS.cancelled,
        notes: String(notes || "").trim() || existingPayout.notes || null,
      });
    }

    await updateWithdrawalRequestRecord(conn, requestRow.id, {
      status: WITHDRAWAL_REQUEST_STATUS.rejected,
      rejectionReason: String(reason || "").trim() || "Rejected by admin.",
      reviewedBy: adminId || null,
      rejectedAt: new Date(),
      metadata: buildWithdrawalMetadata(requestRow.metadata, {
        adminNote: String(notes || "").trim() || undefined,
      }),
    });

    const wallet = await recalculateTechnicianWalletSnapshot(conn, requestRow.technician_id, requestRow.currency || "INR");
    const updatedRequest = await getWithdrawalRequestByIdForUpdate(conn, requestRow.id);

    return {
      alreadyProcessed: false,
      request: mapWithdrawalRow({
        ...updatedRequest,
        technician_name: payoutProfile?.name || null,
        technician_email: payoutProfile?.email || null,
        payout_id: existingPayout?.id || null,
        payout_reference: existingPayout?.payout_reference || null,
        payout_status: existingPayout?.status || PAYOUT_STATUS.cancelled,
      }),
      wallet: mapWalletSnapshot(wallet),
    };
  });
}

export async function markWithdrawalRequestPaid({
  withdrawalRequestId,
  adminId,
  payoutMethod = PAYOUT_METHOD.manualUpi,
  externalReference = "",
  notes = "",
}) {
  const pool = await getPool();

  return withTransaction(pool, async (conn) => {
    const requestRow = await getWithdrawalRequestByIdForUpdate(conn, withdrawalRequestId);
    if (!requestRow) {
      throw new Error("Withdrawal request not found.");
    }

    const payoutProfile = await getTechnicianPayoutProfileForUpdate(conn, requestRow.technician_id);
    let wallet = await recalculateTechnicianWalletSnapshot(conn, requestRow.technician_id, requestRow.currency || "INR");
    let payout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);

    if (normalizeStatus(requestRow.status) === WITHDRAWAL_REQUEST_STATUS.paid) {
      return {
        alreadyProcessed: true,
        request: mapWithdrawalRow({
          ...requestRow,
          technician_name: payoutProfile?.name || null,
          technician_email: payoutProfile?.email || null,
          payout_id: payout?.id || null,
          payout_reference: payout?.payout_reference || null,
          payout_status: payout?.status || PAYOUT_STATUS.paid,
          payout_method: payout?.payout_method || payoutMethod,
          destination_reference: payout?.destination_reference || requestRow.upi_id || null,
          destination_name: payout?.destination_name || requestRow.beneficiary_name || null,
          payout_external_reference: payout?.external_reference || externalReference || null,
          payout_processed_at: payout?.processed_at || requestRow.paid_at || null,
        }),
        wallet: mapWalletSnapshot(wallet),
      };
    }

    if (
      [WITHDRAWAL_REQUEST_STATUS.rejected, WITHDRAWAL_REQUEST_STATUS.cancelled].includes(
        normalizeStatus(requestRow.status)
      )
    ) {
      throw new Error("Only pending or processing withdrawal requests can be paid.");
    }

    if (!payout) {
      await createProcessingPayout({
        conn,
        requestRow,
        payoutProfile,
        adminId,
        payoutMethod,
        notes,
      });
      payout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);
    }

    const openCredits = await listOpenWalletCreditsForUpdate(conn, requestRow.technician_id);
    let remainingAmount = roundMoney(requestRow.amount || 0);
    for (const creditRow of openCredits) {
      if (remainingAmount <= 0) break;
      const openAmount = roundMoney(subtractMoney(creditRow.amount, creditRow.allocated_amount || 0));
      if (openAmount <= 0) continue;

      const appliedAmount = Math.min(openAmount, remainingAmount);
      await allocateWalletCreditToPayout(conn, creditRow, payout.id, appliedAmount);
      remainingAmount = roundMoney(subtractMoney(remainingAmount, appliedAmount));
    }

    if (remainingAmount > 0) {
      throw new Error("Not enough wallet credits are available to settle this withdrawal.");
    }

    await appendHeldWithdrawalDebitEntry(conn, {
      wallet,
      requestRow,
      payoutId: payout.id,
      adminId,
    });

    const processedAt = new Date();
    await updatePayoutRecord(conn, payout.id, {
      withdrawalRequestId: requestRow.id,
      status: PAYOUT_STATUS.paid,
      payoutMethod,
      destinationReference: requestRow.upi_id || payoutProfile?.upi_id || null,
      destinationName: requestRow.beneficiary_name || payoutProfile?.upi_name || null,
      externalReference: String(externalReference || "").trim() || null,
      notes: String(notes || "").trim() || payout.notes || null,
      processedBy: adminId || null,
      processedAt,
    });

    await updateWithdrawalRequestRecord(conn, requestRow.id, {
      status: WITHDRAWAL_REQUEST_STATUS.paid,
      reviewedBy: adminId || null,
      processedBy: adminId || null,
      processingStartedAt: requestRow.processing_started_at || processedAt,
      paidAt: processedAt,
      externalReference: String(externalReference || "").trim() || null,
      metadata: buildWithdrawalMetadata(requestRow.metadata, {
        adminNote: String(notes || "").trim() || undefined,
      }),
    });

    wallet = await recalculateTechnicianWalletSnapshot(conn, requestRow.technician_id, requestRow.currency || "INR");
    const updatedRequest = await getWithdrawalRequestByIdForUpdate(conn, requestRow.id);
    payout = await findPayoutByWithdrawalRequestIdForUpdate(conn, requestRow.id);

    return {
      alreadyProcessed: false,
      request: mapWithdrawalRow({
        ...updatedRequest,
        technician_name: payoutProfile?.name || null,
        technician_email: payoutProfile?.email || null,
        payout_id: payout?.id || null,
        payout_reference: payout?.payout_reference || null,
        payout_status: payout?.status || PAYOUT_STATUS.paid,
        payout_method: payout?.payout_method || payoutMethod,
        destination_reference: payout?.destination_reference || requestRow.upi_id || null,
        destination_name: payout?.destination_name || requestRow.beneficiary_name || null,
        payout_external_reference: payout?.external_reference || externalReference || null,
        payout_processed_at: payout?.processed_at || processedAt,
      }),
      wallet: mapWalletSnapshot(wallet),
    };
  });
}
