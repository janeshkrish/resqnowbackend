# ResQNow Backend

Production-ready Node.js + Express backend for the ResQNow roadside assistance platform.

## Description

This service handles user authentication, technician onboarding, dispatch workflows, payments, invoices, notifications, and public utility APIs.

## Features

- JWT auth for users, technicians, and admins
- Google OAuth sign-in callback flow
- Technician onboarding and approval lifecycle
- Service request creation, matching, assignment, and status transitions
- Razorpay payments for booking, registration, subscriptions, and dues
- Invoice PDF generation and email notifications
- Real-time updates with Socket.IO
- Public APIs for stats, contact form, and reverse geocoding
- Health and readiness probes for deployment platforms

## Installation

1. Clone repository.
2. Enter backend directory:

```bash
cd resqnowbackend
```

3. Install dependencies:

```bash
npm install
```

4. Configure environment variables in `.env`.

## Environment Variables

### Required

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_SSL` (set `true` for managed cloud DBs)
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `EMAIL_USER`
- `EMAIL_PASS`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `FRONTEND_URL`

### Production (Render + Vercel)

- `BACKEND_URL=https://resqnowbackend.onrender.com`
- `BACKEND_PUBLIC_URL=https://resqnowbackend.onrender.com`
- `FRONTEND_URL=https://resqnow.org`
- `FRONTEND_PUBLIC_URL=https://resqnow.org`
- `GOOGLE_CALLBACK_URL=https://resqnowbackend.onrender.com/auth/google/callback`
- `CORS_ALLOWED_ORIGINS=https://resqnow.org,https://www.resqnow.org`

## Run

### Development

```bash
npm run dev
```

### Build Check

```bash
npm run build
```

### Production

```bash
npm start
```

## API Endpoint Overview

Base prefix: `/api`

- `POST /api/admin/login`
- `GET /api/admin/analytics`
- `GET /api/admin/notifications`
- `GET /api/auth/google/url`
- `GET /api/auth/google/callback`
- `GET /api/auth/verify`
- `GET /api/auth/me`
- `POST /api/users/send-otp`
- `POST /api/users/verify-otp`
- `POST /api/users/login`
- `POST /api/technicians/register`
- `POST /api/technicians/login`
- `GET /api/technicians/public-list`
- `GET /api/technicians/nearby`
- `GET /api/service-requests`
- `POST /api/service-requests`
- `POST /api/service-requests/:id/payment-order`
- `POST /api/payments/create-order`
- `POST /api/payments/confirm`
- `POST /api/payments/razorpay/webhook`
- `GET /api/payments/config`
- `GET /api/public/stats`
- `POST /api/public/contact`
- `GET /health`
- `GET /ready`

## Folder Structure

```text
resqnowbackend/
  config/         # CORS, origin policy, URL helpers
  middleware/     # Auth middlewares and token helpers
  routes/         # Route modules (auth, users, technicians, payments, etc.)
  services/       # Business/domain services
  uploads/        # Optional static assets (legacy/non-critical)
  scripts/        # Build and maintenance scripts
  db.js           # MySQL connection pool + schema assurance
  index.js        # App bootstrap, startup, routes, health checks
  loadEnv.js      # Environment file loader
```

## Testing Instructions

No dedicated automated test suite is currently committed.

Run validation commands:

```bash
npm run build
npx depcheck
```

Runtime smoke checks:

```bash
npm start
# then verify /health and /ready
```

## Contribution Guide

1. Create a feature branch.
2. Keep changes scoped and backward-compatible where possible.
3. Run `npm run build` before opening PR.
4. Update docs for any endpoint or env changes.
5. Open PR with change summary and validation notes.

## License

UNLICENSED (private project).
