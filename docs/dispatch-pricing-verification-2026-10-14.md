# D05 and revised D11: implementation and verification

Verified on 14 October 2026 in the backend and frontend `shrihari` checkouts.

## Outcome

D05 and the user-approved D11 behavior are implemented. Each technician offer has a saved price calculated from that technician's registered rates. Acceptance saves that exact offer's ownership and pricing together. Customer request prices appear only after actual technician acceptance.

The code and migration are prepared locally. No live database migration, deployment, Git commit or push was performed.

## Customer and technician flow

1. Generic **Starts from** prices remain on service selection pages.
2. The customer requests a service. Pending and assigned requests show searching/assignment information and towing route details, with no request-specific service price, fees or total. Checkout is blocked until acceptance.
3. Dispatch calculates the candidate technician's earning using registered service rates, including the required towing truck type. Missing or invalid registered rates prevent a new priced offer.
4. The server saves the price on `dispatch_offers` before delivering the offer. Queue, fallback, direct booking, admin assignment, lists and notifications use those saved earnings.
5. The technician explicitly accepts the current identified offer. The existing ownership transaction checks availability, active jobs, equipment, expiry and offer ID, then saves ownership and the agreed price together. Assigned technicians must accept before starting travel or work.
6. The customer sees the accepted service charge and applicable taxes/fees. There is no extra price-confirmation step. The existing cancellation rule allows cancellation before the technician sets off.
7. Payment uses the recorded service price and earning. Payment mode or an eligible discount can adjust disclosed payment/platform fees; changing a technician profile cannot change this job's service charge or earning.

For example, if an offer promises the technician INR 1,200, acceptance records that INR 1,200 earning. The customer charge funds it and separately includes applicable tax and fees. Increasing the technician's profile rate later cannot change this job to INR 1,500.

## Disconnects, stale offers and historical jobs

- A lost acceptance response is recovered by checking the server's ownership. If acceptance committed, retries return the already accepted job with its saved price. A tap or loading screen alone does not claim ownership.
- First acceptance requires the current offer ID. An expired, replaced, unpriced or invalid offer cannot silently accept a newly calculated amount.
- Old links without an offer ID open the current offer for review. Explicit stale IDs remain stale; opening a link does not automatically accept a replacement price.
- Unpriced legacy pending/assigned offers can refresh into new identified, priced offers. Previous offer snapshots are not overwritten or backfilled with guessed rates.
- Already accepted historical jobs retain their recorded prices and ownership. Admin assignment and price override cannot replace an accepted agreement.
- A historical customer price that cannot fund the recorded technician earning blocks new checkout and requires support reconciliation. It is not silently increased or paid out at a loss.
- Missing, stale or incomplete checkout agreements cannot be reconstructed from current request/profile prices. Gateway verification checks the actual amount, currency, order/payment IDs, customer/request binding and funding against the saved checkout. Authorization alone shows payment processing; captured payment finalizes it.
- Technician wallet credits and earnings views use recorded technician earnings, excluding customer taxes and fees.

## Schema and rollout

The supplied live schema needs one new nullable column:

```sql
ALTER TABLE dispatch_offers
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSON DEFAULT NULL;
```

The repeatable script is `scripts/migrations/20261014_dispatch_offer_pricing.sql`. Its second guarded statement ensures `service_requests.pricing_snapshot` for older databases; that field already exists in the supplied live schema. Existing request and payment snapshots are reused. No new tables or payment columns are required for these fixes.

Rollout order:

1. Pause dispatch workers while updating the dispatch contract.
2. Apply the prepared migration to the intended TiDB database and verify that `dispatch_offers.pricing_snapshot` exists. This was not executed during implementation.
3. Deploy the updated backend and dispatch worker, then the matching frontend/app before resuming dispatch. Old clients need the updated offer-ID acceptance flow.
4. Resume dispatch. Old unpriced pending offers refresh; accepted jobs retain recorded agreements. Existing orphaned or underfunded payments need reconciliation rather than guessed backfills.

Backend schema setup also ensures the snapshot columns and fails if they remain missing. Starting the API or worker with live credentials can therefore apply schema setup; neither was started against live services for verification.

## Final verification

| Check | Result |
| --- | --- |
| Backend simulated suite | **375/375 passed**, zero failed/skipped |
| Frontend simulated suite | **650/650 passed**, 82 test files, zero failed |
| Backend build | **Passed**, 159 files checked for JavaScript syntax |
| Frontend production build | **Passed**; existing warning about chunks exceeding 500 kB |
| Backend and frontend `git diff --check` | **Passed** |

Commands, run in their respective repositories:

```powershell
# Backend: explicit patterns exclude the live email smoke script.
node --test --test-reporter=tap tests/*.test.js services/*.test.js
npm run build

# Frontend
npm test -- --pool=threads --maxWorkers=1 --testTimeout=15000
npm run build
```

Coverage includes registered towing/non-towing pricing, quote arithmetic, rate changes after offer delivery, queue/fallback consistency, exact/stale/missing offer IDs, assigned acceptance, lost-response recovery, cancellation, one-active-job ownership, tow-truck capability, customer API/UI price suppression, technician earnings/history, admin protection, wallet credits, signed captured-payment mismatch/recovery, and processing-to-paid UI transitions.

Independent review findings were corrected with simulated regressions: customer socket room scope, payment recovery without a saved checkout, accepted legacy admin changes, assigned-offer refresh, legacy queue candidate exclusion, assigned travel/deep-link handling, and towing estimate prices exposed before acceptance.

Database, Redis, gateway and external notification/email boundaries were mocked. Socket tests used only a local test server. Real TiDB DDL/locking, live payment/device behavior and real internet disconnections were not tested, as requested. Existing fee and tax policy was retained; these changes do not redesign tax remittance or cash settlement policy.

## Backend merge verification

Resolved the merge of `shrihari` (`493d1c5`) into local `main` (`99b6618`). The three conflicts combined saved dispatch pricing with the new main-branch behavior: admin notifications stay restricted to admins, payment history recording remains, and request creation keeps both history recording and the direct priced offer. The assignment regression also verifies admin-only delivery alongside customer price hiding.

The resulting backend passed **400/400 simulated tests**, including the new admin-monitor and phone-login tests. The build passed syntax checks for **165 files**. Conflict markers and unmerged index entries were removed, and the staged diff passed `git diff --cached --check`. No live database or services were contacted. The merge resolutions were staged; the final merge commit and push remain for the user.
