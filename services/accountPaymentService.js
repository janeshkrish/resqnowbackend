import crypto from 'node:crypto';
import { compactPaymentReceipt } from '../utils/paymentReference.js';

const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
const positiveInteger = value => (typeof value === 'number' || typeof value === 'string') &&
  String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,255}$/.test(value);

function registrationIsCompleted(technician) {
  const status = technician.registration_payment_status;
  if (!['pending', 'processing', 'completed'].includes(status)) {
    throw failure(409, 'REGISTRATION_PAYMENT_STATE_INVALID', 'Registration payment state requires reconciliation.');
  }
  return status === 'completed';
}

// Separate from service-request accounting: these orders buy account entitlements.
export function createAccountPaymentService({ pool, gateway, keySecret }) {
  async function lookup(orderId, connection = pool, lock = false) {
    const [rows] = await connection.query(
      `SELECT * FROM account_payment_orders WHERE razorpay_order_id = ?${lock ? ' FOR UPDATE' : ''}`, [orderId]);
    return rows[0];
  }

  function checkBinding(row, { purpose, ownerId, planCode }) {
    const validOwner = purpose === 'subscription'
      ? row?.user_id === ownerId && row?.technician_id == null && row?.plan_code === planCode
      : purpose === 'registration' && row?.technician_id === ownerId && row?.user_id == null && row?.plan_code == null;
    if (!row || row.purpose !== purpose || !validOwner) {
      throw failure(409, 'PAYMENT_BINDING_MISMATCH', 'Payment does not match this account, purpose or plan.');
    }
    if (!positiveInteger(row.amount_paise) || !/^[A-Z]{3}$/.test(row.currency)) {
      throw failure(409, 'PAYMENT_BINDING_INVALID', 'Payment order requires reconciliation.');
    }
  }

  function completed(row, paymentId) {
    if (row.status === 'completed') {
      if (row.razorpay_payment_id !== paymentId) {
        throw failure(409, 'PAYMENT_ALREADY_CONSUMED', 'Order has already been completed with a different payment.');
      }
      return true;
    }
    if (row.status !== 'created' || row.razorpay_payment_id != null) {
      throw failure(409, 'PAYMENT_STATE_INVALID', 'Payment order requires reconciliation.');
    }
    return false;
  }

  async function validateCapture(row, paymentId) {
    let order, payment;
    try {
      [order, payment] = await Promise.all([
        gateway.orders.fetch(row.razorpay_order_id), gateway.payments.fetch(paymentId),
      ]);
    } catch {
      throw failure(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment gateway unavailable. Please retry confirmation.');
    }
    const notes = order?.notes || {};
    const ownerMatches = row.purpose === 'subscription'
      ? notes.userId === row.user_id && notes.planId === row.plan_code
      : notes.technicianId === row.technician_id;
    if (!order || !payment || order.id !== row.razorpay_order_id || payment.id !== paymentId ||
      payment.order_id !== row.razorpay_order_id || !positiveInteger(order.amount) || !positiveInteger(payment.amount) ||
      Number(order.amount) !== Number(row.amount_paise) || Number(payment.amount) !== Number(row.amount_paise) ||
      order.currency !== row.currency || payment.currency !== row.currency || notes.type !== row.purpose || !ownerMatches) {
      throw failure(409, 'PAYMENT_DETAILS_MISMATCH', 'Gateway payment does not match the saved checkout.');
    }
    if (payment.status !== 'captured' || payment.captured !== true || order.status !== 'paid' ||
      Number(order.amount_paid) !== Number(row.amount_paise) || Number(order.amount_due) !== 0 ||
      payment.amount_refunded == null || Number(payment.amount_refunded) !== 0 ||
      (payment.refund_status != null && payment.refund_status !== '')) {
      throw failure(409, 'PAYMENT_NOT_CAPTURED', 'Payment must be fully captured and unrefunded. Retry after capture.');
    }
  }

  async function settle(input) {
    const row = await lookup(input.orderId);
    checkBinding(row, input);
    if (completed(row, input.paymentId)) return { success: true, duplicate: true };
    await validateCapture(row, input.paymentId);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // Webhook and client callbacks serialize on the same durable order.
      const locked = await lookup(input.orderId, connection, true);
      checkBinding(locked, input);
      if (completed(locked, input.paymentId)) {
        await connection.commit();
        return { success: true, duplicate: true };
      }
      const subscription = locked.purpose === 'subscription';
      const [owners] = await connection.query(
        `SELECT id${subscription ? '' : ', registration_payment_status'} FROM ${subscription ? 'users' : 'technicians'} WHERE id = ? FOR UPDATE`, [input.ownerId]);
      if (!owners.length) throw failure(409, 'PAYMENT_OWNER_MISSING', 'Payment account no longer exists.');
      // Different pending orders also serialize on the technician. Record their
      // valid captures, but only the first can complete the registration account.
      const registrationAlreadyPaid = !subscription && registrationIsCompleted(owners[0]);
      await connection.execute(
        "UPDATE account_payment_orders SET razorpay_payment_id = ?, status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?",
        [input.paymentId, locked.id]);
      if (subscription) {
        await connection.execute('UPDATE users SET subscription = ? WHERE id = ?', [locked.plan_code, locked.user_id]);
      } else if (!registrationAlreadyPaid) {
        // Payment completion must not reset approval, availability or a current job.
        const [transition] = await connection.execute(
          "UPDATE technicians SET registration_payment_status = 'completed', registration_payment_id = ? WHERE id = ? AND registration_payment_status IN ('pending', 'processing')",
          [input.paymentId, locked.technician_id]);
        if (transition.affectedRows !== 1) {
          throw failure(409, 'REGISTRATION_PAYMENT_STATE_INVALID', 'Registration payment state changed. Please retry confirmation.');
        }
      }
      await connection.commit();
      return { success: true, duplicate: registrationAlreadyPaid };
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        throw failure(409, 'PAYMENT_ALREADY_CONSUMED', 'Payment has already been used.');
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  return {
    async createOrder({ purpose, ownerId, planCode = null, amountPaise, currency }) {
      if (!['registration', 'subscription'].includes(purpose) || !ownerId ||
        (purpose === 'subscription' && (typeof planCode !== 'string' || !planCode || planCode.length > 50)) ||
        (purpose === 'registration' && planCode != null) || !positiveInteger(amountPaise) || !/^[A-Z]{3}$/.test(currency)) {
        throw failure(400, 'INVALID_PAYMENT_ORDER', 'Invalid account payment order.');
      }
      const subscription = purpose === 'subscription';
      const [owners] = await pool.query(`SELECT id, ${subscription ? 'subscription' : 'registration_payment_status'} FROM ${subscription ? 'users' : 'technicians'} WHERE id = ?`, [ownerId]);
      if (!owners.length) throw failure(404, 'PAYMENT_OWNER_MISSING', 'Payment account not found.');
      if (!subscription && registrationIsCompleted(owners[0])) {
        throw failure(409, 'REGISTRATION_ALREADY_PAID', 'Registration has already been paid.');
      }
      const notes = subscription ? { type: purpose, userId: ownerId, planId: planCode }
        : { type: purpose, technicianId: ownerId };
      let order;
      try {
        order = await gateway.orders.create({ amount: Number(amountPaise), currency, notes,
          receipt: compactPaymentReceipt(`${purpose}_${ownerId}_${crypto.randomUUID()}`) });
      } catch {
        throw failure(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Unable to create payment order. Please retry.');
      }
      if (!identifier(order?.id) || !positiveInteger(order.amount) || Number(order.amount) !== Number(amountPaise) || order.currency !== currency) {
        throw failure(503, 'INVALID_GATEWAY_ORDER', 'Payment gateway returned an invalid order.');
      }
      // Never expose checkout until its binding and legacy registration fields
      // have been saved together. Lock prevents a concurrent capture being reset.
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [currentOwners] = await connection.query(
          `SELECT id, ${subscription ? 'subscription' : 'registration_payment_status'} FROM ${subscription ? 'users' : 'technicians'} WHERE id = ? FOR UPDATE`, [ownerId]);
        if (!currentOwners.length) throw failure(404, 'PAYMENT_OWNER_MISSING', 'Payment account not found.');
        if (!subscription && registrationIsCompleted(currentOwners[0])) {
          throw failure(409, 'REGISTRATION_ALREADY_PAID', 'Registration has already been paid.');
        }
        await connection.execute(`INSERT INTO account_payment_orders
          (purpose, user_id, technician_id, plan_code, amount_paise, currency, razorpay_order_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [purpose, subscription ? ownerId : null, subscription ? null : ownerId, planCode, Number(amountPaise), currency, order.id, 'created']);
        if (!subscription) {
          await connection.execute(
            "UPDATE technicians SET registration_order_id = ?, registration_payment_status = 'processing' WHERE id = ?",
            [order.id, ownerId]);
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      return order;
    },

    async verifyPayment(input) {
      if (!identifier(input.orderId) || !identifier(input.paymentId) ||
        typeof input.signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.signature)) {
        throw failure(400, 'INVALID_PAYMENT_SIGNATURE', 'Invalid payment signature or identifiers.');
      }
      const expected = crypto.createHmac('sha256', keySecret).update(`${input.orderId}|${input.paymentId}`).digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(input.signature, 'hex'))) {
        throw failure(400, 'INVALID_PAYMENT_SIGNATURE', 'Invalid payment signature.');
      }
      return settle(input);
    },

    // Only invoke after verifying the raw Razorpay webhook signature.
    async finalizeCapturedOrder({ orderId, paymentId }) {
      if (!identifier(orderId) || !identifier(paymentId)) throw failure(400, 'INVALID_PAYMENT_ID', 'Invalid payment identifiers.');
      const row = await lookup(orderId);
      if (!row) return { processed: false, reason: 'account_order_not_found' };
      const result = await settle({ orderId, paymentId, purpose: row.purpose,
        ownerId: row.purpose === 'subscription' ? row.user_id : row.technician_id, planCode: row.plan_code });
      return { processed: true, duplicate: result.duplicate };
    },
  };
}
