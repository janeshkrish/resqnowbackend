# QA-004 cash receipt workflow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution. Track steps with checkboxes.

**Goal:** Customer cash choice cannot complete a job or financial settlement before service completion and assigned-technician receipt acknowledgement.

**Architecture:** Existing workflow determines payable stages: non-towing awaiting_payment/payment_pending, towing service_completed/payment_pending. POST /cash saves a frozen server-priced cash intent on the locked request only. POST /cash/confirm uses technician auth, current assignment, intent identity/amount/currency and explicit receipt acknowledgement before entering the existing QA-003 atomic settlement. Payment evidence and operational progress are separate; towing cash settlement retains its service stage and the technician closes through the normal paid workflow.

**Tech Stack:** Existing Express/mysql2/UUID/Razorpay boundaries; React/TypeScript/Vitest. No new dependencies.

**Spec:** `../../../../QA_DEEP_AUDIT_REPORT.md`, QA-004.

## Global constraints

- Preserve all existing QA-001–003 work and historical audit/context reports; no branch, commit, deployment, live DB/gateway or APK rebuild.
- Apply payable and actor/assignment checks under the request lock; client-supplied receipt actor/price cannot override server facts.
- Add nullable service_requests.cash_payment_intent JSON with startup enforcement. Store receipt actor/time/intent/amount evidence in the completed payment pricing snapshot.
- Customer declaration does not issue a paid invoice, post a fee, release capacity, increment jobs, or mark payment paid.
- Keep completed financial replays safe, including legacy receipts; validate actor before returning private receipt IDs.
- Online settlement behavior and QA-005's general technician paid-transition bug remain outside this task unless essential to this cash path.

## Review focus

- Early stages accepted/en-route/loaded/arrived-drop cannot declare or confirm cash; completed-service stages can.
- Reassignment, changed intent, changed amount/currency or online payment selection invalidates stale receipt confirmation.
- Customer cannot confirm their own cash receipt; another technician cannot acknowledge or replay another technician's receipt.
- Duplicate/concurrent receipt confirmations, capture and status changes still yield one settlement with no premature progress.
- Frontend customer displays pending receipt, technician sees exact server amount and errors never produce local paid state.

### Task 1: Server receipt boundary

**Files:** Add services/cashReceiptPolicy.js; modify routes/payments.js, models/schema/requests.js, models/bootstrap.js; extend tests/cash_settlement.test.js and schema/migration coverage.

**Interfaces:** Cash choice {requestId,couponCode?} -> {success,pendingReceipt,cash_intent,request}. Technician receipt {requestId,intentId,received:true,amountPaise,currency} -> existing settled IDs/request response. Cash policy helpers validate stage, frozen intent and receipt actor.

- [x] Add real-handler negative stage/customer-only/mismatched-actor/stale-intent tests; watch the old endpoint settle too early.
- [x] Implement nullable required JSON intent schema; test startup denial and UUID JSON mapping.
- [x] Split customer choice from financial confirmation, preserving QA-003's shared settlement guards and transactional side effects.
- [x] Record authoritative receipt evidence; update prior QA-003 tests to exercise the technician-confirmed settlement and retain competing-writer coverage.

### Task 2: Usable customer/technician flow

**Files:** Frontend components/RequestTracking.tsx, components/payments/PaymentSummaryDialog.tsx, pages/technician/ActiveJob.tsx; add focused CashReceiptConfirmation component and tests, update demo payment behavior.

- [x] Add failing UI tests for pending customer cash choice and technician receipt action/failed receipt handling.
- [x] Wire exact amount/intent acknowledgement through technician auth; refresh server state after success or stale-state errors.
- [x] Preserve existing payment/job flows; update demo to avoid customer-only job completion.

### Task 3: Verify and document

- [x] Run backend/full frontend suites, backend build, frontend typecheck/build with external credentials removed. Use host access only for local test infrastructure if needed.
- [x] Request fresh read-only review per requesting-code-review skill and resolve important findings.
- [x] Document compatibility: older customer /cash calls now select cash; technician receipt support plus additive schema must deploy together; no automatic historical state repair.
- [x] Report local results and staging concurrency limits without claiming live rollout.

## Execution evidence and rulings

- Existing audit/workflow defined the payable stages; no separate configurable stage field existed. Ruling: reuse the established status policy in code and require the assigned technician's explicit receipt after customer cash choice, rather than invent a new administrator setting.
- Original customer route failed the early-stage and declaration-only regressions. New confirmation/auth/schema tests failed before their endpoint/intent contracts existed. Prior QA-003 accounting/race tests now use both real authenticated participants.
- Fresh review found a currency mismatch between current platform configuration and accepted INR contract; a real handler regression reproduced it (200 instead of409). Cash intent now checks accepted currency (historical fallback INR), and a saved agreed intent survives later config changes.
- Corrected declaration return/commit ordering after delayed/rejected-commit regressions showed early release and escaped failure; both paths now await commit and route failure through rollback/HTTP500.
- Customer UI and technician acknowledgement integration tests failed before their behavior changes, then passed. Demo's premature choice/completion behavior also failed three regressions before correction. The contradictory customer-waiting copy was removed after a failing integration assertion.
- Final backend npm test: 752 total, 746 passed, 6 existing live-database analytics tests skipped, 0 failed. External payment/database credentials removed. Backend build: all250 JavaScript files passed syntax checks.
- Final frontend npm test -- --maxWorkers=2 --reporter=dot: all107 files and844 tests passed. The initial unrestricted full run overlapped builds/typecheck and hit widespread five-second resource timeouts; the complete bounded run resolved them without skipping tests or changing timeouts. Vitest required host temp-file access after sandbox EPERM.
- Final frontend typecheck and production build passed. Build retains the existing >500kB chunk warning.
- Fresh read-only review and follow-ups found no remaining critical/important blocker, including independent currency and commit regression reruns. Local SQL doubles cannot establish live database isolation.
- No deployment, live migration/gateway/refund, APK rebuild, historical repair or audit/context rewrite. Earlier QA-001–003 changes preserved.
