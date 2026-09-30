# ResQNow Project Context

Canonical architecture context for developers and AI assistants. Repository evidence was reviewed on 2026-09-30 at commit `c241cf5` on branch `suthan`. This file records the system as found; it does not describe unimplemented changes.

Evidence labels used below:

- **Confirmed** - directly supported by files in this repository.
- **Inferred** - strongly suggested, but not provable from this repository alone.
- **Unknown** - requires another repository, a deployed environment, or team confirmation.
- **Recommendation** - future work, not current behavior.

## 1. Project Overview

ResQNow is a roadside-assistance marketplace connecting customers to technicians/service providers. The backend supports customer and technician identity, service requests, dispatch, towing workflows, live location, notifications, payments, invoices, marketplace ledgers, ratings, vehicle profiles, public location and station lookup, and extensive administration.

**Confirmed:** this repository is the Node.js backend. It also contains a distributable Android APK, but no frontend or mobile application source. The README identifies a separate `resqnowfrontend` repository. Evidence: `README.md`, `package.json`, `index.js`, `public/downloads/resqnow.apk`.

## 2. Repository Structure

| Path | Responsibility |
|---|---|
| `index.js` | Express/HTTP bootstrap, middleware, route mounting, Socket.IO, workers, readiness and shutdown |
| `db.js` | MySQL pool plus most runtime schema creation, schema widening, seed and bootstrap functions |
| `config/` | Environment validation and network/CORS policy |
| `routes/` | HTTP API handlers grouped by domain |
| `controllers/` | Primarily admin and technician controller logic |
| `services/` | Dispatch, pricing, tracking, notifications, payment ledger, maps, fuel/EV data, invoices and operational services |
| `middleware/` | JWT role checks and extended-admin authorization/auditing |
| `models/` | A few constants/data helpers; not an ORM model layer |
| `repositories/` | Marketplace persistence helper; most SQL remains in routes/services |
| `workers/` | Standalone BullMQ dispatch worker entry point |
| `scripts/` | Syntax build check, email smoke test and SQL migrations |
| `tests/` and `services/*.test.js` | Native Node test suites |
| `public/downloads/` | Tracked Android APK distributed by public API |
| `Dockerfile` | Container image definition |
| `schema.sql` | Partial/stale schema sample; not the complete schema authority |

There is no frontend source, native Android/iOS project, Docker Compose, Kubernetes, Terraform, Nginx, process-manager config, or checked-in CI workflow.

## 3. Technology Stack

| Area | Status | Technology/evidence |
|---|---|---|
| Runtime | **Confirmed** | JavaScript ES modules on Node.js; `package.json` has `type: module`; README says Node 18+, Docker uses `node:18-alpine` |
| HTTP API | **Confirmed** | Express 4 REST API, JSON and URL-encoded bodies |
| Realtime | **Confirmed** | Socket.IO 4 with `@socket.io/redis-adapter`; authenticated rooms/events |
| Jobs/cache | **Confirmed** | BullMQ 5 and ioredis; Redis is also used for Socket.IO fan-out and live-location state |
| Database | **Confirmed** | MySQL-compatible database through `mysql2`; defaults and comments support TiDB Cloud use |
| Authentication | **Confirmed** | JWT, bcryptjs, Google OAuth 2.0 |
| Payments | **Confirmed** | Razorpay, cash settlement, internal wallet/payout/refund ledgers |
| Notifications | **Confirmed** | Firebase Cloud Messaging, Socket.IO, Resend email, admin SSE |
| Documents | **Confirmed** | PDFKit invoice generation; database-backed uploads |
| Maps/data | **Confirmed** | OSRM, Nominatim/Photon/Pelias, Mappls, Overpass, IndianAPI fuel data, Wikimedia vehicle photos |
| Tests | **Confirmed** | Built-in `node:test` and `assert`; no external test framework |
| Client web | **Inferred** | README names a separate React/Vite frontend; not verifiable here |
| Client mobile | **Inferred** | Capacitor integration is suggested by a dev dependency, CORS origin and OAuth deep link; no client project/config is present |
| GraphQL/ORM | **Not found** | REST plus Socket.IO; handwritten parameterized SQL, no ORM |
| PWA/update client | **Not found** | No service worker, web manifest, update client, release manifest or client version negotiation in this repository |

Pinned requested ranges are in `package.json`; exact resolutions are in `package-lock.json` (lockfile version 3).

## 4. System Architecture

```text
Separate Web / Capacitor Client (not in repository)
             | HTTPS REST + JWT
             | Socket.IO + JWT
             v
       Express HTTP Server (`index.js`)
         |       |       |       |
         |       |       |       +--> External APIs
         |       |       |            Razorpay, Google, FCM,
         |       |       |            Resend, maps/data providers
         |       |       +----------> BullMQ dispatch queue
         |       +------------------> Redis
         |                            queue, Socket.IO adapter,
         |                            live tracking/cache
         +--------------------------> MySQL/TiDB-compatible DB
                                      domain state, files, invoices,
                                      ledgers, audit and history
```

The application is a modular monolith: one Express process owns most HTTP/business logic and can also embed the dispatch worker. A standalone worker can be launched with `npm run worker:dispatch`. Redis coordinates background dispatch, multi-instance Socket.IO, and live-location state. MySQL is the durable system of record.

