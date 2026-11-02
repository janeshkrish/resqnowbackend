import crypto from 'node:crypto';
import { isUuid } from '../models/identifiers.js';
import { normalizeStatusForWorkflow } from './requestStatusWorkflow.js';
import { isTowingServiceType } from './towingServiceType.js';
import { resolveServiceRequestBillingBase, resolveServiceRequestTechnicianAmount } from './serviceRequestPaymentService.js';
import { settlementConflict } from './servicePaymentSettlement.js';
import { acceptedPricingSnapshot } from './dispatchPricingService.js';

const paise = value => Math.round(Number(value) * 100);
export function assertCashPayable(request) {
  const towing = isTowingServiceType(request.service_type);
  const status = normalizeStatusForWorkflow(request.status, { towing });
  const stages = towing ? ['service_completed', 'payment_pending'] : ['awaiting_payment', 'payment_pending'];
  if (!stages.includes(status)) {
    throw settlementConflict('CASH_STAGE_NOT_PAYABLE', 'Cash payment is available after the technician finishes the service.');
  }
}

export function readCashIntent(request) {
  let intent;
  try { intent = typeof request.cash_payment_intent === 'string' ? JSON.parse(request.cash_payment_intent) : request.cash_payment_intent; } catch { /* fail closed below */ }
  const breakdown = intent?.breakdown;
  const agreedCurrency = acceptedPricingSnapshot(request)?.currency || 'INR';
  if (intent?.version !== 1 || !isUuid(intent.intentId) || intent.requestId !== request.id ||
    intent.userId !== request.user_id || intent.technicianId !== request.technician_id ||
    !breakdown || !/^[A-Z]{3}$/.test(intent.currency) || breakdown.currency !== intent.currency || intent.currency !== agreedCurrency ||
    !Number.isSafeInteger(intent.amountPaise) || intent.amountPaise <= 0 || paise(breakdown.totalAmount) !== intent.amountPaise ||
    paise(breakdown.baseAmount) !== paise(resolveServiceRequestBillingBase(request)) ||
    paise(intent.technicianAmount) !== paise(resolveServiceRequestTechnicianAmount(request)) ||
    !Number.isFinite(Number(breakdown.platformFee)) || Number(breakdown.platformFee) < 0 || Number(breakdown.paymentFee) !== 0 ||
    paise(Number(breakdown.baseAmount) + Number(breakdown.platformFee)) !== intent.amountPaise ||
    !intent.coupon || typeof intent.coupon !== 'object') {
    throw settlementConflict('CASH_INTENT_STALE', 'Cash details changed. Ask the customer to choose cash again.');
  }
  return intent;
}

export function createCashIntent(request, { breakdown, coupon, technicianAmount }) {
  if (!isUuid(request.technician_id)) throw settlementConflict('CASH_TECHNICIAN_REQUIRED', 'An assigned technician must collect this payment.');
  const intent = { version: 1, intentId: crypto.randomUUID(), requestId: request.id, userId: request.user_id,
    technicianId: request.technician_id, amountPaise: paise(breakdown.totalAmount), currency: breakdown.currency,
    technicianAmount, breakdown, coupon, createdAt: new Date().toISOString() };
  return readCashIntent({ ...request, cash_payment_intent: intent });
}

export function assertCashReceipt(intent, body, technicianId) {
  if (body.received !== true) {
    throw Object.assign(new Error('Confirm that you received the full cash amount.'), { statusCode: 400, code: 'CASH_RECEIPT_REQUIRED' });
  }
  if (intent.technicianId !== technicianId || body.intentId !== intent.intentId ||
      typeof body.amountPaise !== 'number' || body.amountPaise !== intent.amountPaise || body.currency !== intent.currency) {
    throw settlementConflict('CASH_RECEIPT_MISMATCH', 'Cash receipt does not match the current amount, assignment or cash choice. Refresh the job.');
  }
}

export function publicCashIntent(intent) {
  return { intentId: intent.intentId, technicianId: intent.technicianId, amountPaise: intent.amountPaise, currency: intent.currency };
}
