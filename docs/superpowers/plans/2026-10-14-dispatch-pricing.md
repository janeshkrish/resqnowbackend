# Dispatch pricing implementation plan

> **For agentic workers:** Apply the agreed in-chat design, test-driven development, and independent final review. Work is split across separate files in the existing clean `shrihari` checkouts.

**Goal:** Fix D05 and D11 by preserving technician-specific offer pricing and revealing customer pricing only after technician acceptance.

**Architecture:** Save an immutable, validated price snapshot on every dispatch offer. Acceptance copies the winning snapshot to the request in the ownership transaction. Billing uses its saved service charge and earnings, with existing disclosed fee/discount rules. Customer serializers and UI suppress request amounts before actual acceptance.

**Tech stack:** Node ESM, MySQL/TiDB SQL, React/TypeScript, node:test, Vitest.

**Spec:** User-approved flow in this chat: generic Starts from prices remain; no request-specific customer totals before acceptance; registered technician rates determine the booked service price; no customer price-confirmation step; cancellation remains available. Persisted offer amounts must survive profile rate changes and disconnect retries.

## Constraints
- Simulated testing only. Do not start the API/worker against live credentials, execute DDL, contact real payment/email/push services, or run device tests.
- Add only `dispatch_offers.pricing_snapshot JSON NULL` to the provided live schema; reuse request/payment snapshots. Ensure fresh-database schema parity.
- Preserve accepted historical jobs, capability guards, and one-active-job ownership.
- Existing fees, discounts and applicable towing tax policy remain. Apply towing tax to the technician service charge; do not reuse an unrelated platform fare.
- Do not commit, push, merge, or deploy as part of this implementation.
- Add the nullable column before deploying backend queries that read it.

## Tasks
- [x] Core pricing: write failing behavioral tests, build/validate snapshots, refuse new offers without registered rates; run tests green.
- [x] Schema and billing: prepare repeatable migration/setup; test pending payment rejection and frozen accepted billing; implement and verify.
- [x] Dispatch: test queue/fallback persisted amounts, acceptance freezing/funding, stale offer IDs, and lost-response retries; implement the common contract.
- [x] Booking/API: price direct offers before delivery, sanitize pending customer responses and lists, return saved prices from technician offer lookup; test with database doubles.
- [x] Customer UI: test before/after-accept pricing, generic starting prices and offer-ID recovery; update existing surfaces and verify.
- [x] Regression/review: run backend simulated suite and syntax build, frontend full single-worker suite and production build; independent review and fix real findings.
- [x] Handoff: record tests, changed flow, and the real-schema migration/deployment steps without applying them.

## Review focus
- Pending/assigned requests with a technician ID must still hide prices and block checkout.
- Reissued or expired offers must not change what an old Accept tap agrees to.
- Invalid/missing pricing must not silently become a platform fare or zero-priced offer.
- Acceptance response loss, concurrent offers, and customer cancellation must preserve ownership and frozen prices.
- Payment-method changes and discounts may adjust disclosed fees but never reprice technician service/earnings.

## Progress
- Planning: complete. User explicitly authorized implementation after reviewing the task list; continue without additional design approval requests.
- Workspace: both existing feature-branch checkouts were clean at start (backend c85f061, frontend b17f764). Separate-file ownership keeps concurrent edits isolated.
- Interface: snapshot v1 stores request/technician IDs, earnings, customer base/total, currency, payment mode, fees/discount, breakdown, source and timestamp; accepted snapshots additionally identify the offer. Customer API exposes pricing_status pending/confirmed and pricing_finalized boolean.
- Implementation: registered rates are required for new offers. Queue, fallback, direct booking and admin assignment share saved pricing. Acceptance requires the exact current offer ID, saves ownership and price together, and preserves successful same-owner retries.
- Legacy compatibility: unpriced pending offers are refreshed without guessing old amounts. Assigned screens fetch a priced offer and require explicit acceptance before travel. Already accepted historical jobs retain recorded ownership and prices; admin reassignment and override cannot change them.
- Independent review: fixed customer socket room scope, orphan/incorrect capture recovery, legacy accepted admin changes, assigned-offer refresh, legacy queue candidate exclusion, assigned travel/deep-link behavior, and the pre-accept towing-price API. Each finding has a simulated regression.
- Payment review: verify actual captured amount, currency, IDs and checkout funding against the saved order. Authorization alone displays processing. Incomplete, stale, missing or underfunded historical contracts require reconciliation rather than repricing or an unsupported payout.
- Final verification: all 375 backend simulated tests and all 650 frontend tests (82 files) passed. Backend syntax build checked 159 files; frontend production build passed with the existing bundle-size warning. Both repository diffs pass whitespace checks.
- Handoff: `docs/dispatch-pricing-verification-2026-10-14.md` records the flow, regression coverage and migration/deployment order. Live TiDB, Redis, payments and devices were not contacted. No migration, deployment or Git commit/push was performed.