## 5. Application Components

- **Customer component:** registration/login, profiles, vehicles, service requests, payment, invoices and reviews. Evidence: `routes/users.js`, `routes/auth.js`, `routes/vehicles.js`, `routes/service_requests.js`, `routes/payments.js`.
- **Technician/provider component:** onboarding, registration payment, admin approval, availability, fleet/team data, job state, location, earnings, wallet and withdrawals. Evidence: `routes/technicians.js`, `controllers/technicianController.js`, marketplace services.
- **Dispatch component:** candidate eligibility, ETA ranking, sequential offers, timeouts/retries and atomic claim. Evidence: `services/jobDispatchService.js`, `services/jobMatcher.js`, `services/dispatchQueueService.js`, `workers/dispatchWorker.js`.
- **Tracking component:** authenticated ingestion, validation, Redis current state, sampled SQL history, Socket.IO publication and route/traffic metrics. Evidence: `services/liveTracking*.js`, `services/socket.js`.
- **Commerce component:** server pricing, Razorpay/cash settlement, invoices, technician wallet, dues, payouts, withdrawals and refunds. Evidence: `routes/payments.js`, `services/platformPricing.js`, `services/marketplace*.js`, `services/invoiceService.js`.
- **Operations/admin component:** service/pricing setup, approvals, request overrides, complaints, finance, analytics, broadcasts, command center and audit logging. Evidence: `routes/admin*.js`, `controllers/admin*.js`, `services/operationsCommandCenterService.js`.

## 6. Frontend Architecture

**Confirmed:** no frontend application exists in this repository. The backend exposes REST, Socket.IO, an OAuth redirect, static `/uploads`, and an APK download endpoint. `README.md` points to a separate `resqnowfrontend` React/Vite project.

**Unknown:** frontend versions, state management, JWT storage, API client, route guards, service worker/caching, web hosting and release strategy. Any client-side statement beyond the backend contracts must be verified in that repository.

## 7. Mobile Architecture

**Confirmed:** the backend accepts `capacitor://localhost`, uses the deep link `resqnow://auth/callback`, includes `@capacitor/assets` as a development dependency, and serves `public/downloads/resqnow.apk` via `/api/public/android-app/*`.

**Inferred:** the separate web frontend is wrapped by Capacitor for Android. The repository does not contain `capacitor.config.*`, `android/`, `ios/`, Gradle, Xcode or signing configuration, so framework/version, package ID and release channel cannot be confirmed.

## 8. Backend Architecture

`index.js` creates the Express app and HTTP server, applies CORS and parsers, mounts the Razorpay raw-body webhook before JSON parsing, mounts route modules, configures Socket.IO, bootstraps schema/services, starts the embedded dispatch worker and monitoring, then handles shutdown.

Important behaviors:

- The listener starts before environment validation/database bootstrap completes. `/health` can be healthy while `/ready` is `503`.
- `getLiveTrackingRuntime()` is initialized unconditionally and requires `REDIS_URL`, making Redis effectively required even outside production.
- API aliases exist for backward compatibility, including `/api/service-requests` plus `/api/requests` and `/api/technicians` plus `/api/technician`.
- Business logic is split among route handlers, controllers and services. There is no universal validation/schema layer.
- Errors are mostly caught at route level, with final invalid-JSON and generic-500 middleware.

Evidence: `index.js`, `config/envValidation.js`, `services/liveTrackingRuntime.js`.

## 9. Database Architecture

`mysql2` provides a lazy singleton pool with `connectionLimit: 100`, unlimited queueing, a connectivity probe, and optional TLS controlled by `DB_SSL` and `DB_SSL_STRICT`. Production-like environments reject localhost configuration. Evidence: `db.js`.

`db.js` is the effective schema bootstrap authority: it creates many tables, adds columns/indexes, widens fields, seeds data, backfills wallets and reconciles technician availability on startup. SQL migrations also exist under `scripts/migrations/`, but no migration-version ledger or runner is present. `schema.sql` only describes a small subset and must not be treated as complete.

Operational consequence: application startup mutates schema. Concurrent deploys can race, a code rollback may not match the changed schema, and deploy permissions must include DDL.

## 10. Important Data Models

| Entity/table family | Purpose and relationships | Primary writers/readers |
|---|---|---|
| `users` | Customer identity, profile and subscription; parent of vehicles, requests, tokens and payments | user/auth/payment routes |
| `technicians` | Provider identity, approval, capabilities, pricing, PII, availability and current job | technician/admin/dispatch/payment modules |
| `user_vehicles` | Customer vehicle profiles | `routes/vehicles.js` |
| `service_requests` | Central job aggregate: customer, optional technician, service/vehicle, addresses, price, status and payment state | service-request, dispatch, tracking, payment, admin modules |
| `request_timeline`, `request_attachments` | Request history and attached evidence | request/admin details services |
| `dispatch_offers` | Per-technician offer state and expiry | dispatch services/worker |
| `technician_location_history` | Sampled durable technician/request location points | live tracking ingestion |
| `payments`, `invoices` | Gateway/cash records, pricing snapshot and invoice binary/metadata | payment and invoice services |
| wallet/ledger tables | `technician_wallets`, `wallet_transactions`, `payouts`, `payout_allocations`, `withdrawal_requests`, `payment_refunds`, `technician_dues` | marketplace services/admin finance |
| `reviews` | Customer rating associated with service/technician | user routes |
| `device_tokens`, `notifications` | Push endpoints and admin/customer notification records | notification modules |
| `otp_requests`, `otp_rate_limits` | Hashed OTP challenges and email throttling | `routes/users.js` |
| `files` | Uploaded blobs, MIME, filename and size | `routes/upload.js` |
| pricing/catalog tables | Service, category, subcategory, vehicle mapping, pricing fields, towing fleet and technician pricing | admin and pricing services |
| operational/audit tables | admin actions, notes, complaints, complaint updates, audit logs, monitoring alerts, login/activity sessions | admin/monitoring services |

