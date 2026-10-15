# D17b: EV service matching verification

Completed locally on 15 October 2026 in the backend and frontend `shrihari` checkouts. No commit, push, merge, deployment, live service test or database change was performed.

## Result and current flow

Electric vehicle labels now keep their EV identity. A request can use a compatible ordinary provider for a shared service without storing the vehicle as petrol/diesel or silently treating an electric car as a bike.

| Customer request | Eligible provider rule |
| --- | --- |
| EV puncture, lockout or towing | An EV provider or a provider serving the matching physical bike/car class, with an applicable registered price. Towing still requires the correct available truck. |
| EV mechanical: explicitly wheels, brakes or suspension | Compatible ordinary mechanics may participate. Conflicting electrical symptoms remove this sharing permission. |
| EV mechanical: electrical fault, uncertain or missing scope | EV support is required. |
| EV battery: auxiliary, traction or uncertain | EV battery support is required. The form distinguishes these scopes and does not present ordinary jump-start instructions for the traction battery. |
| Pure EV fuel request | Rejected; use charging or towing. |
| Non-EV charging request | Rejected. |
| EV charging | The selected vehicle subtype must have declared support for the customer's connector. A proprietary connector also needs matching declared brand support. |

Charging connector keys are `ccs2`, `type2`, `home` and `brand`. An unknown connector does not create an offer; the form guides the customer to identify it or arrange towing. Capability checks run before the ETA shortlist, during offer creation and before a new reservation/acceptance.

Known EV catalog and garage entries use the EV request path. Ordinary forms guide electric vehicles to EV services and prevent restored drafts for known EVs from submitting ordinary battery/mechanical requests. Manual EV models can supply their brand. Hybrid/PHEV classification beyond the existing catalog was outside this task.

## Pricing and ownership

- The technician's applicable EV registered rate takes priority. A compatible ordinary rate is available only for an allowed shared service.
- Known body tiers, such as hatchback or sedan, accompany the electric subtype in `details.vehicle_base_subtype`. Catalog/garage selections retain this information; manual choices must agree with the electric subtype. Missing information does not select a guessed body tier.
- Missing, incomplete, negative or malformed applicable rates cannot become another subtype's parent minimum or an ordinary fallback price. Legacy JSON pricing remains supported with these guards.
- Towing uses the selected subtype's tariff and the required truck's registered fleet rate when present.
- The selected offer's saved pricing continues through acceptance and payment. Customer-specific pricing stays hidden until acceptance; general Starts from labels remain. Customers can cancel after the accepted price appears.
- Existing one-active-job, offer ID, acceptance retry/recovery and continuing accepted ownership behavior is retained. A previously accepted agreement is not abandoned because a provider later changes its profile.

## Database and provider setup

No new table, column, index or migration is needed. This change reuses:

- `service_requests.request_details_json` for scope, connector and physical body details.
- Technician `service_costs`, `technician_services.metadata` and `technician_service_pricing.pricing_json` for registered rates and charging capabilities.
- Existing request, offer and payment pricing snapshots for the accepted agreement.

Charging registration now saves `supported_connectors` and `supported_ev_brands` per subtype. Existing charging providers with missing declarations must have their actual equipment information entered through a supported pricing administration/registration flow before matching these jobs. The software does not assume support or invent capability data for them. No live profiles were edited during this task.

## Verification

| Check | Final result |
| --- | --- |
| Backend simulated suite | 490 passed; 0 failed, skipped or cancelled |
| Frontend simulated suite | 736 passed across 89 files; 0 failed |
| Backend build | 170 JavaScript files passed syntax checks |
| Frontend production build | Vite and PWA generation passed |
| Whitespace checks | `git diff --check` passed in both repositories |
| Independent review | All reported material issues corrected; no remaining Critical or Important findings |

Commands run from their respective repository roots:

```powershell
# Backend: explicit patterns exclude standalone live smoke scripts.
node --test --test-reporter=tap tests/*.test.js services/*.test.js
npm run build

# Frontend
npm test -- --pool=threads --maxWorkers=1 --testTimeout=15000
npm run build
```

Regression coverage includes EV aliases, shared physical class rules, unknown scopes, incompatible tow trucks, connector/brand filtering before ranking, public/admin registration persistence, direct reservation guards, legacy/missing subtype prices, immutable offers, waiting-price visibility, ordinary EV draft rejection and towing estimate key changes. New defects were reproduced with failing tests before their fixes.

Tests used mocked database/Redis/gateway/maps/email boundaries; socket tests used localhost only. No real TiDB concurrency, device disconnect or live integration test was run. The frontend build still emits its existing chunk-size advisory, and some UI tests emit existing React Router/act advisories; these did not fail the checks.
