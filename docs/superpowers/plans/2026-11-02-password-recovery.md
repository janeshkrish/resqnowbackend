# BUG-03 customer and technician password recovery

> **For agentic workers:** Use superpowers:executing-plans inline, test-driven-development, and one fresh final code review.

**Goal:** Provide usable role-scoped self-service password recovery through previously verified email, with single-use expiring challenges and revocation of existing access.

**Spec:** Root `QA_REPORTED_BUGS_ANALYSIS.md`, BUG-03. Supporting security guidance: [OWASP forgot-password guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

**Architecture:** Opaque 256-bit email links, storing SHA-256 hashes only in a dedicated UUID challenge table. MySQL transactions lock account before challenge, invalidate previous challenges, change bcrypt password, increment credential version, consume links and delete old push registrations atomically. Durable SQL request limits apply to known and unknown addresses. Session versions are checked at common API/auth route boundaries and Socket.IO handshake/packets; reset disconnects private session rooms across the Redis adapter. User/technician schema records the exact verified recovery address so changing a contact cannot reuse another address's verification.

**Tech stack:** Existing Node/Express/MySQL, crypto/bcryptjs/jsonwebtoken, Socket.IO and React/Vite. No new dependency.

## Design choices and constraints

- Follow the report's recommended email links. Signup OTP reuse is rejected because signup creates accounts and has different purpose/ownership/attempt semantics. SMS recovery is not added; existing Google/phone sign-ins remain separate.
- Existing addresses are not silently marked recovery-verified. New customer email-OTP signup records ownership; other password accounts can enroll their current address by authenticating and confirming their current password, then following the emailed verification link. Forgotten-password accounts without a verified channel require assisted identity recovery. No social/phone-only account receives a new password through this flow.
- Minimum reset password12 characters, nonblank, maximum72 UTF-8 bytes (bcrypt limit); confirmation must match in UI. Roles with the same email remain independent.
- Reset/verification links use the configured frontend origin, never request Host/redirect input; HTTPS required except loopback development. Secrets are URL fragments, never API paths/queries or access logs. No automatic sign-in after resetting.
- Backend success response for reset requests is always202 with the same eligibility-neutral message; account throttles also use that message. IP throttling is independent of account existence. Delivery happens after commit without adding mail-network latency to the response; a response floor reduces timing differences. Mail delivery failures are logged without token contents and clients can resend after cooldown.
- Preserve prior QA fixes, current worktree and all uncommitted work. No GitHub operations, deployment, real account changes, live mail, or recreation of the removed manual QA environment.

## Review focus

- Same-email customer/technician isolation, admin exclusion, absent/unverified/changed email and passwordless accounts.
- Expired/reused/wrong-role/wrong-purpose tokens, concurrent confirmation, resend and rollback.
- Durable per-IP/per-identity limits and no secret exposure in logs, caches or navigation.
- Legacy version-zero JWT compatibility, old/new sessions, socket subscriptions/tracking and old push token removal.
- Actual table/column/payload compatibility, fail-closed schema readiness, lost responses and account switching.

## Task 1: Recovery and credential version backend

**Files:** new schema `models/schema/recovery.js`, service `services/passwordRecoveryService.js`, `services/credentialSessions.js`, middleware `middleware/credentialSessions.js`, router `routes/passwordRecovery.js`, model bootstrap/schema registry/UUID relationships, `index.js`; tests `tests/password_recovery.test.js`, `tests/password_recovery_schema.test.js`, `tests/credential_sessions.test.js`.

**Interfaces:** request(role,email,ip), confirm(role,token,password,ip), verificationRequest(role,id,currentPassword,ip), verifyEmail(role,token,ip), status(role,id). Credential validator checks JWTsv(default0) against current account.auth_version; global mount protects `/api` and `/auth`. Service receives getPool/mail/revoke dependencies for controlled tests; production defaults use real shared boundaries.

- [x] Write failing token/eligibility/limit/concurrency/rollback/password-policy tests, then implement schema and backend.
- [x] Write failing version/HTTP tests, implement common route protection and versioned token issuance.
- [x] Verify actual modeled schema and UUID mapping for new role-dependent challenges; readiness refuses missing/incompatible recovery schema.

## Task 2: Revoke connected access

**Files:** `services/socket.js`, token issuance in users/technicians/auth and phone login, existing admin password-update boundary, socket and pipeline tests.

**Interfaces:** socket identity carries sessionVersion. validateSession injected/default SQL validator checks handshake and every packet; periodic recheck bounds passive-session revocation if Redis broadcast fails. `revokeSessions(role,id)` disconnects a private role/account room, which every connection joins automatically. Native tracking REST uses the common API validator. No business job state is reset by password recovery.

- [x] Add failing old-session/new-session/room/packet tests; preserve original socket role/ownership tests with explicit boundary doubles.
- [x] Implement checked revocation, preserve auth version at every sign-in, and increment it at existing password-change boundaries.
- [x] Run backend full tests and build, fixing real regressions and precise fixtures.

## Task 3: Recovery screens and enrollment

**Files:** new role-aware recovery/reset/email-verification pages and account recovery settings component; `App.tsx`, technician login/profile/verification, customer Settings, API/PWA privacy handling; frontend integration tests.

**Interfaces:** customer `/forgot-password`, `/reset-password`, `/verify-recovery-email`; corresponding `/technician/...` paths. Public request/confirm calls omit login tokens. Setup status/verification request uses the correct existing actor token and current password. Reset completion links to the correct ordinary login; never installs a session.

- [x] Add failing UI/API tests for both roles, link fragments, matching passwords, expired/replayed links, request errors and enrollment.
- [x] Implement accessible forms within existing component styles and real reachable routes; no mock recovery success in production or demo.
- [x] Run frontend focused/full tests, typecheck/build; fresh review; document schema rollout, verified-channel prerequisites and real mail/native validation limits. Remove temporary logs only.

## Execution ledger

Pre-flight: Task2 consumes Task1 credential validator; Task3 consumes Task1 router contract. No cross-task conflict. Existing checkout retained because earlier fixes are uncommitted. Implementation choices above follow the supplied report; no live safety/approval operation is being requested.

Completion: Backend 812 passed, six pre-existing skips; syntax build 264 files passed. Frontend 894 passed in the full run plus two existing 15-second registration-preview timeouts; isolated diagnostic with 60-second budget passed both (about 18 seconds each) and restored the original test file byte-for-byte. All 896 frontend tests covered across these runs. Frontend typecheck/production build passed. Fresh final review found no actionable defects after corrections. Live database isolation, mail, Redis-cluster revocation and Android-device validation remain deployment checks, as documented in docs/bug-03-password-recovery.md. No GitHub/deployment/live-service changes; temporary BUG-03 logs removed.
