# QA-002: registration-payment replay and technician state

Reference: `../../QA_DEEP_AUDIT_REPORT.md`, QA-002. The audit remains the historical record and was not rewritten.

QA-001 removed the unconditional reset of approval, active/available flags and the current-job pointer, and introduced order-level replay protection. QA-002 completes the account-level one-time transition: different pending registration orders must not overwrite a registration that has already completed.

## State transition

- The existing transaction locks the bound payment order and the technician. It reads `registration_payment_status` from the locked technician record.
- Only the currently supported unpaid states, `pending` and `processing`, can become `completed`. The SQL update includes the same condition and must affect exactly one technician; otherwise the transaction rolls back without consuming the payment.
- Completing registration only writes its payment status and payment ID. Approval/rejection, activity, availability, job assignment and other technician fields remain under their existing workflows.
- A previously completed order returns idempotent success without technician writes, even when the provider is unavailable. Approval, rejection or a new active job occurring after first verification remain intact.
- If a different bound order is genuinely captured after registration already completed, the capture is still recorded in its own payment-ledger row, but the technician and original registration receipt remain unchanged. The response reports `duplicate: true`, meaning no additional registration transition occurred. This does not refund or discard a second real charge; financial reconciliation is a separate operation.
- New checkout cannot reopen completed registration. Unknown/null payment states fail with `409 REGISTRATION_PAYMENT_STATE_INVALID`, including a state changed while checkout was awaiting the gateway. Reconcile such legacy states before retrying; this fix does not reset them automatically.

## Verification and rollout

Regression tests exercise real route and payment-service logic with simulated SQL/gateway boundaries: approval-state and active-job replay, separate-order sequential/concurrent capture, client/webhook races, late webhooks, checkout state rechecks and transactional rollback. These simulations do not establish live MySQL/TiDB isolation or actual provider delivery.

No additional schema is required beyond QA-001's `account_payment_orders` ledger. Deploy with the QA-001 rollout prerequisites and validate duplicate callback/webhook delivery against staging before production. No live deployment, database changes, refunds or historical state repair were performed.

## Local verification evidence

- Added 14 QA-002 regressions; the combined account-payment regression file passes all 61 tests. Six new negative cases failed before the implementation change; replay/state-preservation characterization cases already passed after QA-001.
- The final full backend suite passes: 688 total, 682 passed, 6 existing real-database analytics tests skipped, 0 failed. External payment/database credentials were removed from the test process.
- A fresh read-only review found no critical/important issues. Its minor SQL-boundary test gap was addressed with selected-column projection, transaction-lock assertions and the guarded-update contract.
- Four isolated temporary mutations (missing selected status, missing order lock, missing technician lock and missing SQL state guard) each failed the registration regression. The original implementation was restored exactly afterward.
