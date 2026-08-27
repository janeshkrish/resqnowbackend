# ResQNow Backend

ResQNow Backend is the Node.js and Express API service for the ResQNow roadside assistance platform. It powers customer authentication, technician onboarding, service request dispatch, pricing, payments, invoices, notifications, marketplace finance workflows, location utilities, and administrative operations.

This repository contains only the backend API, database bootstrap logic, workers, services, controllers, routes, migration scripts, and operational utilities. The React/Vite frontend lives in the separate `resqnowfrontend` repository.

## Proprietary Notice

This project is proprietary and confidential. Unauthorized copying, modification, redistribution, commercial usage, reproduction, or publication of this repository or any part of its codebase is strictly prohibited.

Forking, downloading, cloning, redistributing, sublicensing, reselling, or reusing any part of the codebase without explicit written permission from the owner is not allowed. The code is provided only for authorized review and demonstration purposes. Any unauthorized access, use, distribution, or reproduction may result in legal action.

## Features

- JWT authentication for users, technicians, and admins.
- Google OAuth URL and callback flow.
- OTP-based user authentication.
- Technician registration, login, profile, availability, location, settings, verification, approval, rejection, and audit history.
- Technician fleet vehicle and employee/team management.
- Service request creation, matching, assignment, cancellation, technician status updates, timeline events, invoices, and towing workflow validation.
- Queue-backed dispatch workflow with BullMQ and Redis.
- Real-time customer, technician, and admin updates through Socket.IO and selected server-sent notification streams.
- Razorpay orders, confirmations, subscriptions, registration payments, dues, cash payment settlement, refunds, diagnostics, and webhooks.
- Platform pricing, technician pricing normalization, towing estimates, and route-aware pricing support.
- Marketplace wallets, withdrawal requests, payouts, payout allocations, refunds, and finance audit workflows.
- Admin dashboard, analytics, command center, notifications, complaints, payments, payouts, users, technicians, and email templates.
- Public APIs for platform stats, contact form, Android APK availability, location search, reverse geocoding, and route calculation.
- Firebase Admin-based push notification delivery.
- Email delivery through Resend and SMTP-compatible configuration.
- Database schema assurance at startup and migration SQL scripts for operational changes.
- Health and readiness probes for deployment platforms.

## Tech Stack

- Node.js with ECMAScript modules
- Express 4
- MySQL/TiDB through `mysql2`
- Socket.IO
- BullMQ and Redis
- Razorpay Node SDK
- Firebase Admin SDK
- Google Auth Library
- Resend and Nodemailer-compatible email configuration
- PDFKit for invoices
- Axios for provider integrations
- Native Node test runner
- Docker-compatible deployment

## Folder Structure

```text
resqnowbackend/
  config/                 # Environment validation, CORS, URL, OAuth callback helpers
  controllers/            # Admin, analytics, complaints, finance, notifications, requests
  middleware/             # Auth and admin access middleware
  models/                 # Domain constants and pricing models
  public/                 # Publicly served downloads and static files
  repositories/           # Data access helpers for marketplace and finance domains
  routes/                 # Express route modules
  scripts/                # Build check, email smoke test, SQL migrations
  services/               # Dispatch, pricing, notification, mail, wallet, route, invoice services
  tests/                  # Node test runner suites
  uploads/                # Runtime uploads, should not contain production customer data in git
  utils/                  # Utility helpers
  workers/                # Dispatch worker process
  db.js                   # MySQL pool, schema assurance, and schema migration helpers
  index.js                # Express app bootstrap, middleware, routes, health checks, startup
  loadEnv.js              # Environment file loader
  schema.sql              # Baseline schema reference
```

## Prerequisites

- Node.js 18 or newer.
- npm 9 or newer.
- MySQL-compatible database, preferably TiDB or MySQL 8.
- Redis for queue-backed dispatch in production.
- Razorpay account and webhook configuration.
- Google OAuth client.
- Firebase project/service account for push notifications.
- Email provider credentials for Resend and/or SMTP.
- A deployed frontend URL for CORS and OAuth redirects.

## Installation

```bash
git clone https://github.com/janeshkrish/resqnowbackend.git
cd resqnowbackend
npm install
```

Create a local environment file from the example:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Update `.env` with local, staging, or production values before starting the server.

## Environment Variables

### Required

