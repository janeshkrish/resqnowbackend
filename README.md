# ResQNow Backend

Node.js + Express backend for the ResQNow roadside assistance platform.  
It powers technician onboarding, user authentication, service request dispatching, payments, notifications, uploads, and admin operations.

## Features

- User auth (OTP + Google OAuth callback flow)
- Technician onboarding, profile management, approval workflow
- Service request lifecycle (create, assign, accept, status updates, cancel)
- Payment flows with Razorpay (registration, service, subscription, dues)
- Admin analytics, dispatch diagnostics, and operational endpoints
- Socket.IO support for real-time updates
- File upload/storage via MySQL BLOBs
- PDF invoice generation and email delivery
- Public endpoints (contact form, reverse geocoding, basic stats)

## Installation

1. Clone the repository.
2. Open the backend folder:
   ```bash
   cd resqnowbackend
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create/update environment variables in:
   ```text
   .env
   ```
   Note: `loadEnv.js` auto-detects `.env` in the current project root first.

## Environment Variables

### Required

- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_PORT`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `EMAIL_USER`
- `EMAIL_PASS`

### Optional / Feature-Specific

- `DB_SSL`
- `DB_SSL_STRICT`
- `PORT`
- `BACKEND_URL`
- `BACKEND_PUBLIC_URL`
- `FRONTEND_URL`
- `FRONTEND_PUBLIC_URL`
- `CORS_ALLOWED_ORIGINS`
- `CORS_ALLOW_ALL`
- `CORS_ALLOW_LAN_ORIGINS`
- `CORS_ALLOW_TUNNEL_ORIGINS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`
- `OSRM_URL`
- `DISPATCH_ETA_MATRIX_LIMIT`
- `PRICING_CONFIG_CACHE_TTL_MS`

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

### Health Check

```text
GET /health
GET /ready
```

## API Endpoint Overview

Base path prefix: `/api`

- `POST /api/admin/login`
- `GET /api/admin/analytics`
- `GET /api/admin/notifications`
- `POST /api/admin/dispatch-retry/:requestId`

- `GET /api/auth/google/url`
- `GET /api/auth/google/callback`
- `GET /api/auth/verify`
- `GET /api/auth/me`

- `POST /api/users/send-otp`
- `POST /api/users/verify-otp`
- `POST /api/users/login`
- `PUT /api/users/:id`

- `POST /api/technicians/register`
- `POST /api/technicians/login`
- `GET /api/technicians/me`
- `PATCH /api/technicians/me/status`
- `PATCH /api/technicians/:id/approve` (admin)

- `GET /api/service-requests`
- `POST /api/service-requests`
- `POST /api/service-requests/:id/accept`
- `PATCH /api/service-requests/:id/status`
- `POST /api/service-requests/:id/payment-order`

- `POST /api/payments/create-registration-order`
- `POST /api/payments/verify-registration-payment`
- `POST /api/payments/create-service-order`
- `POST /api/payments/verify-service-payment`
- `GET /api/payments/config`

- `GET /api/vehicles`
- `POST /api/vehicles`
- `DELETE /api/vehicles/:id`

- `POST /api/upload`
- `GET /api/upload/files/:filename`

- `GET /api/public/stats`
- `POST /api/public/contact`
- `GET /api/public/reverse-geocode`

- `POST /api/chatbot/message`

## Folder Structure

```text
resqnowbackend/
  config/         # Network/CORS configuration
  middleware/     # Auth middleware and token helpers
  routes/         # Express route modules grouped by domain
  server/
    uploads/      # Generated invoice PDFs
  services/       # Business logic (dispatch, pricing, mail, socket, invoices)
  uploads/        # Legacy/static upload artifacts
  db.js           # MySQL pool + schema assurance/migrations
  index.js        # App bootstrap + route mounting
  loadEnv.js      # Loads .env (project root) when present
  schema.sql      # SQL schema snapshot
```

## Render Deployment Notes

- Build command: `npm run build`
- Start command: `npm start`
- Health check path: `/ready`
- Set `FRONTEND_URL=https://reqnow.org`
- Set `FRONTEND_PUBLIC_URL=https://reqnow.org`
- Optionally set `CORS_ALLOWED_ORIGINS=https://reqnow.org,https://www.reqnow.org`

## Testing Instructions

No dedicated automated test suite is committed currently.  
Recommended validation steps:

1. Syntax check:
   ```bash
   rg --files -g "*.js" -g "!node_modules/**" | % { node --check $_ }
   ```
2. Unused/consistency checks:
   ```bash
   npx depcheck
   npx knip
   ```
3. Run server and verify:
   - Start with `npm run dev`
   - Hit `GET /health`
   - Smoke test key API flows (auth, technician login, service request create)

## Contribution Guide

1. Create a feature branch.
2. Keep changes scoped and consistent with existing patterns.
3. Run the validation steps above before opening a PR.
4. Include endpoint/behavior changes in this README when relevant.
5. Submit PR with:
   - What changed
   - Why it changed
   - How it was verified

## License

`UNLICENSED` (private project).
