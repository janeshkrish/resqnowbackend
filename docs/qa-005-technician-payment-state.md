# QA-005: Technician status cannot establish payment

Reference: root `QA_DEEP_AUDIT_REPORT.md`, QA-005. Depends on the QA-003 settlement service and preserves QA-004 cash receipt confirmation.

## Feature behavior

- A non-towing technician's work-complete action still moves the job to `awaiting_payment`. It does not pay the bill or release the job reservation.
- The generic technician-status endpoint rejects non-towing `paid`, including retries and jobs with an existing paid flag. Online verification or the assigned technician's exact cash receipt confirmation must settle the request; those services finalize non-towing jobs.
- `closed` is not a non-towing workflow status. Historical unpaid closed retries cannot release reservations.
- Towing work completion still means `service_completed`; the usual next stage is `payment_pending`. Closing (including legacy `paid`/`job_closed` aliases) requires paid/completed request payment status and a single matching completed payment record for this request/customer/technician.
- Towing closure locks the assigned request first, then reads payment and invoice evidence with locks on the same connection. The payment binds the request/customer; the matching invoice binds the technician. It uses QA-003's shared settlement lookup, rejecting duplicate, regressed keyed, and mismatched settlements with HTTP 409. Online order/payment references must both match the invoice. Cash uses the existing request/customer/technician and `cash_` invoice convention. Unambiguous legacy completed payments without a settlement key remain readable when their matching invoice is present.
- Payment checks run before identical-terminal-status success. A verified repeat of towing closure returns read-only success; it does not repeat release or timeline notifications.
- Failed updates leave job stage, payment state, payment records, job counters, and reservation unchanged. Request-body payment flags never establish evidence.

## Changed surfaces

`services/requestStatusWorkflow.js` enforces the status policy; `routes/service_requests.js` verifies settlement under the existing assignment lock and returns reconciliation conflicts. Existing live customer checkout and technician cash receipt controls need no new button or screen.

Frontend-only demo `src/lib/api.ts` no longer creates payment through technician status updates. Demo online confirmation retains explicit local confirmation evidence and leaves towing jobs at payment pending; demo cash receipts remain evidence for closure. Demo storage is not an actual financial ledger or a production security boundary.

## Release and historical state

No new schema or dependency is needed beyond the earlier QA fixes. Deploy the backend together with those prerequisites; the frontend demo change is local simulation parity. Existing live clients that attempt non-towing `paid` through technician-status will receive HTTP 409 and must use the established payment endpoints.

This fix does not automatically repair historically inconsistent jobs, synthesize payments, repair technician availability, or reconcile ambiguous financial records. Historical paid/closed labels without evidence require explicit reconciliation.

## Verification

Regression tests exercise the real policy and route with a stateful SQL boundary double. They verify lock/read ordering and observable state effects, not MySQL's actual concurrent isolation behavior. No live unpaid job, database, gateway, or deployment is used.

- Backend after manual-test preparation correction: 790 tests total, 784 passed, 6 existing live-database analytics tests skipped; zero failed. Build syntax check passed for 251 JavaScript files.
- Focused backend regression file: 38/38 passed. Preparing manual tests exposed an invented `payments.technician_id` field in the original positive fixtures. Removing that field reproduced legitimate closure failing; the route now uses actual invoice ownership and matching payment references. Fresh read-only review independently reran 38/38 and checked schema and insert paths.
- Frontend demo: 11/11 passed after reproducing six failures.
- Fresh read-only review: no Critical or Important findings. Deferred minor: frontend-only demo accepts raw non-towing `job_closed`/`job-closed` labels; production rejects them and neither demo alias establishes payment.
- Frontend: all 852 tests across 107 files passed. Typecheck and production build passed; existing large-chunk advisory remains.
- Both repository diff whitespace checks passed. No deployment, live gateway/database test, or historical repair was performed.
