# BUG-03: Customer and technician password recovery

Reference: root `QA_REPORTED_BUGS_ANALYSIS.md`, BUG-03. This implements the report's email-link approach without reusing signup OTPs.

## Customer and technician behavior

- Customers use **Forgot password** on email login. Technicians now have the same action on technician login. Each opens its own account-type recovery page.
- Enter an email to request a link. The response is the same for eligible, unknown, unverified and passwordless accounts. A reset link is sent only for a password account with a verified recovery email matching its current contact email.
- Follow the link, enter and confirm a new password, then sign in normally. Passwords require at least 12 characters after trimming for length validation, with a maximum of 72 UTF-8 bytes. The password itself is not trimmed or truncated.
- Links expire in 15 minutes, work once, and are replaced by a later eligible resend. A customer token cannot reset a technician account, even when both have the same email.
- A reset revokes old customer/technician REST and native-tracking tokens, disconnects live sockets, and removes that account's push registrations. It preserves job ownership, technician approval/activity fields, subscriptions, payments and accounting. There is no automatic sign-in.

## Recovery email prerequisite

Existing account emails are **not automatically marked as verified recovery addresses**. General `is_verified` flags are insufficient because other sign-in methods also set them.

While still signed in, open customer **Account → Privacy and security**, technician **Me → Security**, or the technician verification page. Enter the current password, request verification, and explicitly confirm the emailed link. Refresh recovery status afterward. The exact stored account email is verified; clients cannot substitute another address.

New customer email-OTP signup records the verified recovery address when creating the account. Other password accounts enroll using the process above. Synthetic `@resqnow.invalid` technician emails are excluded. Google/mobile-only accounts keep their existing sign-in method; recovery cannot install a password on those accounts. An already-forgotten password with no verified recovery channel requires support-assisted identity recovery; no support bypass endpoint is introduced.

## API contract

All paths begin `/api/password-recovery/:role`, where `role` is `user` or `technician`.

| Method/path | Body/auth | Result |
| --- | --- | --- |
| POST `/request` | `{email}`, public | Uniform 202; eligible accounts receive email |
| POST `/confirm` | `{token,password}`, public | Reset password; sign in separately |
| GET `/status` | Matching account bearer token | Current email, password availability and recovery verification |
| POST `/verification/request` | Matching account bearer token, `{currentPassword}` | 202; email ownership challenge |
| POST `/verification/confirm` | `{token}`, public | Verify the account's recovery address |

These responses use `Cache-Control: no-store`. The PWA treats recovery GET/POST requests as network-only. Public recovery requests omit stale sign-in headers. Exact public sign-in/signup/Google routes remain available even if a client attaches a revoked optional token; protected routes still check the credential version.

## Security and persistence

Challenges use 32 cryptographically random bytes. Only SHA-256 hashes are stored, bound to account UUID, role, purpose, exact email and credential version. The trusted configured frontend origin builds links, never a request Host or redirect. Tokens travel in fragments, are captured into memory and removed from the address bar before React starts, and are submitted only in POST bodies. They are not placed in persistent browser storage. Reloading a scrubbed link requires opening the original email link again or requesting a new link.

The initial recovery document skips marketing scripts and suppresses referrers. Checkout now loads on demand at payment entry points rather than on recovery pages. Sensitive mail delivery propagates a privacy flag through the transport so provider errors cannot echo reset contents into logs.

The password transaction locks the account before the challenge, checks expiry/consumption/version/contact again, changes the bcrypt hash, increments `auth_version`, consumes all outstanding challenges and deletes old push registrations together. Concurrent confirms have one winner. Existing admin password-change paths also increment the version, making older challenges and tokens invalid. Legacy JWTs with no `sv` are accepted only while the account remains version zero. Already-running requests or already-dispatched notifications cannot be recalled.

Socket sessions join a private account/role room. Reset disconnects it through the Socket.IO adapter; packet validation and a five-second passive-session check also enforce the stored version. Authentication storage failures fail closed.

Durable SQL limits: reset requests are 10 per IP per 15 minutes, plus 3 per normalized email/account type per hour with a 60-second cooldown. Verification requests have their own account limit with the same values and share the request IP limit. Confirmation attempts are 30 per IP per 15 minutes across account types. Invalid attempts still consume the applicable IP budget. Request responses have a 300 ms minimum duration; this reduces timing differences without claiming strict constant-time network behavior.

## Rollout requirements

- Existing mail transport configuration must be working: `RESEND_API_KEY` and an authorized sender such as `EMAIL_FROM`.
- Set `FRONTEND_PUBLIC_URL` to the real frontend HTTPS origin, without credentials, a path, query or fragment. HTTP is accepted only for loopback development.
- Keep `JWT_SECRET` consistent across instances. Deploy the version-checking backend and versioned sign-in paths to **all** instances before enabling recovery in the frontend. An older backend instance would not enforce revocation.
- Startup adds `auth_version`, `recovery_email` and `recovery_email_verified_at` to customers/technicians and creates `password_recovery_tokens` plus `recovery_rate_limits`. These are modeled UUID tables; IDs are generated by the existing persistence adapter. There are now 49 active modeled tables. The deployment/bootstrap identity must have DDL permission. Readiness fails for missing/incompatible recovery columns, version defaults or hash constraints.
- Expired/consumed challenges and obsolete limit buckets can be purged under the application's database-retention policy. No live schema, account, mail or deployment operation was performed during this fix.

## Verification

- Backend `npm test -- --test-reporter=tap`: 812 passed, six existing tests skipped, zero failures. Syntax build: 264 files passed.
- Frontend `npx vitest run --maxWorkers=2`: 894 passed; two existing registration-preview tests exceeded their explicit 15-second timeout. All 11 tests in that file passed in an isolated diagnostic run with a temporary 60-second budget; the two slow tests took 17.98 and 17.48 seconds. The original test file and timeout were restored byte-for-byte. These runs cover all 896 frontend tests; a completely green full run under the original timing budget is not claimed.
- Frontend `npm run typecheck` and `npm run build`: passed. The build retains existing chunk-size and outdated Browserslist-data warnings.
- Fresh independent code review: five integration findings were corrected and regression-tested; the final review found no remaining actionable defects.

Regression coverage includes eligibility-neutral requests, role/purpose isolation, hash-only storage through the real UUID adapter, expiry/replay/resend/concurrent confirmation, rollback, changed contacts/password versions, password policy, durable limits, email enrollment, REST and socket revocation, actual customer login/admin-password-change routes, stale optional headers, whitespace-padded secrets, route navigation, account switching, cache/privacy rules and payment SDK loading.

SQL tests replace the driver and model transaction ordering. They do not establish real MySQL/TiDB isolation behavior. Real mail delivery, distributed Redis disconnection and Android device behavior still require deployment-environment validation. The implementation creates no manual QA servers, databases or test-environment configuration.
