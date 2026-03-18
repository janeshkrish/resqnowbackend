import { roundMoney } from "../utils/money.js";

export async function withTransaction(pool, handler) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      // no-op
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function getTechnicianWalletForUpdate(conn, technicianId) {
  const [rows] = await conn.query(
    `SELECT *
     FROM technician_wallets
     WHERE technician_id = ?
     LIMIT 1
     FOR UPDATE`,
    [technicianId]
  );
  return rows[0] || null;
}

async function getTechnicianForUpdate(conn, technicianId) {
  const normalizedTechnicianId = Number(technicianId);
  if (!Number.isInteger(normalizedTechnicianId) || normalizedTechnicianId <= 0) {
    return null;
  }

  const [rows] = await conn.query(
    `SELECT id
     FROM technicians
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [normalizedTechnicianId]
  );
  return rows[0] || null;
}

export async function ensureTechnicianWallet(conn, technicianId, currency = "INR") {
  const normalizedTechnicianId = Number(technicianId);
  if (!Number.isInteger(normalizedTechnicianId) || normalizedTechnicianId <= 0) {
    return null;
  }

  const existing = await getTechnicianWalletForUpdate(conn, normalizedTechnicianId);
  if (existing) return existing;

  const technician = await getTechnicianForUpdate(conn, normalizedTechnicianId);
  if (!technician) {
    return null;
  }

  try {
    await conn.execute(
      `INSERT INTO technician_wallets (
        technician_id,
        currency,
        total_earned,
        withdrawable_balance,
        total_paid_out,
        on_hold_balance
      ) VALUES (?, ?, 0, 0, 0, 0)`,
      [normalizedTechnicianId, String(currency || "INR").toUpperCase()]
    );
  } catch (error) {
    const isDuplicateWallet =
      error?.code === "ER_DUP_ENTRY" ||
      error?.errno === 1062 ||
      String(error?.message || "").includes("Duplicate entry");

    if (!isDuplicateWallet) {
      throw error;
    }
  }

  return getTechnicianWalletForUpdate(conn, normalizedTechnicianId);
}

export async function updateTechnicianWalletSnapshot(
  conn,
  walletId,
  { totalEarned, withdrawableBalance, totalPaidOut, onHoldBalance = 0, lastTransactionAt = null }
) {
  await conn.execute(
    `UPDATE technician_wallets
     SET total_earned = ?,
         withdrawable_balance = ?,
         total_paid_out = ?,
         on_hold_balance = ?,
         last_transaction_at = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [
      roundMoney(totalEarned),
      roundMoney(withdrawableBalance),
      roundMoney(totalPaidOut),
      roundMoney(onHoldBalance),
      lastTransactionAt,
      walletId,
    ]
  );
}

export async function createWalletTransaction(conn, payload) {
  const [result] = await conn.execute(
    `INSERT INTO wallet_transactions (
      wallet_id,
      technician_id,
      service_request_id,
      payment_id,
      payout_id,
      entry_type,
      direction,
      amount,
      allocated_amount,
      balance_before,
      balance_after,
      description,
      reference_type,
      reference_id,
      idempotency_key,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.walletId,
      payload.technicianId,
      payload.serviceRequestId || null,
      payload.paymentId || null,
      payload.payoutId || null,
      payload.entryType,
      payload.direction,
      roundMoney(payload.amount),
      roundMoney(payload.allocatedAmount || 0),
      roundMoney(payload.balanceBefore),
      roundMoney(payload.balanceAfter),
      payload.description || null,
      payload.referenceType || null,
      payload.referenceId || null,
      payload.idempotencyKey || null,
      payload.metadata ? JSON.stringify(payload.metadata) : null,
    ]
  );
  return Number(result.insertId);
}

export async function getWalletCreditByPaymentIdForUpdate(conn, paymentId) {
  const [rows] = await conn.query(
    `SELECT *
     FROM wallet_transactions
     WHERE payment_id = ?
       AND entry_type = 'payment_credit'
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE`,
    [paymentId]
  );
  return rows[0] || null;
}

export async function listOpenWalletCreditsForUpdate(conn, technicianId) {
  const [rows] = await conn.query(
    `SELECT *
     FROM wallet_transactions
     WHERE technician_id = ?
       AND entry_type = 'payment_credit'
       AND amount > COALESCE(allocated_amount, 0)
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
    [technicianId]
  );
  return rows || [];
}