```text
users 1 --- * user_vehicles
users 1 --- * service_requests * --- 0..1 technicians
service_requests 1 --- * dispatch_offers * --- 1 technicians
service_requests 1 --- * technician_location_history
service_requests 1 --- * payments 1 --- 0..1 invoices
technicians 1 --- 1 wallet --- * wallet_transactions
payments/requests --- payout_allocations --- payouts/withdrawals
```

Foreign-key completeness and production retention rules require database inspection; the table-creation SQL is spread across runtime bootstrap and migration files.

## 11. API Architecture

All routes are REST except Socket.IO events and admin SSE. Main domains:

| Domain | Important routes | Auth | Main modules/entities |
|---|---|---|---|
| Identity | `POST /api/users/send-otp`, `/verify-otp`, `/login`; `GET /api/auth/google/url`, `/google/callback`, `/verify`, `/me` | Mixed public/user | `routes/users.js`, `routes/auth.js`; users/OTP |
| Vehicles | CRUD under `/api/vehicles` | User | `routes/vehicles.js`; user vehicles |
| Requests | `GET/POST /api/service-requests`, `GET /:id`, `POST /:id/accept`, technician/user status routes, cancel, invoice | User/technician by route | `routes/service_requests.js`; requests/timeline/offers |
| Technicians | register/login/profile, approval, availability/location, active jobs/history, fleet/team, pricing, wallet | Mixed technician/admin/public | `routes/technicians.js`, controllers |
| Dispatch | `POST /api/jobs/:requestId/accept` and queue/worker operations | Technician/admin | `routes/jobs.js`, dispatch services |
| Pricing | calculate/towing estimates, service price endpoints | Mixed | `routes/pricing.js`, pricing services |
| Payments | registration order/verify, config, quote, create order, confirm, cash, subscription, webhook | Mixed; webhook signature | `routes/payments.js`; payment/ledger/invoice tables |
| Location/public data | search, reverse geocode, routes, fuel prices/stations, EV stations, vehicle photo | Public with selective limiters | `routes/public.js`; provider services |
| Upload | `POST /api/upload`, `GET /api/upload/files/:filename` | Public | `routes/upload.js`; files |
| Notifications | device-token register/unregister | Authenticated identity | `routes/notifications.js`; device tokens |
| Admin | `/api/admin`, `/api/admin-extended/*`, `/api/admin/command-center` | Admin JWT/optional email allowlist | admin routes/controllers/services |
| APK | status, HEAD/GET download under `/api/public/android-app` | Public | `routes/public.js`, `utils/androidApk.js` |
| Chatbot | public message endpoint | Public | `routes/chatbot.js`, `services/ChatbotService.js` |

Inputs are validated manually in handlers/services. SQL is normally parameterized. There is no OpenAPI specification or shared runtime schema library.

## 12. Authentication & Authorization

- Passwords and OTPs are hashed with bcrypt (cost 10). User password minimum is 6 characters; technician minimum is 8.
- JWTs use one `JWT_SECRET`. User/technician tokens normally last 7 days, Google user tokens 30 days, admin tokens 1 day.
- `middleware/auth.js` supplies role-specific `verifyUser`, `verifyTechnician` and `verifyAdmin`. User middleware accepts user/admin or legacy tokens without a role; ownership checks then protect resources.
- Admin login uses credentials from `ADMIN_EMAIL`/`ADMIN_PASSWORD`. Extended admin routes can optionally restrict admin-token email via `ADMIN_EXTENDED_ALLOWED_EMAILS`.
- Socket.IO authenticates JWT during handshake, binds user/technician rooms to token identity, and verifies request ownership before request-room subscription.
- Logout does not revoke JWTs. No refresh-token, token rotation, `iss`/`aud`, revocation list or session-bound JWT is evident.
- Google OAuth passes a client-supplied platform string as `state` and returns the JWT in a web query parameter or Capacitor deep link.

Evidence: `middleware/auth.js`, `routes/users.js`, `routes/auth.js`, `routes/admin.js`, `services/socket.js`.

## 13. Roadside Assistance Workflow

```text
Authenticated customer POSTs request
  -> normalize service/vehicle and validate details
  -> reject recent active duplicate
  -> compute server price/towing quote (with legacy fallback)
  -> insert service request
  -> optional direct technician reservation
  -> enqueue BullMQ dispatch
  -> worker ranks eligible providers by route ETA/haversine
  -> sequential timed offers via Socket.IO/FCM
  -> technician atomically accepts under DB locks
  -> status workflow + notifications + live tracking
  -> service completion -> payment pending
  -> verified online/cash settlement -> invoice/ledger -> closed
```

