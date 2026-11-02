# QA-001 payment verification binding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent registration/subscription entitlement from being granted by a valid payment for another owner, purpose, plan, price or uncaptured order.

**Architecture:** Keep existing HTTP contracts. Add a modeled `account_payment_orders` ledger and a focused account-payment service. Persist server-generated checkout facts before returning an order; verify provider order/payment against those facts and atomically consume the order with the account update. Duplicate confirmation must not reapply an old entitlement. Reuse this verification for authenticated Razorpay capture webhooks so delayed capture can complete safely.

**Tech stack:** Existing Express, Razorpay SDK, mysql2/UUID persistence, node:test. No new dependencies.

**Spec:** `../../../../QA_DEEP_AUDIT_REPORT.md`, QA-001. The report remains the historical audit reference.

## Global constraints

- Scope: QA-001 only; no map, cash, general authentication or unrelated UI fixes.
- No live DB/gateway calls, deployment, APK changes or credential output.
- Keep four account-payment endpoint paths and existing successful response fields.
- Freeze amount/currency/plan at checkout; verification does not reprice a purchased order.
- Reject legacy orders with no durable binding; do not infer trustworthy ownership from client input.
- Registration completion must preserve approval and active-job state; replay safety necessarily overlaps QA-002's destructive success update.
- Work in the existing clean backend checkout; no worktree/branch/commit or package installation requested.

## Review focus

- Old callback after a later subscription change: return idempotent success without restoring the old plan.
- Authorized, failed, refunded or wrong-amount payment: no entitlement, including webhook handling.
- Concurrent duplicate callbacks/webhooks: one consumption and one account mutation.
- Provider outage or DB write failure: rollback/no success and allow safe retry.
- Schema/bootstrap/UUID migration compatibility: additive modeled table, no live schema changes during this task.

### Task 1: Pin the vulnerable behavior with route-level regression tests

**Files:** Create `tests/account_payment_binding.test.js` with a stateful SQL-boundary double and mocked Razorpay resources. Keep real router handlers, service logic and UUID wrapper.

**Interfaces:** Exercise the existing create/verify registration and subscription endpoints, plus signed capture webhook handling.

- [x] Run the existing backend suite as baseline; record environment failures separately.
- [x] Add tests for checkout persistence, wrong owner/purpose/plan/order/payment, amount/currency/capture/refund, malformed signature, orphan legacy order, provider/DB failures and duplicate/replay/concurrency.
- [x] Run `node --test tests/account_payment_binding.test.js`; observe assertion failures against current vulnerable handlers.

### Task 2: Bind checkout and atomically verify account payments

**Files:** Create `services/accountPaymentService.js`; add `account_payment_orders` in `models/schema/commerce.js`; add its bootstrap function in `models/bootstrap.js` and startup call in `index.js`; adapt `routes/payments.js`; update modeled-table inventory test and model documentation.

**Interfaces:** `createAccountPaymentService({pool, gateway, keySecret})` returns `createOrder({purpose, ownerId, planCode, amountPaise, currency})`, `verifyPayment({purpose, ownerId, planCode, orderId, paymentId, signature})`, and `finalizeCapturedOrder({orderId, paymentId})` for trusted signed webhooks.

- [x] Persist UUID ledger rows with owner FKs and unique provider order/payment IDs.
- [x] Validate gateway checkout response, fetch order/payment on confirmation, compare stored facts and require captured/unrefunded payment. Verify HMAC with timing-safe comparison.
- [x] Lock binding/account, apply entitlement and mark consumption in the same transaction; repeated completed order returns without account mutation.
- [x] Wire existing routes and signed capture webhook, keeping service-request billing unchanged.
- [x] Run focused tests to green; add any missing regression before changing behavior further.

### Task 3: Verify and document

- [x] Run `npm test` and `npm run build` with provider/database credentials removed; use host permission only if local sandbox restrictions block test tooling.
- [x] Get a fresh code-review subagent per requesting-code-review skill; resolve important findings and rerun affected checks.
- [x] Document additive schema rollout, unbound pending-order handling, delayed capture and live validation limits. Keep audit reports and PROJECT_CONTEXT.md unchanged.
- [x] Report changed behavior, test counts and deployment/schema limitation. No automatic deployment or commit.

## Execution evidence

- Initial baseline run could not complete in the sandbox. A broader sandbox run exposed local HTTP/WebSocket connectivity failures; those disappeared with local networking available.
- Original route regressions: 26 failed / 1 passed against the vulnerable handlers. Additional compatibility regressions failed before their changes (registration checkout field/rollback behavior and case/whitespace plan normalization).
- Final backend `npm test -- --test-reporter=tap`: 674 total, 668 passed, 6 skipped, 0 failed. Skips are existing real-database analytics cases. Account-payment regression file contains 47 passing tests.
- `npm run build`: passed syntax checks for all 245 backend JavaScript files.
- Fresh read-only reviewer found no critical/important issue. Its minor plan normalization finding was reproduced with a failing regression and fixed without consulting/repricing the current catalog.
- Additive rollout and legacy reconciliation limits documented in `docs/qa-001-payment-binding.md`; no live gateway/database or deployment action performed. Existing service billing tests pass with an empty account-ledger boundary added to their fixture.