export async function updateWalletTransactionAllocation(conn, walletTransactionId, allocatedAmount) {
  await conn.execute(
    `UPDATE wallet_transactions
     SET allocated_amount = ?
     WHERE id = ?`,
    [roundMoney(allocatedAmount), walletTransactionId]
  );
}

export async function updatePaymentLedgerSnapshot(
  conn,
  paymentId,
  {
    status,
    amount,
    baseAmount,
    platformFee,
    paymentFee,
    paymentToTechnicianStatus,
    ledgerStatus,
    walletTransactionId = null,
    razorpayPaymentId = null,
    razorpaySignature = null,
    currency = null,
    pricingSnapshot = null,
    verifiedAt = null,
    capturedAt = null,
  }
) {
  await conn.execute(
    `UPDATE payments
     SET status = COALESCE(?, status),
         amount = COALESCE(?, amount),
         technician_amount = COALESCE(?, technician_amount),
         base_amount = COALESCE(?, base_amount),
         platform_fee = COALESCE(?, platform_fee),
         payment_fee = COALESCE(?, payment_fee),
         payment_to_technician_status = COALESCE(?, payment_to_technician_status),
         ledger_status = COALESCE(?, ledger_status),
         wallet_transaction_id = COALESCE(?, wallet_transaction_id),
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         razorpay_signature = COALESCE(?, razorpay_signature),
         currency = COALESCE(?, currency),
         pricing_snapshot = COALESCE(?, pricing_snapshot),
         verified_at = COALESCE(?, verified_at),
         captured_at = COALESCE(?, captured_at)
     WHERE id = ?`,
    [
      status || null,
      amount != null ? roundMoney(amount) : null,
      baseAmount != null ? roundMoney(baseAmount) : null,
      baseAmount != null ? roundMoney(baseAmount) : null,
      platformFee != null ? roundMoney(platformFee) : null,
      paymentFee != null ? roundMoney(paymentFee) : null,
      paymentToTechnicianStatus || null,
      ledgerStatus || null,
      walletTransactionId,
      razorpayPaymentId,
      razorpaySignature,
      currency ? String(currency).toUpperCase() : null,
      pricingSnapshot ? JSON.stringify(pricingSnapshot) : null,
      verifiedAt,
      capturedAt,
      paymentId,
    ]
  );
}

