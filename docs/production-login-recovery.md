# Production startup and mobile OTP recovery

## Confirmed diagnostics on 2026-10-19

- GitHub run `39246563259`, commit `1e6835a`: tests/build passed; the signed-in deploy log confirms missing Render and SQL settings in GitHub. The workflow incorrectly targeted Render although production uses Railway.
- The supplied startup log shows a required legacy TiDB transfer blocked by the maintenance guard.
- The obsolete repository-default Render URL returned a suspension page. The actual production frontend already points at Railway. Railway's `/ready` returns HTTP 503 with the TiDB maintenance guard error. Follow [the Railway migration procedure](railway-tidb-deployment.md); the historical Render recovery steps below do not apply to the current service.
- The configured Firebase web project's public `projects` and `recaptchaParams` endpoints returned `CONFIGURATION_NOT_FOUND`. The Firebase console showed Authentication's **Get started** screen and the **Spark** plan. FCM configuration alone does not initialize Authentication.

Recovery configuration applied during this session: Authentication initialized, Phone provider enabled, `resqnow.org` and `www.resqnow.org` authorized, and SMS region policy set to allow India. The public project configuration and reCAPTCHA endpoint then responded successfully. Identity Toolkit returns this project's numeric project number; the diagnostic now compares it with the configured Firebase sender/project number instead of falsely treating it as a different project. The billing plan remains Spark. Real SMS delivery and the final token exchange have not yet been verified.

Database readiness and Firebase SMS setup are independent blockers.

## Restore the API safely

1. Follow [the Railway procedure](railway-tidb-deployment.md). Pause automatic deployment, deploy the maintenance-only start command, and verify that the old API/worker deployment is removed.
2. Verify the complete source against the independent backup. Use the full-preservation migration to retain every source record and legacy module in a separate target. Keep unresolved historical identities disabled; do not guess live ownership.
3. Require target count/content verification and strict relationship validation before publishing the database.
4. Restore `npm start`, use `/ready` for Railway's health check, and leave startup `DB_MIGRATION_MAINTENANCE=false`. Do not bypass the guard with `DB_MIGRATION_MODE=off` or enable startup migration while old writers run.
5. Require `/ready` to return HTTP 200 with `ok: true` and `database.ready: true`. Restore automatic deployments and preserve the original database and independent backup.

## Enable real SMS OTP

In Firebase project **resqnow-f697d**:

1. Open Authentication and choose **Get started**.
2. Enable the **Phone** sign-in provider. Firebase requires billing for real verification SMS; an account owner must approve any Blaze upgrade/billing link. Do not treat fictional test numbers as proof of SMS delivery.
3. Under Authentication > Settings, authorize both `resqnow.org` and `www.resqnow.org`. Under the SMS region policy, permit India (`IN`). Review quotas and spend limits.
4. Confirm the frontend hosting build settings contain matching `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. These are embedded at build time; rebuild/redeploy after changes. Push messaging settings are separate from phone login.
5. Configure Firebase Admin on Railway for the same project using `FIREBASE_SERVICE_ACCOUNT_JSON` (or the existing supported individual credential fields). Keep the private key exclusively on the backend. If token exchange reports `invalid_grant` with an iat/exp timeframe error, check the calling host's UTC clock before rotating credentials.
6. Verify on the production domain: enter a real mobile number, receive the SMS, submit its six digits, supply a name for a new customer, and confirm a ResQNow session. Check that wrong/expired codes are rejected and resend is throttled. This also validates the server's token verification, database schema and JWT configuration.

Firebase sends and validates the SMS in the browser. Only after verification does the frontend POST the Firebase ID token to `/api/users/phone-login`; the backend issues the ResQNow session. Email OTP routes do not send mobile SMS.

Official setup: [Firebase web phone authentication](https://firebase.google.com/docs/auth/web/phone-auth), [Authentication limits and billing](https://firebase.google.com/docs/auth/limits).

## Read-only checks

From `resqnowbackend` with existing local environment files:

```powershell
npm.cmd run production:check-login -- --frontend-env ../resqnowfrontend/.env
```

Alternatively set `FIREBASE_WEB_API_KEY` and `FIREBASE_PROJECT_ID` in the diagnostic environment, together with `BACKEND_PUBLIC_URL` and `FRONTEND_URL`. No key values are printed. Run once with each frontend domain to check authorization.

The checker sends no SMS and changes no cloud settings. It exits nonzero for an unavailable API, uninitialized Firebase, an unauthorized domain or unavailable reCAPTCHA configuration. Passing it does not certify phone-provider enablement, billing, region policy, backend Firebase Admin credentials, or delivery; complete the real-device test above.