Evidence: `routes/service_requests.js`, `services/jobDispatchService.js`, `services/requestStatusWorkflow.js`, `routes/jobs.js`, `routes/payments.js`.

The towing workflow has explicit pickup/load/drop/payment stages. Dispatch fallback may match directly if the queue or active worker is unavailable. Atomic claim logic prevents two providers from accepting the same request.

## 14. Mechanic / Provider Workflow

"Mechanic," "provider," and "technician" refer to the same core `technicians` domain.

1. Public registration stores identity, business, vehicle/capability and document data; returns a technician JWT for the registration-payment step.
2. Razorpay registration payment changes payment state; admin approval is still required.
3. Admin approves/rejects; approved technicians can log in and become active/available.
4. Dispatch filters approval, activity, availability, current job, service/vehicle capability and distance.
5. Technician receives an offer, accepts/rejects, and advances only allowed job statuses.
6. Location is sent while assigned; availability and `current_job_id` are reserved/released with job state.
7. Completion and payment feed earnings, dues, wallet, payout and withdrawal flows.

Evidence: `routes/technicians.js`, `controllers/technicianController.js`, `services/technicianStateService.js`, dispatch and marketplace services.

## 15. Location & Realtime Architecture

Socket.IO is initialized on the HTTP server and scaled through the Redis adapter. Location input is identity-bound and checks assignment, coordinate bounds, timestamp/sequence ordering and an implausible-speed threshold. A Lua-backed Redis store holds the newest point for approximately 30 seconds; SQL history is sampled (roughly 15 seconds or 50 meters). REST location recovery uses the same canonical pipeline.

The publisher sends live points to authorized rooms and periodically enriches them with route/ETA data. OSRM is the default router; Mappls can supply traffic ETA. Admin/user/technician notifications also use Socket.IO. Evidence: `services/liveTrackingCanonicalPipeline.js`, `services/liveTrackingIngestion.js`, `services/liveTrackingStore.js`, `services/liveTrackingPublisher.js`, `services/socket.js`, `services/routeService.js`, `services/trafficEtaService.js`.

## 16. Payment Architecture

Razorpay order creation is server-side. The canonical service flow computes price on the server, stores a pending payment, verifies an HMAC over order/payment identifiers, finalizes request payment, produces a PDF invoice, credits the technician wallet idempotently and emits notifications. The webhook uses a raw body and signature and processes captured payments as a second path. Cash payment records unsettled cash/dues and also creates an invoice.

Registration and subscription have separate order/verification endpoints. Marketplace services manage wallet transactions, payouts, withdrawals and refunds. Evidence: `routes/payments.js`, `services/serviceRequestPaymentService.js`, `services/marketplacePaymentService.js`, `services/marketplaceLedgerService.js`, `services/invoiceService.js`.

**Critical constraint:** current client confirmation/registration/subscription verification validates Razorpay HMAC authenticity but does not consistently bind the supplied gateway order to server-stored purpose, owner, expected amount and captured state before granting value. Treat these flows as security-sensitive and do not extend them without a full payment-state review.

## 17. Notification Architecture

- Socket.IO: job offers/revokes, status, tracking and room-targeted events.
- FCM: device-token push for jobs, status, reviews, reminders and broadcasts.
- Email: Resend API through mailer utilities and editable database templates; `nodemailer` remains a dependency but current delivery is Resend-based.
- SSE: admin notification stream backed by an in-process client set in `sse.js`.

Evidence: `services/socket.js`, `services/notificationService.js`, `services/mailer.js`, `utils/mailer.js`, `sse.js`.

SSE and some caches are process-local, so they do not automatically scale across multiple instances. Socket.IO does scale through Redis.

## 18. External Services & APIs

| Service | Use | Evidence |
|---|---|---|
| Razorpay | Orders, payment verification/webhook | `routes/payments.js` |
| Google OAuth | Customer social login | `routes/auth.js` |
| Firebase Admin/FCM | Push notifications | `services/notificationService.js` |
| Resend | Transactional email | `services/mailer.js`, `utils/mailer.js` |
| Redis | BullMQ, Socket.IO adapter, live tracking/cache | dispatch/tracking/socket services |
| OSRM | Road route, distance and ETA | `services/routeService.js` |
| Nominatim/Photon/Pelias | Place search/reverse geocoding | `services/locationProviderService.js` |
| Mappls | EV/fuel place details and optional traffic ETA | EV/station/traffic services |
| Overpass/OpenStreetMap | Station positions | `services/stationPositions.js` |
| IndianAPI-compatible fuel API | Fuel prices | `services/fuelPriceProvider.js` |
| Wikimedia/Wikipedia | Vehicle photos | `services/vehiclePhotoService.js` |

Provider quotas, contracts, production keys, SLAs and data-processing terms are **Unknown**.

## 19. Configuration & Environment Variables

`loadEnv.js` loads the first matching `.env` from the working directory, repository or parent. `config/envValidation.js` enforces a production-oriented list. No `.env.example` was found even though README guidance refers to environment setup.

