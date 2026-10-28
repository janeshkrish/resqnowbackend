# ResQNow Project Context

Canonical architecture context for developers and AI assistants. The historical review below was recorded on 2026-09-30 at commit `c241cf5` on branch `suthan`. Database update, 2026-10-15: all 42 active table definitions/bootstrap code live under `models/`, IDs and account references use UUIDs, notes/admin audit histories are consolidated, and OTP state plus every original historical OTP record share `otp_requests`. Startup supports a verified maintenance transfer to a separate TiDB database. A push-to-main GitHub workflow automates maintenance, transfer and Render release after one-time configuration; see [deployment setup](docs/github-tidb-deployment.md) and [models/README.md](models/README.md). Historical database descriptions below are superseded. No hosted migration or GitHub/Render deployment has been performed; configured TiDB access was denied.

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

**Verified workspace update, 2026-10-27:** the sibling `../resqnowfrontend/` contains the React/Vite client and Capacitor **8.1.0** Android source. `capacitor.config.ts` specifies package `com.resqnow1.app`, bundled `dist` assets and no remote root URL; `android/app/build.gradle` specifies **1.3 / versionCode 4**. This backend repository itself still contains no Android source.

The production direct-download endpoint was updated and verified on **2026-10-27** to serve the signed **1.3 / code 4** Railway-configured APK, identical to local `public/downloads/resqnow.apk`: **15,928,619 bytes**, SHA-256 `b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`. It retains the authorized original signing identity. The former **1.2 / code 3** Render-configured download, SHA-256 `eda7a5b77e05f9aa774dc7c9b68c83c467517519500834f155840a472db5ff8f`, is backed up locally. See section 23 for publication and testing limitations; other distribution channels remain unverified.

The authorized private key is now available in workspace `../resqnow-release/resqnow-release.jks`; certificate SHA-256 **`3874c317a48dcd014c0665786a139246890bb0f951561097eb7d2d732bcf6826`** matches the distributed APK, and an ephemeral in-memory nonce signature verified the key/certificate pair. The key folder, copied Android key-store folder and password file are ignored by the outer workspace Git repository, with none tracked there. Never copy them into this repository; outer ignore rules do not protect independent child repositories. No credentials or key material are recorded here. Gradle release signing is not configured and SDK signing tools are not located on this host. See [release preflight](../APK_RELEASE_PREFLIGHT.md) for current blockers and evidence.

**Frontend/mobile configuration completed, 2026-10-27:** `../resqnowfrontend/src/lib/apiConfig.ts` now provides the shared API policy used by `src/lib/api.ts` and `vite.config.ts`. Production requires an explicit HTTPS origin equal to `https://resqnowbackend-production-c392.up.railway.app`, without `/api`, credentials, another path, query or fragment; missing/invalid input throws before requests or the production build can proceed. Production demo mode is rejected, including attempts to use it to bypass missing backend configuration. The old Render production fallback was removed. Development without an explicit URL uses `http://localhost:5000`; explicit local/LAN HTTP backends and local-only demo mode remain supported. The explicit development-mode build remains supported too.

`../resqnowfrontend/capacitor.config.ts` replaces the obsolete Render host/wildcard navigation entries with only the exact Railway backend hostname for backend callback navigation. This is a navigation setting, not the REST URL source; Google sign-in handling, `resqnow://auth/callback`, the runtime bridge, Java plugins, permissions and Firebase/native configuration were not changed. Native authentication/navigation still requires real-device acceptance.

REST uses `apiFetch`/`apiUrl`; Axios admin clients use `apiUrl('/api/admin')` and `apiUrl('/api')`; Socket.IO uses `getRequiredApiBaseUrl`; `ActiveJob.tsx` supplies `apiUrl('/api/technicians/me/location')` to native technician tracking. These callers already derive the shared origin correctly and were left unchanged. Application ID **`com.resqnow1.app`** and Android **1.3/code 4** were retained: code 4 exceeds the verified direct-download code 3, with no evidence here justifying another increment. Higher versions in other channels remain unverified.

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

**Verified release preflight, 2026-10-27 approximately 10:40 IST:** `https://resqnowbackend-production-c392.up.railway.app/health` returned 200/`OK`; `/ready` returned 200 with `ok=true` and `database.ready=true`, without a maintenance flag; `/api/public/stats` returned normal database-backed JSON. The historical October 21 maintenance-only condition was not active for these requests. Readiness is a point-in-time observation, not certification of every production flow.

The checked-in `.github/workflows/deploy-production.yml` verifies backend tests/build; its Render deployment job is explicitly conditional on `DEPLOY_PROVIDER=render`. Railway is the documented production release destination. Local preflight inspected branch `shrihari`, frontend commit `1dec6de0c5afc4c8ff733aaf5f219963d56b7dc8` and backend commit `6169d715e5896f82589c4ceb8e546f92f50dfefb`; both working trees began clean. Current cloud deployment revision/settings were not inspected.

**Latest Android outcome, 2026-10-27: signed 1.3/code 4 live-client-key APK published and public-download hash verified at the owner's request.** The historical [release preflight](../APK_RELEASE_PREFLIGHT.md) and initial blocked/test-payment attempts below are superseded by the live candidate/device-testing and website-publication records. Node **24.22.0**, npm **11.19.1**, Capacitor **8.1.0**, JDK **21.0.13.0.2**, Gradle **8.14.3**, SDK Platform 36 and Build Tools **36.0.0** were used. Provider inputs were supplied by the owner in ignored `.env` files; the original release key was reused without modification. The earlier test-key APK is retained. The device upgrade, launch, owner-reported Google sign-in, basic English speech/TTS and generic FCM foreground/background/short locked-screen delivery with notification-tap opening passed initial checks. The owner stopped further device testing and authorized distributing this existing APK. Mappls remains blocked and broader functional acceptance and live-payment readiness are not certified. See the publication record below for actual public-download verification.