| Variable | Description |
| --- | --- |
| `DB_HOST` | MySQL/TiDB host. |
| `DB_PORT` | Database port, commonly `4000` for TiDB or `3306` for MySQL. |
| `DB_USER` | Database user. |
| `DB_PASSWORD` | Database password. |
| `DB_NAME` | Database name. |
| `DB_SSL` | Set `true` for managed cloud databases that require SSL. |
| `JWT_SECRET` | Long random secret used to sign user, technician, and admin JWTs. |
| `ADMIN_EMAIL` | Admin login email. |
| `ADMIN_PASSWORD` | Admin login password. Store only in secret manager or `.env`. |
| `EMAIL_USER` | Email sender/auth user. |
| `EMAIL_PASS` | Email password or provider credential. |
| `SMTP_HOST` | SMTP host. |
| `SMTP_PORT` | SMTP port. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | Must be `true` or `false`. Use `true` in production. |
| `RAZORPAY_KEY_ID` | Razorpay key ID. |
| `RAZORPAY_KEY_SECRET` | Razorpay secret. Never expose to frontend. |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `GOOGLE_CALLBACK_URL` | Must match `<BACKEND_PUBLIC_URL>/auth/google/callback`. |
| `FRONTEND_URL` | Frontend origin used for redirects and CORS. |

### Recommended Production Variables

| Variable | Description |
| --- | --- |
| `NODE_ENV` | Set to `production`. |
| `PORT` | API port. Defaults to `5000` in code. |
| `DB_SSL_STRICT` | Set `true` when the database certificate chain is trusted and should be enforced. |
| `BACKEND_URL` | Public backend URL. |
| `BACKEND_PUBLIC_URL` | Public backend URL used for OAuth callback and logs. |
| `FRONTEND_PUBLIC_URL` | Public frontend URL. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated frontend/admin origins. |
| `REDIS_URL` | Required for queue-backed dispatch in production. |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signing secret. |
| `RESEND_API_KEY` | Resend API key for HTTP email delivery. |
| `EMAIL_FROM` | Email sender display value, for example `ResQNow <no-reply@example.com>`. |
| `CONTACT_RECEIVER_EMAIL` | Recipient for public contact form submissions. |
| `FIREBASE_PROJECT_ID` | Firebase project ID. |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email. |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key with escaped newlines. |

### Optional Operational Variables

| Variable | Default | Description |
| --- | --- | --- |
| `DISPATCH_WORKER_EMBEDDED` | `true` | Run dispatch worker inside web process. Set `false` when using a separate worker service. |
| `DISPATCH_WORKER_CONCURRENCY` | `8` | Dispatch queue worker concurrency. |
| `DISPATCH_OFFER_TIMEOUT_MS` | `10000` | Dispatch offer timeout. |
| `DISPATCH_RETRY_DELAY_MS` | `1500` | Delay between dispatch retries. |
| `DISPATCH_MAX_RETRIES` | `40` | Maximum dispatch retry count. |
| `DISPATCH_ETA_MATRIX_LIMIT` | `25` | Candidate limit for ETA matrix usage. |
| `TECHNICIAN_ACTIVITY_MONITOR_ENABLED` | `true` | Enables technician activity monitoring. |
| `TECHNICIAN_ACTIVITY_MONITOR_INTERVAL_MS` | `300000` | Activity monitor interval. |
| `TECHNICIAN_ACTIVITY_IDLE_TIMEOUT_MINUTES` | `45` | Technician idle timeout. |
| `TECHNICIAN_LOGIN_REMINDER_INACTIVITY_MINUTES` | `720` | Reminder inactivity threshold. |
| `TECHNICIAN_LOGIN_REMINDER_COOLDOWN_MINUTES` | `720` | Reminder cooldown. |
| `TECHNICIAN_LOGIN_REMINDER_BATCH_SIZE` | `100` | Reminder batch size. |
| `LOCATION_SEARCH_PROVIDER` | `nominatim` | Location search provider. |
| `LOCATION_SEARCH_COUNTRY_CODES` | `in` | Country filter for location search. |
| `LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE` | `45` | Public location search rate limit. |
| `REVERSE_GEOCODE_RATE_LIMIT_PER_MINUTE` | `60` | Reverse geocode rate limit. |
| `ROUTE_RATE_LIMIT_PER_MINUTE` | `60` | Route API rate limit. |
| `ROUTE_PROVIDER_TIMEOUT_MS` | `6500` | Route provider timeout. |
| `ROUTE_CACHE_TTL_MS` | `600000` | Route cache TTL. |
| `PRICING_CONFIG_CACHE_TTL_MS` | `30000` | Pricing config cache TTL. |
| `OTP_TTL_MINUTES` | `5` | OTP expiry. |
| `OTP_DEBUG_ROUTE_ENABLED` | `false` | Enables debug OTP route. Keep disabled in production. |
| `CORS_INCLUDE_LOCAL_ORIGINS` | environment-dependent | Include local origins in CORS allowlist. |
| `CORS_ALLOW_ALL` | `false` | Allows all origins. Do not use in production. |
| `CORS_ALLOW_LAN_ORIGINS` | environment-dependent | Allows LAN origins. |
| `CORS_ALLOW_TUNNEL_ORIGINS` | environment-dependent | Allows ngrok/Cloudflare tunnel origins. |
| `CORS_ALLOW_VERCEL_ORIGINS` | `false` | Allows generic Vercel preview origins. |
| `ANDROID_APK_PATH` / `APK_PATH` | unset | Explicit APK file path for public download endpoint. |
| `ANDROID_APK_RELEASE_DIR` / `APK_RELEASE_DIR` | unset | Directory used to locate APK release file. |
| `ANDROID_APK_FILE_NAME` / `APK_FILE_NAME` | `resqnow.apk` | APK file name for public download. |

