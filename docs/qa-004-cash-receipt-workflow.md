# QA-004: cash receipt after service completion

Reference: `../../QA_DEEP_AUDIT_REPORT.md`, QA-004. Earlier QA-001–003 changes remain in place; audit/context files were not rewritten.

## Customer choice and technician receipt

`POST /api/payments/cash` remains customer-authenticated. It permits an unpaid cash choice only at the existing payable workflow stages: roadside `awaiting_payment`/`payment_pending`; towing `service_completed`/`payment_pending` (including the supported legacy `awaiting_payment` alias). Accepted, travelling, loading and arrived-at-drop stages are not cash-payable. State and ownership are checked on the locked current request.

Choosing cash saves `service_requests.cash_payment_intent` with a fresh identity, authenticated participants, server-priced amount/currency, quote/coupon snapshot and declaration time. Repeating the same valid choice reuses its intent. This step does not complete work, mark payment paid, create a paid payment/invoice, release the technician, increment jobs or create a cash-fee obligation.

`POST /api/payments/cash/confirm` requires the assigned technician's authentication and `{requestId,intentId,received:true,amountPaise,currency}`. The server rechecks stage, current assignment, cash method, frozen accepted quote and exact receipt details under the request lock. Reassignment, a changed accepted price/intent, another payment method or a stale amount cannot confirm the old receipt. User-supplied actor fields are ignored.

Successful receipt uses QA-003's shared settlement key and transaction. The completed payment snapshot records the trusted technician, intent, amount/currency and server receipt time. Its invoice, fee obligation, job counter and permitted capacity release are committed once. Roadside work reaches financial completion after work and receipt; towing retains its current completed-service/payment stage and closes through its normal paid workflow. Customer declarations and technician receipt retries reuse existing financial records without repeating accounting.

The customer UI says cash awaits technician confirmation. The active technician job receives the cash intent and offers “I received [amount] cash”. It posts technician authentication and the exact saved intent, disables duplicate taps, refreshes authoritative state after success/stale-state errors and does not claim receipt confirmed from an unpaid response. The local demo follows the two-participant flow.

## Schema and compatibility

Add nullable `service_requests.cash_payment_intent JSON` with this backend. Normal request-table bootstrap verifies that the required nullable JSON column exists; missing/incompatible schema prevents startup. UUID conversion remaps participants/request references inside the JSON while preserving the independent intent identity. No historical intent is invented or backfilled. Historical terminal paid/completed flags without payment evidence remain reconciliation conflicts.

Deploy compatible customer and technician UI/application code with the API/schema. Old customer cash calls now mean choice pending receipt. Old technician clients cannot acknowledge the new intent until updated. Do not restore customer-only settlement as a compatibility fallback. Existing completed cash receipts remain readable by their authenticated customer; a technician confirmation of legacy evidence without a recorded acknowledgement requires reconciliation.

This task does not repair past premature completions, execute a live migration, build/release an APK, refund payments or deploy. QA-005's separate generic unpaid technician-status transition remains a separate task. Online payment stage policy was not generalized by this cash fix.

## Verification limits

Regression tests exercise real cash/capture/cancellation/authentication, UUID and wallet logic with SQL/provider boundary doubles, including prior QA-003 races and rollback. They cover early/finished stages, mismatched actors, explicit acknowledgement, intent/amount/currency mismatches, reassignment, changed quotes and current-state rechecks. UI tests exercise pending customer choice, exact technician receipt, failed/stale/unpaid responses and duplicate taps.

The simulated transaction queue cannot prove actual MySQL/TiDB locking, deadlock recovery or external delivery. Before production, validate the full two-device customer/technician flow, concurrent receipt/capture/status changes, assignment changes and retry after lost responses against staging database/gateway fixtures.


Local verification: backend746 passed/6 existing live-database skips/0 failed; frontend844 passed across107 files with two workers. Backend syntax build, frontend typecheck and production build passed. Review's currency issue and commit-order regressions were resolved and independently rechecked. Existing frontend chunk-size warnings remain; no release was published.