Variable names by domain (values must never be committed or copied into docs):

- **Runtime/database:** `NODE_ENV`, `PORT`, `RENDER`, `RENDER_EXTERNAL_URL`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL`, `DB_SSL_STRICT`.
- **Identity/admin:** `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_EXTENDED_ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`.
- **URLs/CORS:** `FRONTEND_URL`, `FRONTEND_PUBLIC_URL`, `BACKEND_URL`, `BACKEND_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`, `CORS_INCLUDE_LOCAL_ORIGINS`, `CORS_ALLOW_ALL`, `CORS_ALLOW_LAN_ORIGINS`, `CORS_ALLOW_TUNNEL_ORIGINS`, `CORS_ALLOW_VERCEL_ORIGINS`.
- **Email:** `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_USER`, `EMAIL_PASS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS_REJECT_UNAUTHORIZED`, `CONTACT_RECEIVER_EMAIL`, `EMAIL_SMOKE_TO`.
- **Payments:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
- **Redis/dispatch:** `REDIS_URL`, `DISPATCH_WORKER_EMBEDDED`, `DISPATCH_WORKER_CONCURRENCY`, `DISPATCH_OFFER_TIMEOUT_MS`, `DISPATCH_RETRY_DELAY_MS`, `DISPATCH_MAX_RETRIES`, `DISPATCH_REDIS_CONNECT_TIMEOUT_MS`, `DISPATCH_RECOVERY_WINDOW_MINUTES`, `DISPATCH_RECOVERY_LIMIT`, `DISPATCH_ETA_MATRIX_LIMIT`.
- **Firebase:** `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_BASE64`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
- **Location/routing:** `LOCATION_SEARCH_PROVIDER`, `LOCATION_SEARCH_COUNTRY_CODES`, `LOCATION_SEARCH_VIEWBOX`, `LOCATION_SEARCH_BOUNDED`, `LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE`, `LOCATION_CACHE_TTL_MS`, `LOCATION_PROVIDER_TIMEOUT_MS`, `LOCATION_PROVIDER_RETRY_ATTEMPTS`, `LOCATION_PROVIDER_RETRY_DELAY_MS`, `LOCATION_PROVIDER_USER_AGENT`, `NOMINATIM_BASE_URL`, `PHOTON_BASE_URL`, `PELIAS_BASE_URL`, `REVERSE_GEOCODE_RATE_LIMIT_PER_MINUTE`, `OSRM_URL`, `OSRM_ROUTE_URL`, `OSRM_CAR_ROUTE_URL`, `OSRM_TWO_WHEELER_ROUTE_URL`, `OSRM_COMMERCIAL_ROUTE_URL`, `ROUTE_PROVIDER_TIMEOUT_MS`, `TOWING_ROUTE_TIMEOUT_MS`, `ROUTE_CACHE_TTL_MS`, `ROUTE_PROVIDER_RETRY_ATTEMPTS`, `ROUTE_PROVIDER_RETRY_DELAY_MS`, `ROUTE_RATE_LIMIT_PER_MINUTE`.
- **Map/stations/traffic:** `MAPPLS_REST_API_KEY`, `MAPPLS_NEARBY_URL`, `MAPPLS_PLACE_DETAILS_URL`, `EV_SEARCH_RADIUS_METERS`, `EV_SEARCH_DETAILS_LIMIT`, `EV_SEARCH_TIMEOUT_MS`, `EV_SEARCH_CACHE_TTL_MS`, `FUEL_SEARCH_RADIUS_METERS`, `FUEL_SEARCH_DETAILS_LIMIT`, `FUEL_SEARCH_TIMEOUT_MS`, `FUEL_SEARCH_CACHE_TTL_MS`, `EV_SEARCH_RATE_LIMIT_PER_MINUTE`, `STATION_POSITIONS`, `OVERPASS_URL`, `TRAFFIC_ETA_ENABLED`, `TRAFFIC_ETA_PROVIDER`, `MAPPLS_ROUTE_BASE_URL`, `TRAFFIC_ETA_TIMEOUT_MS`, `TRAFFIC_ETA_REFRESH_MS`, `TRAFFIC_ETA_CACHE_TTL_MS`, `LIVE_TRACKING_DIAGNOSTICS`.
- **Fuel/pricing:** `FUEL_PRICE_PROVIDER`, `FUEL_PRICE_API_KEY`, `FUEL_PRICE_API_BASE_URL`, `FUEL_PRICE_API_TIMEOUT_MS`, `FUEL_PRICE_CACHE_TTL_MS`, `FUEL_PRICE_SYNC_AFTER_IST_HOUR`, `FUEL_PRICE_RATE_LIMIT_PER_MINUTE`, `PRICING_CONFIG_CACHE_TTL_MS`, `SERVICE_PRICE_CACHE_TTL_MS`, `SERVICE_PRICE_MIN_VALID`.
- **OTP/operations:** `OTP_TTL_MINUTES`, `OTP_DEBUG_ROUTE_ENABLED`, `OTP_DEBUG_TOKEN`, `OPS_MONITOR_INTERVAL_MS`, `OPS_MONITOR_CONCURRENCY`, `OPS_MONITOR_ROUTE_ETA_BUDGET`, `TECHNICIAN_ACTIVITY_MONITOR_ENABLED`, `TECHNICIAN_ACTIVITY_MONITOR_INTERVAL_MS`, `TECHNICIAN_ACTIVITY_IDLE_TIMEOUT_MINUTES`, `TECHNICIAN_LOGIN_REMINDER_INACTIVITY_MINUTES`, `TECHNICIAN_LOGIN_REMINDER_COOLDOWN_MINUTES`, `TECHNICIAN_LOGIN_REMINDER_BATCH_SIZE`.
- **APK:** `ANDROID_APK_PATH`, `APK_PATH`, `ANDROID_APK_RELEASE_DIR`, `APK_RELEASE_DIR`, `ANDROID_APK_FILE_NAME`, `APK_FILE_NAME`.
- **Other limits:** `VEHICLE_PHOTO_RATE_LIMIT_PER_MINUTE`.

Configuration drift: SMTP variables are required by validation while active delivery uses `RESEND_API_KEY`; Redis is only explicitly required for production-like validation but live tracking initializes it unconditionally. Evidence: `loadEnv.js`, `config/envValidation.js`, mailer and tracking runtime files.

## 20. Error Handling & Logging

- Route-local `try/catch` generally returns JSON errors; global middleware handles malformed JSON and otherwise returns generic `500`.
- Request logging includes a generated request ID, method, path, status, duration and origin.
- `/health` reports process liveness; `/ready` reflects database/bootstrap readiness.
- Admin extended actions are persisted through `middleware/adminExtendedAuditLogger.js`.
- Monitoring services detect job/activity anomalies; no external APM, metrics backend, distributed tracing or crash reporter is configured.
- `unhandledRejection` and `uncaughtException` are logged but do not deliberately terminate/restart the process.

Sensitive logging issues exist: plaintext OTPs, payment request bodies/signatures, and optionally exact live coordinates are written to logs. Production log destination, retention and access are **Unknown**.

## 21. Security Architecture

Positive controls: bcrypt password/OTP hashing; parameterized SQL in inspected paths; role/ownership middleware; signed JWT; authenticated Socket.IO; assignment-bound location; Razorpay webhook HMAC; request-size/file-size bounds; selected endpoint rate limiting; admin auditing; production URL validation.

Prioritized findings from this read-only review:

| Severity | Finding | Evidence/impact |
|---|---|---|
| **CRITICAL** | Razorpay signature checks do not consistently bind order to server-stored owner/purpose/amount/captured state in service confirmation, technician registration and subscription verification | `routes/payments.js`; potential cross-order replay or incorrect entitlement/accounting; validate against gateway and stored order before granting value |
| **HIGH** | Upload and retrieval are unauthenticated; MIME is client supplied; blobs are publicly cacheable and stored in DB | `routes/upload.js`; abuse, cost/DoS, malicious content and sensitive-document exposure |
| **HIGH** | OTP plaintext is logged and generated with `Math.random` | `routes/users.js`; credential disclosure and weaker randomness |
| **HIGH** | Google OAuth `state` is not a random session-bound anti-CSRF value; JWT is sent in redirect/deep-link URL | `routes/auth.js`; login CSRF and URL/log/history/deep-link token leakage |
| **HIGH** | Login/payment/upload/contact/chatbot surfaces lack comprehensive/global rate limiting | `index.js`, route modules; brute force, spam and resource abuse |
| **HIGH** | Two customer cancellation routes enforce conflicting state rules | `routes/service_requests.js`; one blocks cancellation after arrival while `/cancel` allows any non-cancelled state, risking workflow/payment integrity |
| **HIGH** | Runtime dependency audit reports 35 production advisories: 2 critical, 15 high, 17 moderate, 1 low | `package-lock.json`; direct affected packages include `axios`, `multer`, `mysql2`, `nodemailer`; audit captured 2026-09-30 and should be re-run before remediation |
| **HIGH** | Sensitive technician identity/payment/document fields appear stored without application-level encryption or documented retention controls | `db.js`, `routes/technicians.js`; privacy/compliance exposure |
| **MEDIUM** | Long-lived JWTs have no revocation/rotation/issuer/audience; logout does not invalidate | auth middleware/routes |
| **MEDIUM** | Production CORS defaults include localhost and a legacy typo domain; no Helmet/security-header middleware found | `config/network.js`, `index.js` |
| **MEDIUM** | APK status discloses absolute server paths/release directory | `routes/public.js` |
| **MEDIUM** | Startup performs DDL and listeners can be live before readiness; Docker exposes 3001 while default app port is 5000 | `db.js`, `index.js`, `Dockerfile` |
| **MEDIUM** | Public third-party routing/geocoding defaults create privacy, quota and availability dependencies | provider services/config |
| **LOW/INFO** | No committed `.env` or obvious credential file was found in the tracked-file review; this was not a full secret-scanner run | Git tracked file scan |

This is an architecture review, not a penetration test. Validate exploitable conditions in an authorized test environment before remediation planning.

## 22. Testing

There are 23 native Node test files with approximately 135 declared test cases: 15 under `tests/` and 8 beside live-tracking services. Coverage is strongest around dispatch matching, towing/pricing/request input, public fuel/EV/map/vehicle-photo providers, and live-tracking contracts, ingestion, recovery, publication and sockets.

Major gaps: user/admin/technician authentication, OTP, uploads, payment/webhook/order binding, cash and ledgers, payouts/withdrawals/refunds, notification/email delivery, DB bootstrap/migrations, admin authorization, deployment and full end-to-end request completion.

`package.json` has only selected domain scripts, not a general `test` script. A complete local command is expected to resemble:

```text
node --test tests/*.test.js services/*.test.js
```

The audit environment had no `node_modules`, and dependencies were not installed by design, so tests were not executed. `npm run build` succeeded with 142 JavaScript/module files passing syntax checks under Node 24.21.0; production compatibility must still be checked on the Docker Node 18 runtime.

## 23. Build & Deployment

Local lifecycle:

1. Install the locked dependencies with a team-approved Node/npm version.
2. Supply environment variables and running MySQL-compatible/Redis services.
3. Run `npm run build` for syntax validation.
4. Run `npm start`, `npm run dev`, and optionally `npm run worker:dispatch`.

Docker uses Node 18 Alpine, `npm install --omit=dev`, copies the repository, exposes port 3001 and runs `npm start`. The application default is port 5000; the hosting environment must set `PORT` consistently. No `.dockerignore` was found, so build-context contents depend on the checkout.

**Likely/inferred:** deployment on Render, based on production URLs and `RENDER` handling. **Unknown:** actual hosting service, release pipeline, process topology, TLS/reverse proxy, database/Redis providers, CI gates, backups, monitoring and rollback automation. No provider deployment manifest or CI workflow is checked in.

## 24. Update-System Readiness

Current readiness is low. The backend can distribute one Android APK and report size/mtime, but has no semantic version, build number, channel, minimum-supported version, force/optional policy, cryptographic checksum/signature metadata, compatibility window, rollout, client acknowledgement or rollback manifest. The APK is a tracked binary and distribution appears manual.

No web service worker, PWA cache policy, deployment version ID or update detector exists here; the client repository is required to confirm them.

Future principles (**Recommendation**, not implemented):

- Define a signed/versioned release manifest and client capability/version headers before update UX.
- Treat Capacitor web assets as OTA-eligible only if the client has a policy-compliant, signed updater; native plugins, runtime and Android/iOS binaries require platform-approved installation/distribution and existing signing identity.
- Never force refresh/restart during active request, dispatch offer, navigation, tracking or payment. Download/cache safely and activate on user refresh/reopen or an explicit safe-state action.
- Preserve API and Socket.IO compatibility across at least the deployment overlap window. Prefer additive API/event changes and deprecate explicitly.
- Use expand/contract database changes because old and new processes/clients may coexist.
- Persist download state, verify hashes/signatures, retry interrupted downloads and retain a known-good client bundle where the platform supports rollback.

## 25. Important Architectural Constraints

- Redis is required for tracking, Socket.IO scale-out and queued dispatch; degradation behavior differs by subsystem.
- MySQL is both durable domain storage and blob/invoice storage; large/public uploads affect the primary database.
- `service_requests` is the central aggregate shared by dispatch, tracking, payments, admin and notifications. Status or column changes have broad impact.
- Technician availability and `current_job_id` must remain consistent with request/offer state; several services reconcile or lock these values.
- Payment finalization must remain idempotent across client confirmation and webhook delivery.
- Raw webhook middleware must remain before JSON parsing.
- Socket events/rooms and route aliases are client contracts even without an OpenAPI schema.
- Startup schema mutation means code, DB permissions and schema deploy together today.
- External map/data results are rate-limited/cached and may fall back; do not assume uniform accuracy or traffic awareness.

## 26. Known Risks / Technical Debt

In addition to the security table: schema management is split between runtime DDL and manual migrations; `schema.sql` and README are incomplete; configuration validation and email implementation have drifted; the public APK release lacks metadata; there is no CI/CD definition or comprehensive test command; no OpenAPI/contract schema exists; observability is log-centric; several caches and admin SSE are single-process; the chatbot is a process-local keyword/rule engine; static `/uploads` configuration does not match the database-backed upload path; and duplicate/legacy API routes increase maintenance cost.

## 27. Areas That Must Not Be Changed Casually

- `service_requests` statuses, towing transitions and terminal-state semantics.
- Payment HMAC/webhook ordering, ledger idempotency, invoice and wallet credit rules.
- Dispatch eligibility, database locks, offer expiry/retry and technician reservation/release.
- Live-location identity, sequence/time/speed validation, Redis TTL and room authorization.
- JWT payload/role names, Socket.IO auth and backward-compatible route/event names.
- `db.js` bootstrap order or schema widths without a migration/rollback plan.
- Pricing normalization, vehicle/service aliases and stored pricing snapshots.
- CORS/OAuth callback/deep-link origins without coordinated client/deployment changes.
- APK signing identity or package identifier (not present here, but essential to installable updates).

## 28. Recommended Development Practices

1. Begin from a traced user flow and identify all route, service, DB, event and external-provider consumers.
2. Add regression tests before changing payment, dispatch, status, tracking or authentication behavior.
3. Preserve backward compatibility; add fields/events before removing or renaming them.
4. Make money and state transitions transactional and idempotent; store immutable provider/reference IDs.
5. Move toward versioned, reviewed migrations with expand/contract deploys instead of startup DDL.
6. Validate request schemas centrally and use constant-time comparisons for secrets/signatures.
7. Never log OTPs, tokens, secrets, payment signatures or precise location unnecessarily.
8. Test both embedded and standalone dispatch worker topologies and multi-instance Socket.IO behavior.
9. Re-run dependency audit and targeted test suites before release.
10. Update this context and the onboarding guide when architecture contracts change.

## 29. Local Development Guide

Prerequisites: team-approved Node 18-compatible toolchain, npm, MySQL/TiDB-compatible database, Redis, and credentials only for integrations being exercised. A real `.env.example` is absent; obtain variable requirements from Section 19 and secure team configuration.

Suggested safe sequence:

```text
npm ci
npm run build
node --test tests/*.test.js services/*.test.js
npm run dev
```

Run `npm run worker:dispatch` only when `DISPATCH_WORKER_EMBEDDED` is disabled or when deliberately testing the separate-worker topology. Use `/health` for liveness and `/ready` for dependency/bootstrap readiness. Never point local commands at production DB/Redis, Razorpay live keys, or production notification credentials.

## 30. Glossary

- **Customer/user:** person requesting assistance; stored in `users`.
- **Technician/mechanic/provider:** service fulfiller; stored in `technicians`.
- **Service request/job:** central roadside-assistance record in `service_requests`.
- **Offer:** a time-limited dispatch invitation to one technician.
- **Direct assignment:** request created against a chosen technician rather than normal queue ranking.
- **Towing phase 2:** detailed pickup/load/drop state machine and route/pricing data.
- **Canonical tracking pipeline:** shared validation/ingestion path for Socket.IO and REST recovery.
- **Marketplace ledger:** wallet, dues, payout, withdrawal and refund accounting around payments.
- **Expand/contract migration:** add compatible schema first, migrate traffic/data, remove old shape later.
- **OTA:** update content delivered without replacing the native binary; eligibility depends on the actual client framework and store policy.

## 31. Unknowns / Items Requiring Team Confirmation

- Location and revision of `resqnowfrontend`; exact React/Vite/Capacitor versions and native projects.
- Where web and mobile store JWTs and how deep links are verified.
- Actual Render/other production topology, number of API/worker instances and process supervision.
- Production MySQL/TiDB and Redis providers, regions, TLS certificates, backups, restore tests and retention.
- DNS, TLS termination, WAF/CDN, firewall and network isolation.
- CI/CD system, protected branches, review/release gates and artifact provenance.
- Play Store/App Store/internal distribution status, Android package ID, signing-key custody and versioning policy.
- Production logging destination, access, redaction, retention, alerts, APM and on-call ownership.
- Razorpay account mode/webhook setup, settlement reconciliation and intended subscription/registration binding.
- Data privacy policy for Aadhaar/PAN/license, uploaded documents, exact location, invoices and deletion requests.
- SLA/quota/legal terms for OSRM, OSM/Nominatim, Mappls, IndianAPI, Wikimedia, Firebase and Resend.
- Whether public upload/read and broad cancellation behavior are intentional legacy contracts.

## 32. Repository Evidence Map

| Claim | Primary evidence |
|---|---|
| Server bootstrap/routes/readiness/shutdown | `index.js` |
| Environment load/validation/CORS | `loadEnv.js`, `config/envValidation.js`, `config/network.js` |
| Database connection/runtime schema | `db.js`, `scripts/migrations/*.sql`, `schema.sql` |
| Authentication/roles/OAuth | `middleware/auth.js`, `routes/users.js`, `routes/auth.js`, `routes/admin.js` |
| Customer vehicles/requests | `routes/vehicles.js`, `routes/service_requests.js` |
| Technician lifecycle | `routes/technicians.js`, `controllers/technicianController.js`, `services/technicianStateService.js` |
| Dispatch/worker | `services/jobDispatchService.js`, `services/jobMatcher.js`, `services/dispatchQueueService.js`, `workers/dispatchWorker.js` |
| Status workflow/towing | `services/requestStatusWorkflow.js`, `services/towingQuoteService.js`, `routes/service_requests.js` |
| Realtime/tracking | `services/socket.js`, `services/liveTracking*.js`, `sse.js` |
| Pricing/payment/invoice/ledger | `services/platformPricing.js`, `routes/payments.js`, `services/serviceRequestPaymentService.js`, `services/marketplace*.js`, `services/invoiceService.js` |
| Notifications/email | `services/notificationService.js`, `services/mailer.js`, `utils/mailer.js`, `models/EmailTemplate.js` |
| Maps/public data | `routes/public.js`, `services/locationProviderService.js`, `services/routeService.js`, `services/trafficEtaService.js`, fuel/EV/station/photo services |
| Uploads | `routes/upload.js` |
| Admin platform | `routes/admin*.js`, `controllers/admin*.js`, `services/adminExtended*.js`, `services/operationsCommandCenterService.js` |
| Tests/build/container | `tests/*.test.js`, `services/*.test.js`, `scripts/build-check.mjs`, `package.json`, `package-lock.json`, `Dockerfile` |
| Backend-only/client separation | `README.md`, absence of client/native source, `public/downloads/resqnow.apk` |