## API Configuration

The backend mounts routes under `/api` and also exposes a Google OAuth callback compatibility route under `/auth`.

Primary route groups:

| Prefix | Purpose |
| --- | --- |
| `/api/auth` and `/auth` | Google OAuth, token verification, current user, logout. |
| `/api/users` | OTP, login, profile/settings, reviews. |
| `/api/technicians` and `/api/technician` | Technician auth, onboarding, status, location, jobs, fleet, team, wallet, withdrawals, approvals. |
| `/api/service-requests` and `/api/requests` | Customer service request lifecycle, technician status, cancellation, invoices, payment helpers. |
| `/api/payments` | Razorpay orders, quotes, confirmation, cash flow, diagnostics, subscriptions, webhooks. |
| `/api/pricing` | Pricing calculations and towing estimates. |
| `/api/public` and selected `/api/*` aliases | Public stats, contact, location search, reverse geocode, route, Android APK status/download. |
| `/api/vehicles` | User vehicles. |
| `/api/upload` | Upload handling. |
| `/api/chatbot` | Chatbot message endpoint. |
| `/api/notifications` | Device token registration and notification cleanup. |
| `/api/jobs` | Technician job acceptance. |
| `/api/admin` | Admin dashboards, requests, technicians, users, finance, analytics, notifications, complaints, dispatch audit. |
| `/api/admin-extended` | Extended admin dashboards, requests, technicians, finance, analytics, notifications, complaints. |
| `/api/admin/command-center` | Operations command center exceptions, tracks, actions, and monitor trigger. |
| `/health` | Liveness probe. |
| `/ready` | Readiness probe with database bootstrap state. |

Razorpay webhook route:

```text
POST /api/payments/razorpay/webhook
```

This route receives a raw body before JSON parsing so signature verification works correctly.

## Running Locally

Start the API in development mode:

```bash
npm run dev
```

Start the API in production mode:

```bash
npm start
```

By default, the server listens on:

```text
0.0.0.0:5000
```

Use `PORT` to override.

Run the dispatch worker separately:

```bash
npm run worker:dispatch
```

When using a separate worker process, set this on the web service:

```env
DISPATCH_WORKER_EMBEDDED=false
```

## Available Scripts

| Script | Description |
| --- | --- |
| `npm start` | Start the Express server. |
| `npm run dev` | Start the Express server with Node watch mode. |
| `npm run build` | Run syntax/build validation through `scripts/build-check.mjs`. |
| `npm run worker:dispatch` | Start the BullMQ dispatch worker. |
| `npm run email:test` | Run email smoke test. |
| `npm run test:technician-pricing` | Run technician pricing tests. |
| `npm run test:towing-phase2` | Run towing workflow tests. |

## Database Setup

