# Technician payment-state protection implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with test-driven-development and a fresh final code review.

**Goal:** Prevent technician job-status changes from establishing payment or releasing unpaid jobs.

**Architecture:** Non-towing financial completion belongs to payment settlement routes. Towing closure remains an operational action, gated by a paid request and a single matching completed settlement read after the assigned request is locked. Keep frontend-only demo behavior consistent; existing payment and cash receipt UI needs no new action.

**Tech Stack:** Node.js, Express, MySQL, node:test, TypeScript, Vitest.

**Spec:** `../../../../QA_DEEP_AUDIT_REPORT.md`, QA-005; existing QA-003 settlement and QA-004 receipt contracts.

## Global constraints

- Preserve QA-001 through QA-004 and all existing uncommitted work.
- No deployment, live database writes, historical repair, schema addition, or commits in this task.
- Work completion must continue to mean awaiting payment for non-towing and service completed for towing.

## Review focus

- Financial status aliases and identical-status retries must not bypass checks.
- Paid flags without settlement, wrong participants, and ambiguous/regressed settlements must fail closed.
- Assignment and payment state must come from the same transaction's locked current request.
- Failed attempts must preserve status, counters, payments, and technician reservation.
- Verified towing closure must still work; generic status changes must not create or update payment evidence.

## Task 1: Protect technician financial transitions and preserve demo parity

**Files:** `services/requestStatusWorkflow.js`, `routes/service_requests.js`, new `tests/technician_payment_state.test.js`, frontend `src/lib/api.ts` and `src/lib/cashReceipt.demo.test.ts`, new `docs/qa-005-technician-payment-state.md`.

**Interfaces:** Reuse `findCompletedServiceSettlement(conn, requestId)` after request lock. `validateTechnicianStatusTransition` continues returning `{ok, reason?, idempotent?}`; non-towing `paid` requires settlement endpoint instead, non-towing terminal completion and towing closure require paid payment status before idempotence. Route rejects missing/inconsistent completed settlement with HTTP 409 and machine-readable code.

- [x] Write policy and route regression tests covering the review focus; run them to demonstrate the current bypass.
- [x] Block non-towing paid status writes; gate terminal retries and towing closure, with current settlement evidence and request/payment participant consistency; map settlement conflicts to HTTP 409.
- [x] Add demo regression tests, observe failures, remove technician-status payment fabrication and gate closure there.
- [x] Run backend full tests/build, frontend full tests/typecheck/build; inspect diffs and obtain fresh review.
- [x] Record behavior, rollout limits, test evidence, and review findings in QA-005 documentation.

## Execution evidence

Pre-flight: One implementation task, no cross-task interfaces. Working inline because the current workspace contains the earlier dependent QA fixes; no separate checkout or commit will discard or omit them.

- Backend RED: 18 of the initial 29 tests failed on the demonstrated bypasses. Subsequent non-towing closed-retry probe failed 2 tests, then passed after denying this unsupported status before idempotence. Final focused file: 33/33 pass, including verified read-only closure retry and unambiguous legacy payment compatibility.
- Frontend RED: 6 of 11 demo tests failed (HTTP 200 instead of expected 409). GREEN: 11/11 pass. Initial sandbox run could not execute due to temporary-file rename EPERM; host test execution succeeded.
- Backend full suite: 785 total, 779 passed, 6 existing live-database analytics cases skipped, zero failed. Backend build: 251 JavaScript files passed syntax checks.
- Frontend typecheck initially identified unknown JSON receipt properties; narrowed objects explicitly and reran successfully.
- Frontend full suite: 107 files, 852/852 tests passed with two workers. Production build passed (7.90 seconds); existing chunk-size warning remains. Typecheck passed. Both repositories' diff whitespace checks passed after preserving existing mixed line endings on unchanged lines.
- Fresh read-only review by review_qa005 independently ran 33/33 backend tests. No Critical or Important findings.
- Final: minor (deferred): Frontend-only demo stores non-towing job_closed/job-closed aliases as raw labels instead of rejecting them. It does not establish payment. Production normalizes and rejects these aliases.
- Final: Ruling: Prior QA-001–004 implementation review is outside this focused review; preserve those changes and run the combined regression suites. Cost if wrong: a previous defect beyond suite coverage remains.
- Final: Ruling: Real MySQL isolation and live gateway behavior remain staging validation, not claims made by stateful SQL doubles. Cost if wrong: deployment-specific concurrency or integration issues need staging detection.
- Final: Ruling: No automatic historical payment/availability repair; ambiguous records fail closed pending explicit reconciliation. Cost: affected historical jobs may remain blocked until reconciled.
- Final: Ruling: Broader frontend-only demo authentication/state-machine redesign is outside QA-005. Cost: the simulator cannot establish production security or full workflow parity.

### Manual-test preparation correction (2026-11-01)

The first review and fixtures incorrectly assumed `payments.technician_id` existed. Actual schema and settlement INSERTs store technician ownership on invoices. Removing that invented field made legitimate positive closure cases fail. Corrected the route to lock the matching invoice after payment, verify its real customer/technician fields, and require exact online payment/order references; cash follows the existing `cash_` invoice convention. Added missing/ambiguous/mismatched invoice tests and real-shaped cash/online positive fixtures. Focused 38/38 and full backend 784 passed/6 existing live-DB skips/0 failed; build251 syntax pass. Fresh reviewer checked schema and insert paths and independently ran38/38 with no blocker. Previous SQL-double validation never proved this real-schema compatibility; user acceptance is still outstanding.
