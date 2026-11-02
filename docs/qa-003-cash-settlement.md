# QA-003: duplicate cash accounting

Reference: `../../QA_DEEP_AUDIT_REPORT.md`, QA-003. The historical audit is unchanged. This work preserves the cash service-stage/receipt policy for the separate QA-004 fix.

## Financial boundary

Cash now starts a transaction before loading and checking the authenticated customer's request. Its current state is read with `FOR UPDATE`; quote calculation, request/payment/invoice writes, technician release and job-count update use that connection. A retry loads the completed payment and original cash invoice, returns their `payment_id`/`invoice_id` plus the existing response fields, and performs no financial or job mutation. A timestamp is no longer part of a new cash invoice's order identity.

Cash and Razorpay capture both claim `payments.settlement_key = service-request:<request UUID>`. A nullable unique index permits multiple pending attempts while allowing one final settlement. Capture discovers the request without a payment lock, locks the request, then re-reads its payment with a lock. It rejects a different prior settlement, including cash, and does not credit the wallet, issue another invoice or increment jobs. An exact completed capture replay reuses the original invoice without releasing or crediting again.

The key is settlement evidence independently of mutable status flags. A keyed row whose status has been regressed or whose key does not match its request fails reconciliation rather than being finalized again. Pending-order upserts and client signature verification cannot reset completed/keyed payment rows. Both fresh and reused checkout request updates, plus the confirmation payment-method update, use conditional writes that cannot overwrite a winning financial settlement. Delayed checkout therefore cannot reopen towing accounting after capture or replace cash-paid request flags.

Cancellation uses the same request serialization point. A cancelled/rejected/expired request cannot be financially finalized. Existing customer cancellation policy rejects a cancellation once cash has advanced the request. This does not introduce a new service-completion or technician cash-receipt policy.

## Legacy data and failures

- Completed legacy payments without a key still block a second settlement. A single matching cash payment/invoice is reused; existing records are not backfilled or rewritten automatically.
- Multiple completed payments, missing/ambiguous cash invoices, orphan cash invoices, or paid flags without payment evidence return a reconciliation conflict. No duplicate history is deleted or merged.
- Payment/invoice/credit failure rolls back the entire transaction, including the settlement claim. A delivery/read failure after commit may still yield a server error, but the next cash retry returns the committed IDs and cannot create another fee obligation or job count.
- A gateway may genuinely capture an old online order after cash has won. This change prevents a second internal settlement; it cannot undo the external charge. A signed conflicting capture is acknowledged with `processed: false` and a conflict reason logged for separate merchant reconciliation/refund. No automatic refund was performed or added.

## Schema rollout

Deploy the additive nullable `payments.settlement_key VARCHAR(80)` column and full unique `uq_payments_settlement_key` index with this backend. `ensurePaymentsTable` adds them and verifies the column and uniqueness; startup refuses missing/incompatible definitions instead of serving without the boundary. The modeled schema and UUID export/migration also preserve/remap this internal request identity.

Use one backend version across payment traffic; an old writer can insert a NULL key and bypass the new application guards. No live schema/deployment action was performed. Retain historical NULL keys until a separately reviewed reconciliation procedure establishes trustworthy settlement ownership.

## Validation limits

Tests run actual cash, signed capture and customer-cancellation handlers, payment/wallet code and UUID persistence against simulated SQL/provider boundaries. SQL assertions require locked current reads and request-before-payment lock order; the in-memory transaction queue cannot prove MySQL/TiDB isolation or deadlock behavior. Validate concurrent cash/cash, cash/capture, cash/cancel and commit-unknown retries against staging database/gateway fixtures before production rollout.


Local verification: 27 cash/competing-writer tests and 4 schema-enforcement tests pass; the extended UUID migration regression passes. The complete backend suite has 713 passes, 6 existing live-database analytics skips and no failures. Syntax checks pass for all 248 JavaScript files. Fresh review's competing-writer blocker was reproduced, fixed and re-reviewed with no remaining important QA-003 issue.