The backend validates database configuration at startup, opens a MySQL pool, creates/assures required tables, applies schema update helpers, and backfills selected marketplace wallet data.

Reference files:

- `schema.sql` for baseline schema.
- `db.js` for runtime table assurance and schema update helpers.
- `scripts/migrations/` for dated SQL migrations.

Use a dedicated database per environment. Do not point local development at production data.

## Build and Deployment

### Build Check

```bash
npm run build
```

This validates JavaScript syntax across the backend source tree.

### Docker

The repository includes a basic `Dockerfile`.

```bash
docker build -t resqnowbackend .
docker run --env-file .env -p 5000:5000 resqnowbackend
```

The Dockerfile currently exposes port `3001`, while the application defaults to `5000`; set `PORT` explicitly or align the Dockerfile before production use.

### Render-Style Deployment

Recommended web service command:

```bash
npm start
```

Recommended worker service command:

```bash
npm run worker:dispatch
```

Recommended production values:

```env
NODE_ENV=production
BACKEND_URL=https://your-backend.example.com
BACKEND_PUBLIC_URL=https://your-backend.example.com
FRONTEND_URL=https://your-frontend.example.com
FRONTEND_PUBLIC_URL=https://your-frontend.example.com
GOOGLE_CALLBACK_URL=https://your-backend.example.com/auth/google/callback
CORS_ALLOWED_ORIGINS=https://your-frontend.example.com,https://www.your-frontend.example.com
DISPATCH_WORKER_EMBEDDED=false
```

Configure the same callback URI in Google Cloud OAuth authorized redirect URIs:

```text
https://your-backend.example.com/auth/google/callback
```

### Health Checks

Use:

```text
GET /health
GET /ready
```

`/health` confirms the HTTP server is alive. `/ready` confirms database bootstrap status.

## Screenshots

Backend repositories typically do not include UI screenshots. Add API/architecture screenshots or admin workflow screenshots if required by stakeholders.

| Area | Placeholder |
| --- | --- |
| API health/readiness | `docs/screenshots/api-health.png` |
| Admin command center data flow | `docs/screenshots/admin-command-center.png` |
| Dispatch workflow diagram | `docs/screenshots/dispatch-workflow.png` |
| Payment confirmation lifecycle | `docs/screenshots/payment-lifecycle.png` |

## Quality Checks

Recommended before every pull request:

```bash
npm run build
npm run test:technician-pricing
npm run test:towing-phase2
npm audit
```

Current validation status from the latest local review:

- `npm run build`: passes.
- `npm run test:technician-pricing`: passes.
- `npm run test:towing-phase2`: passes.
- `npm audit`: currently reports vulnerable dependencies that should be triaged before production release.

## Repository Security Recommendations

- Keep this repository private for maximum protection.
- Disable forking if GitHub plan and repository settings allow it.
- Restrict collaborator permissions to least privilege.
- Protect the `main` or `master` branch.
- Require pull requests and CODEOWNERS review for protected branches.
- Require signed commits.
- Enable Dependabot alerts and security updates.
- Enable secret scanning and push protection.
- Keep `.env` files untracked.
- Do not commit runtime uploads, APK artifacts, logs, database dumps, or credentials.
- Rotate any key that was ever committed, shared, or packaged into a public artifact.
- Store production secrets only in deployment platform secret managers.
- Keep `CODEOWNERS`, `SECURITY.md`, `CONTRIBUTING.md`, and `LICENSE.md` current.

## Contributing

This is a private proprietary project. Contributions are accepted only from authorized collaborators.

1. Create a feature branch from the protected base branch.
2. Keep changes scoped to one feature or fix.
3. Update documentation when routes, environment variables, workflows, database schema, or deployment steps change.
4. Add or update tests for pricing, dispatch, payments, auth, and request lifecycle changes.
5. Run the quality checks listed above.
6. Open a pull request with a clear summary and validation notes.
7. Do not commit secrets, `.env` files, production credentials, upload artifacts, database exports, APK files, or customer data.

See `CONTRIBUTING.md` for detailed internal contribution rules.

## License

This repository is not open source. All rights are reserved by the owner.

See `LICENSE.md` for the proprietary license terms.

## Author

ResQNow

Owner/Maintainer: Janesh Krish

GitHub: `@janeshkrish`

Project: ResQNow roadside assistance platform
