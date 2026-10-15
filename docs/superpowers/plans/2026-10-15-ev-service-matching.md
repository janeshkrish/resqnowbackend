# EV service matching implementation plan

**Goal:** Implement the service-based EV matching design approved in this chat, including consistent EV names, compatible shared providers and registered-rate pricing.

**Architecture:** Keep the EV family and electric subtype on the request. A common service policy derives compatible physical vehicle classes without changing the request identity. Discovery, dispatch, booking/acceptance guards and registered pricing consume this policy. Existing JSON stores request scope and charging compatibility.

**Spec:** Approved in-chat design: shared puncture/lockout/towing providers can serve compatible EVs; towing still needs the required truck; specialist/uncertain electrical faults and battery support require EV support; pure EV fuel delivery is invalid; charging needs compatible equipment. Retain frozen offers, customer price hiding and one-active-job ownership.

## Constraints and rulings
- Simulated tests only; no live database, Redis, gateways, maps, notifications or device tests. No schema changes, migration execution, commits, pushes or deployments.
- Work in the existing clean `shrihari` checkouts, matching the user's established branch workflow. Both start clean. No new worktree is needed.
- Battery assistance stays with EV battery providers because low-voltage procedures are model-specific. The form distinguishes auxiliary, traction and unknown problems; no ordinary jump-start instruction is applied to a drive battery.
- Mechanical sharing is allowed only for explicit chassis work without conflicting electrical/unknown symptoms. Missing/unknown scope stays EV-specific.
- Shared services are flat-tire, lockout and towing. Winching/other remain EV-specific because their recovery/electrical hazards have not been specified.
- EV subtype maps to a compatible physical family. Unknown subtype cannot open unrelated car/bike pools. Pricing never guesses a missing body/tyre tier or substitutes a platform price.
- Prefer a provider's applicable EV price; use a compatible registered physical-class price only for an allowed shared service. Invalid explicit EV pricing does not silently fall back. The offer stores the actual pricing source/class and stays immutable after delivery.
- Charging connector keys: ccs2, type2, home, brand. Known connector support must be declared per registered charging price; proprietary connectors also require the vehicle brand. Missing/unknown customer connector is rejected with a helpful code, rather than assuming compatibility.
- Frontend interface: details.answers uses mechanical_scope = chassis / ev-system / unknown; battery_scope = auxiliary / traction / unknown; port = ccs2 / type2 / home / brand. Charging pricing JSON uses supported_connectors and supported_ev_brands (CSV strings or arrays on read).
- Known EV body tiers travel in details.vehicle_base_subtype without changing the electric subtype. Manual body choices must agree with that electric subtype; missing body data never selects a guessed tier.
- Known pure EVs use the EV request form. Ordinary catalogs/garages exclude known pure EVs; restored ordinary drafts containing a known EV are blocked and guided to EV services. Existing hybrid catalog treatment is unchanged.

## Tasks
- [x] Reproduce aliases and service-based eligibility with failing tests. Add shared policy in `services/vehicleServiceCompatibility.js`; correct `services/serviceNormalization.js`; integrate with `services/jobDispatchService.js`.
- [x] Test compatible registered rates, subtype restrictions, missing pricing and connector support. Update `services/technicianEarningsService.js`, offer creation and ownership gates to enforce the same rules on every assignment path.
- [x] Test request creation and public discovery. Reject invalid EV/fuel/charging combinations early, retain vehicle identity and use service-aware discovery/display rates.
- [x] Frontend: simulated regressions for EV-only scope questions, charging connector registration/persistence, EV normalization and unknown-connector handling. Preserve current non-EV flows and pricing visibility.
- [x] Run all simulated backend/frontend tests and both builds, obtain independent review, fix important findings with regressions, document final flow and any provider setup requirements.

## Review focus
- Electric scooter never becomes an ordinary bike in storage; physical matching is deliberate and service-specific.
- EV car cannot match a bike-only provider. Unknown EV subtype cannot silently become a car.
- Unknown/HV fault cannot inherit ordinary mechanical or battery support.
- Shared eligibility and pricing must agree on the same registered service/class/subtype; towing fleet checks still run.
- Old accepted agreements and missing response recovery remain unchanged; no schema migration is needed.

## Progress
- Baselines: backend 400/400 simulated tests; frontend 672/672 tests across 84 files.
- Completed shared policy, assignment/offer guards, connector filtering before ETA ranking, registered rate selection and customer discovery.
- Completed frontend scope/connector questions, per-subtype charging registration, EV body preservation, manual brand entry, ordinary-route EV draft guards and stable estimate input keys.
- Independent read-only review completed. Corrected reported signup validation, towing subtype rates, incomplete/malformed legacy pricing, manual brand, ordinary-route EV bypass and estimate key issues with regression evidence. No remaining Critical or Important findings.
- Final verification: backend 490/490 simulated tests; frontend 736/736 tests across 89 files; backend build syntax-checks 170 files; frontend production/PWA build passes; both git diff --check commands pass.
- No live services, schema changes, commits, pushes, merges or deployments. Detailed handoff: docs/ev-service-matching-verification-2026-10-15.md.