**Production inputs prepared, 2026-10-27:** new local `../resqnowfrontend/.env.production` contains only the approved public `VITE_API_URL` and `VITE_FRONTEND_ONLY=false`; it is intentionally Git-ignored. New trackable `../resqnowfrontend/.env.example` documents those public defaults and empty client-provider settings, with no actual provider keys. Future release hosts must reproduce the approved routing via their own environment or local production file; do not assume the ignored file travels with a Git checkout. Existing process environment and `.env.production.local` can override defaults, but invalid production API/demo overrides now fail validation.

Client configuration requirements: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, and `VITE_FIREBASE_MESSAGING_SENDER_ID` for their client auth/messaging roles; `VITE_FIREBASE_STORAGE_BUCKET` where used; `VITE_FIREBASE_VAPID_KEY` for web push; `VITE_MAPPLS_MAP_SDK_KEY` for current maps; `VITE_RAZORPAY_KEY_ID` for payment UI; `VITE_GOOGLE_MAPS_API_KEY` if Google-backed paths are used. These are now present in the owner's effective frontend environment, as checked for the successful candidate below. Native `google-services.json` is unchanged and does not supply these web build inputs. Backend credentials, private Firebase Admin keys, payment secrets and signing passwords must never enter `VITE_*` or tracked files.

**Validation of configuration changes:** new `src/lib/api.configuration.test.ts` first demonstrated 13 failing expectations against the previous implementation, then passed after the change. The final scoped regression command selected that file plus the existing socket-context, native-background-tracking, demo job-acceptance, Firebase, technician-auth, realtime-request socket, service-payment and technician ActiveJob tests: **9 files / 57 tests passed**. React Router emitted its existing future-flag warnings. Vitest initially hit a sandbox temporary-cache rename denial; the same tests passed with normal temporary-cache access. The test scope is not a whole-application or device certification.

Actual Vite `resolveConfig` checks (without building) accepted the prepared production environment, rejected missing/Render/HTTP/API-suffixed origins and a demo-mode bypass, and accepted the development server and explicit development-mode build configuration. `tsc -p tsconfig.node.json --noEmit --incremental false` passed for the Vite/shared configuration. Production client tests also cover malformed/relative URLs, credentials, queries/fragments, origin normalization, real REST/Axios base URL derivation and development behavior. No Vite production bundle, Capacitor sync, Android compilation, APK signing/distribution, dependency installation, deployment or commit was performed. Remaining acceptance includes provisioning approved provider settings and toolchain/signing workflow, checking final bundled assets, and real-device auth/notification/map/payment/background-tracking upgrade tests.

### Initial toolchain setup — 2026-10-27: historical blocked attempt

The subsequent build request authorized toolchain installation, but explicitly required stopping when approved client settings or essential tools are unavailable. The following prerequisites were installed in **`../.release-tools/`**, a local portable workspace toolchain, not in either source repository. Root `.gitignore` now excludes this directory; signing-folder/password exclusions remain intact. No Android Studio, machine-wide Java installation or permanent system environment changes were required. Winget's application alias could not run in the sandbox; official portable ZIP packages were used instead of a system-wide package installation.

| Component | Actual installed / verified result |
|---|---|
| JDK | Microsoft OpenJDK **21.0.13.0.2**, under `.release-tools/jdk-21`; `java -version` and `javac -version` succeed |
| SDK command-line tools | **22.0**, under `.release-tools/android-sdk/cmdline-tools/latest`; `sdkmanager --version` succeeds; it emits Google's deprecation notice, but package installation completed |
| SDK Platform 36 | `platforms;android-36`, revision **2**, including `android.jar` |
| Android SDK Build Tools | **36.0.0**; `aapt2`, `zipalign` and `apksigner` available; `aapt2 version` and `apksigner version` succeed |
| Android Platform Tools | **37.0.1**, `adb version` succeeds; no device connection/install attempted |
| Gradle | Wrapper configured for **8.14.3**. Initial download attempts timed out; the subsequent verified installation and successful build are recorded below. |

