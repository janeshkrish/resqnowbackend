# QA-003 cash settlement idempotency implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. Track steps with checkboxes.

**Goal:** One financial finalization per service request under cash retries, concurrent cash/capture and cancellation.

**Architecture:** Lock the request before checking financial state and keep quote/accounting in that transaction. Cash and captured online orders share a nullable unique `payments.settlement_key` (`service-request:<id>`); completed legacy payments are also checked under the request lock. A replay reuses its original payment/invoice and never increments jobs, releases capacity or posts another fee/credit.

**Tech Stack:** Existing Express, mysql2 UUID adapter, Razorpay, node:test; no new dependencies.

**Spec:** `../../../../QA_DEEP_AUDIT_REPORT.md`, QA-003.

## Global constraints

- Preserve all pending QA-001/QA-002 changes; no branch, worktree, commit or deployment requested.
- Keep the existing cash URL/response fields; add payment/invoice IDs on first success and replay.
- Keep existing cash operational eligibility/status policy; QA-004 is a separate task. Cancellation is rechecked as a competing terminal state.
- No live DB/gateway, production reconciliation or automatic refund.
- Add nullable uniqueness without backfilling old financial rows; fail startup if the required column/index is missing or not unique.

## Review focus

- Two calls reading an unpaid snapshot must produce one payment, invoice, job count and cash fee obligation.
- Capture/cash must share request-first lock order and reject the incompatible winner without a wallet credit or cash due.
- Cancellation winning must not be resurrected by cash or capture; cash winning blocks subsequent cancellation through existing policy.
- A failed transaction rolls back all accounting and can retry; post-commit delivery failure cannot cause another settlement.
- Legacy same-method settlement reuses the original invoice; missing/ambiguous records fail closed.

### Task 1: Cash transaction and shared settlement boundary

**Files:** New `tests/cash_settlement.test.js`, new `services/servicePaymentSettlement.js`; modify `routes/payments.js`, `models/schema/commerce.js`, `models/bootstrap.js`, `models/migrations/uuidMigration.js` and related schema/migration/billing tests.

**Interfaces:** `serviceSettlementKey(requestId)` returns the deterministic identity. `findCompletedServiceSettlement(connection, requestId)` returns at most one completed payment with a locking read or raises a reconciliation conflict. Route cash performs a request-first transaction and returns existing IDs on replay. Captured online settlement follows the same lock order and assigns the same key.

- [x] Add real-handler tests with stateful SQL/provider boundaries; observe duplicate cash, incompatible paid state and cash/capture/cancel failures before implementation.
- [x] Add schema/bootstrap and UUID settlement-key migration regressions, observe failures.
- [x] Implement nullable unique identity, fail-closed schema bootstrap and UUID key conversion.
- [x] Implement request-first transaction/re-read and replay guards in cash and capture; keep post-commit side effects from restarting settlement.
- [x] Run focused tests, cover rollback and legacy ambiguity, and confirm no extra cash fee/wallet entries.

### Task 2: Verification and rollout notes

- [x] Run complete backend npm test and npm run build with external credentials removed; local test networking may use host permission.
- [x] Request fresh read-only code review per requesting-code-review skill and resolve important findings.
- [x] Document schema prerequisites, legacy reconciliation, actual competing gateway-charge limits and local test isolation limits.
- [x] Keep historical audit and PROJECT_CONTEXT files unchanged; report local results without deploying.

## Execution evidence and rulings

- Original route probes: 7 failed / 4 passed, including two cash payments/invoices from concurrent unpaid snapshots and cash/capture double settlement. Four schema guard tests and the UUID settlement-key conversion regression also failed before implementation.
- Ruling: include the competing checkout/confirmation status writers in QA-003. Review demonstrated they could reopen a towing settlement and repeat its job-count increment despite the unique key. Treating the key as independent settlement evidence and guarding those writes is necessary to meet this task's single-finalization guarantee.
- Paused real `/create-order` and `/confirm` regressions reproduced PENDING/PROCESSING regression after capture; all now pass. Fresh/reused checkout and confirmation request writes also preserve a winning cash settlement.
- Explicit request-only lock precedes any joined capture read; cash's unused technician join was removed. Runtime SQL assertions exercise the shared lock order, without claiming live isolation proof.
- Final `npm test -- --test-reporter=tap`: 719 total, 713 passed, 6 existing real-database analytics cases skipped, 0 failed. External service credentials removed; local HTTP/WebSocket tests used host networking.
- Final `npm run build`: 248 JavaScript files passed syntax checks. New tests comprise 27 cash/competing-writer cases and 4 schema-enforcement cases, plus the extended UUID migration regression.
- Fresh read-only review found one important competing-writer issue; after the fixes, its follow-up independently passed all 31 targeted cases and found no remaining important QA-003 blocker.
- Rollout documented in `docs/qa-003-cash-settlement.md`; no production schema, gateway, refund, deployment or historical repair performed. Earlier QA-001/002 work and historical audit/context reports preserved.