export async function createPayoutRecord(conn, payload) {
  const [result] = await conn.execute(
    `INSERT INTO payouts (
      payout_reference,
      idempotency_key,
      technician_id,
      wallet_id,
      amount,
      currency,
      status,
      payout_method,
      destination_reference,
      external_reference,
      notes,
      created_by,
      processed_by,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.payoutReference,
      payload.idempotencyKey || null,
      payload.technicianId,
      payload.walletId,
      roundMoney(payload.amount),
      String(payload.currency || "INR").toUpperCase(),
      payload.status,
      payload.payoutMethod || null,
      payload.destinationReference || null,
      payload.externalReference || null,
      payload.notes || null,
      payload.createdBy || null,
      payload.processedBy || null,
      payload.processedAt || null,
    ]
  );
  return Number(result.insertId);
}

export async function findPayoutByIdempotencyKey(conn, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await conn.query(
    `SELECT *
     FROM payouts
     WHERE idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

export async function findPaymentRefundByIdempotencyKey(conn, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await conn.query(
    `SELECT *
     FROM payment_refunds
     WHERE idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

export async function createPayoutAllocation(conn, payload) {
  const [result] = await conn.execute(
    `INSERT INTO payout_allocations (
      payout_id,
      wallet_transaction_id,
      payment_id,
      service_request_id,
      amount
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      payload.payoutId,
      payload.walletTransactionId,
      payload.paymentId || null,
      payload.serviceRequestId || null,
      roundMoney(payload.amount),
    ]
  );
  return Number(result.insertId);
}

export async function getTechnicianWalletSnapshot(pool, technicianId) {
  const [rows] = await pool.query(
    `SELECT *
     FROM technician_wallets
     WHERE technician_id = ?
     LIMIT 1`,
    [technicianId]
  );
  return rows[0] || null;
}

export async function listTechnicianWalletTransactions(pool, technicianId, limit = 20) {
  const [rows] = await pool.query(
    `SELECT
       wt.*,
       sr.service_type,
       sr.vehicle_type,
       sr.vehicle_model,
       sr.address,
       p.status AS payment_status,
       po.status AS payout_status,
       po.payout_reference,
       po.external_reference
     FROM wallet_transactions wt
     LEFT JOIN service_requests sr ON sr.id = wt.service_request_id
     LEFT JOIN payments p ON p.id = wt.payment_id
     LEFT JOIN payouts po ON po.id = wt.payout_id
     WHERE wt.technician_id = ?
     ORDER BY wt.created_at DESC, wt.id DESC
     LIMIT ?`,
    [technicianId, limit]
  );
  return rows || [];
}

export async function listEligibleWallets(pool, { minBalance = 0.01, limit = 500 } = {}) {
  const [rows] = await pool.query(
    `SELECT
       tw.id AS wallet_id,
       tw.technician_id,
       tw.currency,
       tw.total_earned,
       tw.withdrawable_balance,
       tw.total_paid_out,
       tw.last_transaction_at,
       t.name AS technician_name,
       t.email AS technician_email,
       COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id
     FROM technician_wallets tw
     JOIN technicians t ON t.id = tw.technician_id
     WHERE tw.withdrawable_balance >= ?
     ORDER BY tw.withdrawable_balance DESC, tw.updated_at ASC
     LIMIT ?`,
    [roundMoney(minBalance), limit]
  );
  return rows || [];
}

function buildWalletSearchSql(search) {
  if (!search) {
    return { clause: "", values: [] };
  }
  const like = `%${String(search).trim().toLowerCase()}%`;
  return {
    clause: `AND (
      LOWER(COALESCE(t.name, '')) LIKE ?
      OR LOWER(COALESCE(t.email, '')) LIKE ?
      OR LOWER(COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), ''))) LIKE ?
      OR CAST(t.id AS CHAR) LIKE ?
    )`,
    values: [like, like, like, like],
  };
}

export async function listTechnicianWalletBalances(
  pool,
  { search = "", onlyPositiveBalance = false, limit = 20, offset = 0 } = {}
) {
  const { clause, values } = buildWalletSearchSql(search);
  const balanceClause = onlyPositiveBalance ? "AND COALESCE(tw.withdrawable_balance, 0) > 0" : "";
  const [rows] = await pool.query(
    `SELECT
       t.id AS technician_id,
       t.name AS technician_name,
       t.email AS technician_email,
       COALESCE(NULLIF(TRIM(t.upi_id), ''), NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(t.payment_details, '$.upi_id'))), '')) AS upi_id,
       COALESCE(tw.id, 0) AS wallet_id,
       COALESCE(tw.currency, 'INR') AS currency,
       COALESCE(tw.total_earned, 0) AS total_earned,
       COALESCE(tw.withdrawable_balance, 0) AS withdrawable_balance,
       COALESCE(tw.total_paid_out, 0) AS total_paid_out,
       COALESCE(tw.on_hold_balance, 0) AS on_hold_balance,
       tw.last_transaction_at,
       tw.updated_at AS wallet_updated_at
     FROM technicians t
     LEFT JOIN technician_wallets tw ON tw.technician_id = t.id
     WHERE 1 = 1
       ${balanceClause}
       ${clause}
     ORDER BY COALESCE(tw.withdrawable_balance, 0) DESC, COALESCE(tw.updated_at, t.created_at) DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, offset]
  );
  return rows || [];
}

export async function countTechnicianWalletBalances(pool, { search = "", onlyPositiveBalance = false } = {}) {
  const { clause, values } = buildWalletSearchSql(search);
  const balanceClause = onlyPositiveBalance ? "AND COALESCE(tw.withdrawable_balance, 0) > 0" : "";
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM technicians t
     LEFT JOIN technician_wallets tw ON tw.technician_id = t.id
     WHERE 1 = 1
       ${balanceClause}
       ${clause}`,
    values
  );
  return Number(rows?.[0]?.total || 0);
}