Official sources: [Microsoft OpenJDK downloads](https://learn.microsoft.com/en-us/java/openjdk/download), [Google command-line tools downloads](https://developer.android.com/studio#command-line-tools-only), and [SDK manager installation instructions](https://developer.android.com/tools/sdkmanager). Downloaded ZIPs were verified against their official SHA-256 values before extracting or executing tools:

- Microsoft `microsoft-jdk-21.0.13.0.2-windows-x64.zip`: `c5706a9cf482ef1a0622a86eea5b13d557b07f04554572af061e2d02b58c0f99`.
- Google `commandlinetools-win-15859902_latest.zip`: `90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a`.
- Gradle was initially requested from its configured `https://services.gradle.org/distributions/gradle-8.14.3-all.zip`, then `https://downloads.gradle.org/distributions/gradle-8.14.3-all.zip`. Those initial transfers timed out. The later bounded-range download completed and verified the official distribution, as recorded in the successful build below. All caches remain isolated in the ignored tooling directory.

Per-session setup: dot-source **`../.release-tools/enter-build-environment.ps1`** from a PowerShell build session. It sets `JAVA_HOME` to the local JDK, `ANDROID_HOME`/`ANDROID_SDK_ROOT` to the local SDK, `GRADLE_USER_HOME` to `.release-tools/gradle-cache`, and prepends the tool paths. These variables do not persist into unrelated/new shells unless the script is sourced again. The Gradle cache is isolated from other projects.

Actual commands executed from the workspace root (provider passwords/keys are intentionally omitted):

```powershell
. .\.release-tools\enter-build-environment.ps1
java -version
javac -version
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" --version
# Required package licenses accepted through stdin; installer output kept in ignored tooling logs.
1..12 | ForEach-Object { 'y' } | & "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "--sdk_root=$env:ANDROID_HOME" --install 'platforms;android-36' 'build-tools;36.0.0' 'platform-tools'
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "--sdk_root=$env:ANDROID_HOME" --list_installed
& .\resqnowfrontend\android\gradlew.bat --version --no-daemon # failed during distribution download
& "$env:ANDROID_HOME\platform-tools\adb.exe" version
& "$env:ANDROID_HOME\build-tools\36.0.0\aapt2.exe" version
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" version
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --verbose --print-certs '.\resqnowbackend\public\downloads\resqnow.apk'
```

**Existing signing identity verification now uses Android/JDK tools:** the original downloadable APK passes SDK `apksigner verify`, with v2 and v3 verification true, one signer, certificate SHA-256 **`3874c317a48dcd014c0665786a139246890bb0f951561097eb7d2d732bcf6826`**. The verifier reported v1/v3.1/v4 and SourceStamp false; this does not invalidate its successful v2/v3 verification. `keytool -list -v` inspected the existing authorized keystore using a password supplied only through a temporary environment variable, then cleared it. It identifies alias **`resqnow`**, `PrivateKeyEntry`, and the same certificate fingerprint. No private key was exported and no password was printed. No keystore or APK was modified.

**Client configuration gate after the owner's final saved-file update: PASS for candidate compilation.** Both environment files remain Git-ignored. Vite's actual production `loadEnv` confirms the approved Railway origin, explicit demo-off setting and payments enabled. All required Firebase client fields, `VITE_MAPPLS_MAP_SDK_KEY` and `VITE_RAZORPAY_KEY_ID` are present without obvious placeholders. Storage bucket, web-push VAPID and Google Maps client fields are also present. Firebase project and messaging sender identifiers match native `google-services.json`. No values were printed and neither environment file was modified by the build engineer. Provider authorization/runtime behavior remains untested.

**Payment limitation:** the supplied Razorpay client key remains **test mode**. The candidate was built with the owner's supplied settings, without inventing or switching keys. This does not establish live production payments; validate intended payment mode and supply an approved live client key plus matching backend configuration before a live-payment release. No key value is recorded here. Existing local Capacitor/Vite dependencies were reused; no npm restore/install was needed.

**Initial attempt outcome:** stopped before the frontend build while settings and Gradle were unavailable. The owner subsequently supplied the missing settings and requested another check; the successful resumed build is recorded below. Original APKs, native source and the authorized keystore were preserved throughout. Nothing was deployed, published, committed or pushed.

### Initial signed APK 1.3 candidate — 2026-10-27: test-payment build, retained

| Release property | Verified result |
|---|---|
| Signed output | `C:\Users\shrih\resqnow-production-folder\resqnowfrontend\android\app\build\outputs\apk\release\resqnow-1.3-railway-release.apk` |
| APK size | **15,928,619 bytes** |
| APK SHA-256 | **`5c69856372b27ed233f0283784235103af3798e3afbb2c48c678581ed88a33f8`** |
| Package | **`com.resqnow1.app`** |
| Android version | **1.3 / versionCode 4**; retained because the verified current direct-download version is code 3 and no higher version was demonstrated |
| Release / SDK | **debuggable=false**, min SDK **24**, target SDK **36**; confirmed with SDK badging and `apkanalyzer manifest debuggable` |
| Signing identity | Original keystore, alias **`resqnow`**; certificate SHA-256 **`3874c317a48dcd014c0665786a139246890bb0f951561097eb7d2d732bcf6826`** |
| Android signature verification | SDK `apksigner verify --verbose --print-certs`: **valid**, one signer, **v2=true, v3=true** |
| Alignment | SDK `zipalign -c -P 16 4`: **passed** |
| Backend selection | Bundled configuration selects **`https://resqnowbackend-production-c392.up.railway.app`**, with no `/api` suffix and explicit demo-off setting; old Render origin absent from generated JS |
| Web assets | **236/236** production files match by SHA-256 across fresh `dist/`, copied Android assets and final signed APK |
| Main web entry | **`/assets/index-Dx8Y_ECn.js`** |
| Native preservation | **21** baseline Java/manifest/network-source files unchanged; technician tracking, job alerts, trip updates and voice plugin classes found in APK DEX |
| Provider limitation | Owner-supplied client settings used; **Razorpay test mode**, no real-device provider acceptance performed |

Gradle download was recovered by fetching bounded ranges from the official distribution URL and validating the complete **224,584,249-byte** archive against official SHA-256 **`ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c`**, then seeding the configured wrapper cache. `gradlew --version` confirmed **8.14.3** on Microsoft JDK **21.0.13.0.2**.

The first two-worker compilation failed in Gradle's immutable-transform-cache directory rename, before application compilation. This matches a documented [Gradle Windows cache issue](https://github.com/gradle/gradle/issues/31438). A new single-use-daemon invocation with **one worker** then completed `:app:assembleRelease`: **BUILD SUCCESSFUL in 6m 3s, 264 actionable tasks executed**. No antivirus/security setting, Gradle version or functional application source was changed to work around it.

`npm run build` succeeded, and Capacitor sync regenerated Android web assets/configuration and the compatibility module while retaining all four Capacitor dependencies and custom native plugin source. The generated Gradle integration files were rewritten by Capacitor; native Java, manifest/network configuration and original version settings remained unchanged. Dependency restoration was unnecessary because the required locked packages were already available. Existing nonfatal warnings concerned stale Browserslist data, large web chunks, flat-directory repositories, SDK XML compatibility and Java deprecation/unchecked operations; they were not suppressed or used to bypass checks.

Secure external signing was implemented in ignored **`.release-tools/sign-resqnow-release.ps1`**, with per-session SDK/JDK setup from **`.release-tools/enter-build-environment.ps1`**. The helper checks the authorized certificate before signing, reads the existing local password file into a temporary environment variable, passes only its variable name to SDK tools, clears it in `finally`, aligns before signing, verifies signatures/alignment, and refuses to overwrite existing candidate outputs. No new key was created, key material exported or secret printed. Build/signing helpers and logs are local ignored artifacts, not committed release automation.

Successful build/sign/verification commands used in this run (from project root; shown as a record, not a request to overwrite the existing candidate):

```powershell
. .\.release-tools\enter-build-environment.ps1
Push-Location resqnowfrontend
npm.cmd run build
node .\node_modules\@capacitor\cli\bin\capacitor sync android
Push-Location android
.\gradlew.bat --version --no-daemon
.\gradlew.bat :app:assembleRelease --no-daemon --console=plain --max-workers=1 --stacktrace '-Dorg.gradle.internal.http.connectionTimeout=60000' '-Dorg.gradle.internal.http.socketTimeout=60000'
Pop-Location
Pop-Location
& .\.release-tools\sign-resqnow-release.ps1
python .\.release-tools\verify-resqnow-release.py
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\apkanalyzer.bat" manifest debuggable '.\resqnowfrontend\android\app\build\outputs\apk\release\resqnow-1.3-railway-release.apk'
```

Signing helper operations are `zipalign -P 16 4` on `app-release-unsigned.apk`, then `apksigner sign` with existing alias `resqnow`, password references `env:RESQNOW_SIGNING_PASSWORD`, v4 disabled, and a separate `resqnow-1.3-railway-release.apk` output. Verification uses `apksigner verify --verbose --print-certs` and `zipalign -c -P 16 4`. The private password is never a literal command argument. The new verifier also rejects packaged environment/keystore/password files and checks native classes, permissions, versions and asset hashes.

Required permissions verified in the final APK: INTERNET; coarse/fine location; POST_NOTIFICATIONS; WAKE_LOCK; VIBRATE; USE_FULL_SCREEN_INTENT; POST_PROMOTED_NOTIFICATIONS; FOREGROUND_SERVICE; FOREGROUND_SERVICE_MEDIA_PLAYBACK; FOREGROUND_SERVICE_LOCATION; RECORD_AUDIO. Network-state, FCM receive and package-specific dynamic-receiver permissions are also present.

Local verification evidence is in ignored `.release-tools/logs/gradle-release-diagnostic.log`, `apk-signature-verification.txt`, `apk-content-verification.json`, plus `frontend-build-manifest.json` and `native-source-baseline.json` under `.release-tools/`. Original website/backend APK, frontend-root APK, historical Android release APK and authorized keystore hashes remain unchanged. **The website APK was not replaced; nothing was deployed, published, committed or pushed.**

**Acceptance still required:** this is a signed release candidate, not a production-readiness certification. Test fresh install and same-key upgrade from 1.2, real Railway login/requests/dispatch/sockets, Mappls authorization for the native origin, notifications/job alerts, voice/microphone, foreground/background tracking and permission recovery, OAuth deep links and payment flows on supported devices. Resolve live-versus-test payment configuration before a live-payment release, and confirm any distribution/version history outside the checked direct-download channel. No device installation or runtime acceptance was attempted in this build phase.

**Post-build configuration update, 2026-10-27:** the owner changed payment settings. The effective frontend build environment and local backend `.env` now contain matching **live-mode** Razorpay client key IDs, and the local backend secret is present; no values were printed. Railway's deployed payment credentials were not inspected, so local matching settings do not prove deployed payment readiness. The already-built APK with SHA-256 `5c69856372b27ed233f0283784235103af3798e3afbb2c48c678581ed88a33f8` still contains its original test-mode build inputs and must be rebuilt before live-payment device testing. A read-only `adb devices -l` check found no connected device. No APK was rebuilt, installed, published or replaced during this follow-up check.

### Live-key candidate and physical-device testing — 2026-10-27

After the owner connected a phone reported as Samsung Galaxy A57, a separate live-client-key APK was rebuilt and verified. The previous signed test-key APK remains at its original path and SHA-256; the previous generated APKs/metadata were also preserved by copy under ignored `.release-tools/artifacts/1.3-test-before-live/` before rebuilding.

Gradle's packaging step cleared prior generated APK outputs; the preserved signed test-key APK and its aligned intermediate were then restored byte-for-byte to their original output paths. The live candidate also has a stable backup at `.release-tools/artifacts/1.3-live/resqnow-1.3-railway-live-release.apk`. Preserve signed outputs before future Gradle packaging runs rather than assuming arbitrary extra files survive in `build/outputs/apk/release/`.

| Property | Live candidate / observed result |
|---|---|
| Signed APK | `C:\Users\shrih\resqnow-production-folder\resqnowfrontend\android\app\build\outputs\apk\release\resqnow-1.3-railway-live-release.apk` |
| Size | **15,928,619 bytes** |
| SHA-256 | **`b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`** |
| Package / version | **`com.resqnow1.app`, 1.3 / code 4**, non-debuggable; min SDK 24 / target 36 |
| Signer | Original alias `resqnow`, certificate **`3874c317a48dcd014c0665786a139246890bb0f951561097eb7d2d732bcf6826`**; SDK signature and 16 KiB page-alignment checks passed |
| Frontend | Fresh main entry **`/assets/index-CI1dz0HG.js`**, Railway selected, explicit demo-off; actual supplied live client key found in generated JS without printing it |
| Assets / plugins | **236** web files match the live build manifest in the APK; expected native plugin classes/permissions verified; **21** Java/manifest/network baseline files unchanged |
| Gradle | `:app:assembleRelease --no-daemon --console=plain --max-workers=1` succeeded: **21m 46s**, 264 tasks (42 executed, 222 up-to-date) |
| Device connection | **Authorized** after the owner refreshed USB trust; actual model **SM-A576B**, Android **17 / API 37**, active owner user 0 |
| Installation / launch | **Update installed successfully**, 1.2/code 3 -> 1.3/code 4, exact installed live APK hash verified; launch passed, no uninstall/data clear or forced permission grant |

Actual resumed flow: `npm.cmd run build`, local Capacitor CLI `sync android`, single-worker Gradle release build, `.release-tools/sign-resqnow-release.ps1 -Variant railway-live`, then `python .release-tools/verify-resqnow-release.py --live`. The ignored helpers were extended to use a distinct live output and verification files, preserving the earlier candidate/evidence. Logs/manifests: `.release-tools/frontend-build-manifest-live.json`, `logs/apk-live-signature-verification.txt`, `logs/apk-live-content-verification.json`. No new keystore, backend changes or npm dependency installation were needed.

The owner authorized USB debugging in principle, but subsequent checks still returned unauthorized and the owner reported no debugging prompt. The local ADB server was restarted once; the same installed SDK ADB executable and normal host authorization-file availability were confirmed without reading, deleting or replacing key material. The requested owner action follows [Android's device-connection troubleshooting](https://developer.android.com/codelabs/basic-android-kotlin-compose-connect-device#5): disconnect USB, revoke USB debugging authorizations in Developer options, reconnect unlocked and accept the RSA authorization prompt. This clears trusted-computer authorizations, not app data. No antivirus or phone security feature was disabled.

**Physical-device results so far:** the owner accepted the USB trust prompt, and ADB state became `device`. The pre-installed APK was **1.2/code 3**, SHA-256 `eda7a5b77e05f9aa774dc7c9b68c83c467517519500834f155840a472db5ff8f`, with the matching authorized signer. Its APK binary was backed up to ignored `.release-tools/device-test/installed-1.2-before.apk`; app-private data was not extracted. The update command was `adb -s <authorized-device> install --user 0 -r <live-candidate>` and returned **Success**. No uninstall, downgrade flag, app-data clear or permission forcing was used.

`adb shell am start --user 0 -W -n com.resqnow1.app/.MainActivity` returned **Status: ok**, cold-launch time **2,104 ms**, and a running app process. After installation, the APK binary pulled from the installed package matched live-candidate SHA-256 **`b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`**, and package metadata reported **1.3/code 4**. This establishes the installed binary, not just a filename/version label. A scoped startup log capture found no fatal exception/error lines; it is not exhaustive crash-history or long-duration stability testing.

The owner completed Google sign-in on the phone and reported returning to ResQNow home. A read-only check of `/api/auth/google/url?platform=capacitor` returned HTTP 200 with Google as provider and callback origin `https://resqnowbackend-production-c392.up.railway.app`, path `/auth/google/callback`. No account credentials, OTPs or OAuth tokens were requested or printed. Chrome was foreground during the external sign-in flow; after bringing `MainActivity` forward, the native app was confirmed foreground and its customer towing form rendered. The observed screen supports basic authenticated navigation; SMS login, all OAuth failure paths and session-retention details are not yet certified.

**Location-screen check, 2026-10-27:** after the owner enabled mobile location, ADB confirmed system location enabled and ResQNow's fine/coarse location permissions granted. The native app was foreground on **Towing → Step 2 / Location**, with a populated pickup address. The map displayed **“Map is temporarily unavailable”** and a Retry map button. Permission access passes this check. After tapping the location button and retrying the map, the owner confirmed **the pickup address is correct, but the map is still unavailable**. Basic current-location/address acceptance therefore passes; numeric GPS accuracy was not measured. Map rendering remains **BLOCKED after retry**. Stay on this step without confirming a request; map, search and route acceptance remain incomplete. No address or coordinates are recorded here. Notification and microphone permissions were not granted at this observation; permission prompting/delivery, voice and background/technician tracking still require acceptance testing. Ignored evidence: `.release-tools/device-test/location-device-observation.json` and app-only `location-permission-enabled.png`. A scoped current-process log sample contained no fatal-exception marker; it did not contain a Mappls error code, so it does not establish the phone's HTTP failure reason.

No real service request, dispatch or payment has been initiated by the engineer. Login/permission prompts require owner participation; no real dispatch or live-money transaction will be submitted without explicit approval. The live client key does not prove Railway's deployed payment secret/key pairing. The original website APK was not replaced or deployed; neither new candidate has been published.

**Mappls authorization finding:** read-only requests to the Mappls Web SDK and Search plugin endpoints using the supplied client key and APK origin `https://localhost` returned **401 / `ASSET_ACCESS_DENIED`**. A Web SDK request with website origin `https://resqnow.org` also returned 401. The provider's error description was **`Api access denied`**; no specific IP/domain-validation or expired-token message was observed. The phone's unavailable-map screen is consistent with this finding, but these host requests do not prove the phone's HTTP response or the precise provider-console cause. App/key asset entitlement, correct Web SDK credential type and applicable origin/IP policy need review with Mappls; simply adding a hostname cannot yet be claimed sufficient. No provider settings or frontend source were changed. Map functionality must not be marked passed. Key values, application-account identifiers and location coordinates were not included in the diagnostic record, which is saved under ignored `.release-tools/device-test/mappls-authorization-check.json`.

Device evidence is local and ignored: `.release-tools/device-test/preinstall-verification.json`, `postinstall-verification.json`, installed APK backups, scoped sanitized startup logs and an app-only screenshot. Browser/account credential screens were not captured; screenshots were taken only after confirming ResQNow was foreground. Environment/key/token values were redacted before log persistence.

### Mappls credential correction — rebuild gate blocked, 2026-10-27

The owner reported the previous frontend credential did not match the **ResQNow Web Map** application, then saved a different client key in the ignored frontend environment. The owner's console view showed separate whitelist entries for `www.resqnow.org` and `localhost`. Application API allocations, including JavaScript map initialization and Places/Search-related entries, appeared Active; an empty SDK tab alone does not establish missing access. Private console screenshots/credential values were not copied into this document or sent to research tools. Backend `MAPPLS_REST_API_KEY` was left unchanged: inspected backend services use that variable independently from frontend `VITE_MAPPLS_MAP_SDK_KEY`.

The effective Vite production configuration passed the existing API validator: Railway origin correct, demo mode off, live-payment client mode retained, and required client variable names present without detected placeholders. The newly saved Mappls key was absent from the previous generated bundle, confirming it requires rebuilding to reach the installed APK. No key value was printed. Its format check found no whitespace, URL prefix, wrapping quotes or accidental environment assignment.

**Access gate remains BLOCKED:** SDK and Search script requests with APK and `www.resqnow.org` origins returned **401 / `BAD_REQUEST`**, with sanitized provider description **`Required String parameter 'domain' is not present`**. One browser-script-header SDK request returned 200/JavaScript, but a subsequent four-check browser-style run and a cache-bypassing SDK/Search run failed; the single success is insufficient to mark access reliable. Adding an explicit domain query/header did not resolve the observed rejection. These are build-host diagnostics, not a phone trace. A local mock-DOM inspection of installed `mappls-web-maps` **3.8.1** confirmed its actual initialization generates `/map/sdk/web?v=3.0&access_token=…`, matching the checked endpoint; the diagnostic used a placeholder, not the credential. The exact provider/credential cause is still unconfirmed. The owner was asked for the credential's **label only** to distinguish static Web SDK credentials from other credential types. No frontend SDK workaround or provider setting was guessed.

The owner subsequently confirmed the credential label is **Static Key**, matching the credential type specified by the Web SDK documentation. A loopback-only diagnostic page loaded this approved client key in memory and attempted the SDK and Search scripts in the in-app browser. Both script elements reported **failed**, with no map constructor loaded. This test used `http://localhost:4178`, not the APK's exact `https://localhost` origin; it is corroborating evidence, not an exact native-origin replay or a phone HTTP trace. No login or device location was requested, no credential URL/value was displayed, and raw browser logs were not printed. The sanitized page result is `.release-tools/device-test/mappls-real-browser-check.json`; the ignored diagnostic helper contains no credential literal. Static-key labeling alone therefore does not resolve the access gate. Mappls must confirm authorization/configuration for the intended Web SDK and native WebView origin; the precise source of the missing-domain response is still unconfirmed.

**Whitelist syntax investigation, 2026-10-27:** the public signed-out Mappls console application bundle (`https://auth.mappls.com/console/chunk-SG5EZIB4.js`, discovered through its public HTML/main routing bundle) splits the edit field on commas and trims each entry. Therefore `www.resqnow.org,localhost` uses the console's actual list delimiter. However, its declared `domainPattern` requires a dotted hostname with an alphabetic suffix: tests of that exact extracted pattern accepted `www.resqnow.org`/`resqnow.org` and rejected both `localhost` and `https://localhost`. The inspected edit validation condition can skip domain validation for nonempty input before saving, so separate saved whitelist entries do not establish that a hostname conforms to the console's declared validator. Earlier advice treating the saved localhost entry as confirmed correct was too definite. These public-client findings do **not** prove the authentication server applies the same rule or establish the precise cause of the missing-domain response. Confirm Mappls-supported authorization for the Capacitor `https://localhost` origin before changing native hostname/auth/CORS configuration; preserve the working website domain. No account endpoint or private console state was accessed for this investigation. Ignored evidence: `.release-tools/device-test/mappls-console-domain-syntax-check.json` and downloaded public bundles.

**Retest after full-origin whitelist entry, 2026-10-27:** the owner changed the saved whitelist to separate entries `www.resqnow.org` and `https://localhost`. Four fresh build-host requests using the effective saved frontend key and browser-script headers tested both SDK and Search for `https://localhost` and `https://www.resqnow.org`. **All four returned 401 / `BAD_REQUEST`, `Required String parameter 'domain' is not present`.** The production Vite validator still passed, Railway API origin remained correct and demo mode remained off. This whitelist spelling did not resolve the checked requests; no phone-network or end-to-end map success is established. No key was printed. Ignored report: `.release-tools/device-test/mappls-https-localhost-whitelist-check.json`.

No frontend build, Capacitor sync, Gradle build, signing or phone installation was performed during this correction attempt. The installed/live candidate remains the previously verified SHA-256 `b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`, which contains the earlier Mappls key. Resume rebuilding only after the effective approved key passes the required SDK/Search access checks; preserve prior signed APKs before Gradle packaging. Ignored sanitized diagnostics: `.release-tools/device-test/mappls-corrected-key-check.json`, `mappls-new-key-format-check.json`, `mappls-explicit-domain-check.json`, `mappls-header-diagnostic.json`, `mappls-browser-script-check.json` and `mappls-cache-bypass-check.json`.

### Notification and voice device acceptance — 2026-10-27

After the owner sent the Mappls support email, testing continued on the same authorized Galaxy A57 running the previously installed signed **1.3/code 4** live candidate. **Basic voice PASS (owner-confirmed):** the owner selected English, granted microphone access, spoke the supplied non-transactional sample and reported that the recognized words appeared and the assistant's spoken reply was audible. ADB independently confirmed `RECORD_AUDIO` granted afterward. This covers basic native speech recognition and TTS; Tamil/Tanglish, permission denial/recovery, offline support, extended conversations, AI fallback and request completion remain untested. No engineer audio recording, raw speech transcript collection or service submission was performed. Ignored record: `.release-tools/device-test/voice-basic-acceptance.json`.

**Basic notification acceptance PASS: permission, registration, foreground delivery, background delivery and notification-tap opening:** the owner enabled notifications in Android settings, and ADB confirmed both `POST_NOTIFICATIONS` and `RECORD_AUDIO` granted. A scoped restart (`am force-stop --user 0` for this package, then normal `MainActivity` launch) succeeded in 858 ms without clearing app data; an app-only screenshot showed the signed-in home screen afterward. The current-process log sample contained no native-push registration/sync markers and no fatal-exception marker; absent release logs do not prove registration failed. The subsequent scoped database retest below confirmed registration. Ignored initial record: `.release-tools/device-test/notification-registration-check.json`.

The inspected native `useFCM` path requests permission, registers through the Capacitor push plugin and sends the token to `/api/notifications/register-token`; `FCMWrapper` is mounted in `App.tsx`. The initial local Firebase Admin check established credential-field presence and a project match with the native Firebase project; the later successful test send below also verified local sender authentication. Deployed Railway Firebase Admin settings remain uninspected. The owner supplied the test account identity privately for a scoped lookup. The one-device test helper's database connection was rejected with **`ER_ACCESS_DENIED_ERROR` before any account/token SELECT, controlled registration capture or FCM send**. No notification was sent and no recipient token was selected. The helper uses direct database SELECTs without calling application bootstrap/migration functions, and requires exactly one owner-account token refreshed during a controlled phone restart before sending a harmless one-recipient test. Credentials, account identity and tokens are omitted from output/reports. No Railway CLI or connector was available to retrieve current settings. The owner was asked to update approved local backend database settings (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, existing TLS settings) without sharing values in chat. Do not claim Firebase delivery or Railway-to-FCM dispatch passed from the permission grant. Ignored records/helpers: `.release-tools/device-test/push-foreground-test.json`, `notification-sender-prerequisites.json`, `account-email.txt` and `.release-tools/test-own-device-push.mjs`.

**Successful sender retest after the owner's database update:** the local database connection succeeded. TiDB rejected the helper's optional `START TRANSACTION READ ONLY` statement with `ER_NOT_SUPPORTED_YET`; an isolated probe confirmed `SELECT 1` passed while that transaction mode failed. The ignored helper was corrected to use individual **SELECT statements only**, without bootstrap/migration or database-write statements. It uniquely matched the owner-supplied account, found one prior registration and observed **exactly one token refreshed during a controlled restart of the authorized phone**. Firebase Admin accepted one high-priority, 60-second-TTL foreground test titled **“ResQNow device test”**, with neutral test text, `event=device_test`, `deepLinkPath=/`, channel `updates`, and exactly one recipient. The locally configured Firebase Admin credential therefore authenticated and submitted this message successfully; receipt acceptance alone does not prove device delivery, and deployed Railway Firebase Admin settings remain uninspected. No real job, dispatch, payment or broadcast was created. The owner requested one resend, which Firebase also accepted for the uniquely refreshed phone registration; the owner then confirmed seeing the test notification. The earlier sender result was archived before resending. Current sanitized result: `.release-tools/device-test/push-foreground-test.json`; account identity, recipient token, private keys and message ID were not printed.

**Background/tap acceptance completed:** a separate one-recipient test repeated the guarded account/token identification, pressed Home and confirmed ResQNow was **not foreground at send time**. Firebase accepted the test; the owner confirmed it appeared and tapping it opened ResQNow normally. A fresh ADB check independently confirmed the app running and foreground after the tap, **1.3/code 4**, microphone/notification permissions granted, and no fatal-exception marker in the bounded current-process log sample. This is basic English voice and generic FCM acceptance on this Galaxy A57, not exhaustive stability, lock-screen/Doze/reboot, technician full-screen ringing, job/dispatch, business-event deep-link or deployed Railway sender certification. No real job, dispatch, payment, broadcast, APK rebuild or installation occurred during these tests. Maps remain blocked by the separate Mappls issue. Ignored records: `.release-tools/device-test/push-foreground-test.json`, `push-background-test.json`, `notification-final-device-check.json` and `voice-basic-acceptance.json`. The temporary account-email file created for targeting was removed after completion; account/token/private-key values remain absent from reports and this document.

**Short locked-screen acceptance PASS:** the next one-recipient test confirmed the phone's keyguard showing, screen off, interactive state sleeping and ResQNow in the background before sending. Samsung reported `mWakefulness=Dozing`; the first attempt conservatively required Asleep and stopped without sending. After independently observing `SCREEN_STATE_OFF` / `INTERACTIVE_STATE_SLEEP` / keyguard showing, the ignored helper was adjusted to accept Asleep or Dozing only with those additional guards. The owner unlocked the phone and returned to the app for a fresh guarded attempt. Firebase accepted the test; the owner confirmed receiving it while locked and normal opening after unlock/tap. ADB independently confirmed ResQNow foreground afterward. This short test does not certify prolonged Doze, force-stopped delivery, reboot recovery or technician full-screen job alarms. Ignored records: `.release-tools/device-test/push-locked-screen-test.json` and the preserved initial guard-stop record. The temporary account-email targeting file was removed again. No credentials, account identity or token values were printed.

**Next technician phase prepared, not yet accepted:** the owner has a technician test account and one phone. Use the computer for the customer side and the phone for the technician side if an isolated end-to-end scenario is subsequently authorized. Narrow inspection of `routes/service_requests.js` confirmed direct selection normally notifies the selected technician, but its dispatch-error fallback can search other technicians, and rejection can reassign through `jobMatcher.findBestMatch`; direct booking alone therefore does not guarantee test-recipient isolation. No request was submitted. The existing deep link `resqnow://auth/technician/login` resolves through the verified app route handler to `/technician/login`; opening it via ADB returned Status ok. The owner was asked to sign in on the phone, keep availability Offline and report the outcome. Login/dashboard, native job-alert readiness and a controlled isolated dispatch scenario remain pending. Do not collect passwords/OTPs or create a live job without an explicitly approved, concrete recipient-isolation plan.

**Technician authentication blocked by forgotten password:** the owner could not continue technician sign-in because the test-account password was forgotten. The inspected technician login UI and technician routes did not expose a self-service forgot-password flow. Existing source does provide an authorized admin edit path: `PUT /api/technicians/:id/profile` uses `verifyAdmin`, bcrypt hashing and an admin action audit; `src/pages/adminPortal/pages/TechnicianFormPage.tsx` exposes **New password** / **Confirm password** in edit mode. The owner can reset the test account through that admin UI, reviewing the existing profile because this is a whole-profile update form. Enter and save the new password directly in the UI, then sign in on the phone; do not request passwords/OTPs in chat. No password/hash was read, changed or printed, and no account was created. Technician login/alert-readiness acceptance remains pending.

Inspected `routes/notifications.js` exposes token registration/removal, not a self-test delivery endpoint; admin announcement/broadcast routes are unsuitable for a one-phone test. The test sender invokes Firebase Admin locally, so it does not certify a production Railway business-event-to-FCM flow. Delivery testing must target only the owner's confirmed device, without broadcasting or generating a real job. `src/pages/Notifications.tsx` currently renders hardcoded sample entries; seeing the Updates page is not push-delivery evidence. No application code was changed during these checks.

### Website APK publication — 2026-10-27

The owner explicitly stopped device testing and requested publishing the existing signed **1.3/code 4** live-payment candidate for website download. Fresh `apksigner verify --verbose --print-certs`, `zipalign -c -P 16 4`, `aapt dump badging`, and `python .release-tools/verify-resqnow-release.py --live` checks passed: package `com.resqnow1.app`, non-debuggable, original certificate SHA-256 `3874c317a48dcd014c0665786a139246890bb0f951561097eb7d2d732bcf6826`, 236 bundled frontend files matching the build manifest, Railway selected, demo off and existing native plugins preserved. No rebuild, signing-key change or further device testing was performed.

`public/downloads/resqnow.apk` now contains **15,928,619 bytes**, SHA-256 `b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`, copied from `../resqnowfrontend/android/app/build/outputs/apk/release/resqnow-1.3-railway-live-release.apk`. The prior website **1.2/code 3** APK was preserved and hash-verified at `../.release-tools/artifacts/website-before-1.3/resqnow-1.2-code3.apk` (SHA-256 `eda7a5b77e05f9aa774dc7c9b68c83c467517519500834f155840a472db5ff8f`). A fresh production status/download before publication confirmed that same old hash and `source=backend_public_downloads`.

The documented Railway release route tracks GitHub `main`. After `git fetch origin main`, the current remote parent was `94a99bb81e07691afc0096f81894e5e767322447`, including newer backend voice work. An isolated Git index based on that parent created commit `4423940c6b5990394ff05489c36948ec2a5e8d84`, changing **only** `public/downloads/resqnow.apk`; a normal non-forced push to `origin/main` succeeded. Local branches, the regular index, frontend changes, credentials and this accumulated context document were excluded from that commit. Railway initially could not be opened because automatic browser approval review reached a usage limit; retry succeeded but showed the Railway login screen. No Railway credentials/settings were changed. Public download/deployment verification remains pending at this entry's creation; do not equate the successful Git push with a verified live APK. Ignored publication record: `../.release-tools/website-publication.json`.

After the owner signed in directly, Railway settings confirmed source/upstream `janeshkrish/resqnowbackend`, branch `main`, **automatic deploy disabled**, Dockerfile builder, `npm start`, and `/ready` health check. Therefore pushing alone did not deploy. **Check for updates** detected a newer upstream version; **Update → Yes** requested the authorized manual update. The subsequently used **Deploy latest commit** command started a duplicate build, which was aborted through its own deployment menu and confirmed **REMOVED** (`b43c0bc9-2679-4c76-8351-33daaeb44bc6`). The retained deployment `80a94398-d68d-43e7-abf2-26a4affc10b7` reached health checks; its Details panel linked exactly to commit `4423940c6b5990394ff05489c36948ec2a5e8d84` and confirmed Dockerfile, `npm start`, one replica and `/ready`. Automatic deployment stayed disabled. Deployment completion and the served APK hash still require verification.

Known limitations remain accepted for this distribution request: Mappls access is unresolved and this binary contains the earlier Mappls key, rather than the newly saved local key. Technician sign-in/account recovery, admin technician edit, isolated dispatch, tracking and real-payment acceptance remain incomplete. The stuck admin edit UUID diagnosis was paused without implementing a source fix. Publishing this APK does not certify production readiness.

**Publication PASS:** Railway's retained deployment Details panel subsequently showed **Active / Deployment successful** for `80a94398-d68d-43e7-abf2-26a4affc10b7`. The public status endpoint returned `available=true`, `source=backend_public_downloads`, **15,928,619 bytes**. A fresh cache-bypassing GET of `/api/public/android-app/download?release=4423940` saved `../.release-tools/artifacts/resqnow-1.3-website-downloaded.apk` and verified SHA-256 **`b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`**, identical to the signed live candidate. Post-deployment `/health` returned `OK`; `/ready` returned `ok=true`, `database.ready=true` and no maintenance mode; `/api/public/stats` returned normally. Reports: `../.release-tools/logs/website-publication-status.json`, `website-publication-readiness.json`, and screenshot `website-publication-success.jpg`.

The public website's mobile layout shows **Get the ResQNow app → Download**. Its served entry `/assets/index-Cf87_Zi8.js` selects the Railway URL explicitly and its button uses the same `/api/public/android-app/download` path. The desktop landing layout does not show that card. An automated browser click did not produce the tool's download event before timeout, so browser-saved download acceptance is not claimed; endpoint GET/download integrity and the website's configured destination are verified independently. No website frontend deployment was needed. Existing download responses permit five minutes of browser caching; the versioned direct link above avoids reusing an earlier URL's cached APK. Further device tests remain stopped.

## 24. Update-System Readiness

Current readiness is low. The backend can distribute one Android APK and report size/mtime, but has no semantic version, build number, channel, minimum-supported version, force/optional policy, cryptographic checksum/signature metadata, compatibility window, rollout, client acknowledgement or rollback manifest. The APK is a tracked binary and distribution appears manual.

**Verified effective distribution, 2026-10-27:** the preflight initially served **1.2/code 3**, SHA-256 `eda7a5b77e05f9aa774dc7c9b68c83c467517519500834f155840a472db5ff8f`. The later owner-authorized publication in section 23 replaced it with signed **1.3/code 4**, **15,928,619 bytes**, GET SHA-256 `b2618f50d726c17a623823877a98ab44f74b690212ea03b2f674f0659282216e`. Live `/api/public/android-app/status` resolves `source=backend_public_downloads` at `/app/public/downloads/resqnow.apk`; no override candidate is selected, which does not prove override variables are unset. Cache-Control is `public, max-age=300, must-revalidate`. The prior file is backed up; no OTA/client update mechanism was added.

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

- Distribution history outside the verified direct APK endpoint, including whether Android version code 4 or higher has been published elsewhere; sibling mobile source location/version is now verified in section 7.
- Where web and mobile store JWTs and how deep links are verified.
- Actual Render/other production topology, number of API/worker instances and process supervision.
- Production MySQL/TiDB and Redis providers, regions, TLS certificates, backups, restore tests and retention.
- DNS, TLS termination, WAF/CDN, firewall and network isolation.
- CI/CD system, protected branches, review/release gates and artifact provenance.
- Play Store/App Store/internal distribution status, signing-key backup/recovery custody and versioning policy; Android package ID and availability of the matching local release private key are now verified in section 7.
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

