# QA-001: account payment verification binding

Reference: `../../QA_DEEP_AUDIT_REPORT.md`, QA-001. This change covers technician registration and customer subscriptions. Existing service-request billing keeps its own payment records and settlement rules.

## Verification contract

- Existing create/verify URLs and successful response fields remain compatible with current clients.
- Checkout saves the authenticated owner, purpose, selected plan, server-calculated integer amount in paise, currency and provider order ID in `account_payment_orders` before returning success. Registration retains its existing pending-order fields.
- Confirmation checks the HMAC using timing-safe comparison, loads the binding, then fetches both Razorpay order and payment. IDs, owner/purpose/plan notes, amount and currency must match. Payment must be captured, fully paid and unrefunded.
- Plan and price are frozen at checkout; a later catalog edit cannot change what that payment buys.
- A transaction locks the order and account, consumes the unique provider payment ID and updates the entitlement together. A completed replay returns success without restoring an older subscription or changing technician approval/job state.
- The existing signed `payment.captured` webhook can complete bound account orders when capture occurs after the client callback. Configure this event on the existing raw-body webhook endpoint. Invalid signatures cannot reach settlement. Provider/storage failures return errors for retry; they never grant access.

## Rollout

1. Deploy the additive `account_payment_orders` table from `models/schema/commerce.js` together with this backend. Normal startup calls `ensureAccountPaymentOrdersTable` after parent tables exist and does not become ready if bootstrap fails. The UUID deployment model also includes the table. If schema changes are managed separately, apply that exact DDL before routing traffic to this code.
2. Use one backend version across payment traffic before reopening checkout. An old backend can still accept unbound payments, so a mixed-version rollout does not provide the new guarantee.
3. Outstanding orders created before this release have no durable binding and fail closed. Do not backfill ownership/plan from a new client request or grant entitlement based only on a signature. Reconcile already-paid legacy orders against merchant evidence under a separate operational procedure; use new bound checkout only for unpaid purchases. Existing completed account entitlements are preserved.
4. Confirm test-mode registration/subscription capture, delayed capture webhook, duplicate client/webhook delivery, wrong account/plan/purpose, refund rejection and DB retry against staging MySQL/TiDB plus Razorpay before production rollout.

No live schema, gateway, deployment or reconciliation operation was performed during implementation. Local tests run the actual route/service/UUID adapter with simulated SQL and gateway boundaries; they do not prove live database isolation or merchant webhook delivery. Refund-driven entitlement revocation and checkout retry deduplication remain separate lifecycle concerns.
