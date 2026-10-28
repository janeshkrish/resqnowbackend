# Android adoption analytics rollout

This feature is optional, first-party telemetry, not an automatic APK updater. The original application workflows and APK delivery do not depend on analytics succeeding.

## Metrics and privacy

- Website download sessions count accepted GET/range deliveries with a per-action UUID. Repeated ranges with the same ID count once during the 30-day raw-ID retention window. This does not prove a complete download or installation. HEAD, failed and aborted responses do not count. Direct/malformed-ID delivery requests are separate unattributed requests.
- Reported first opens count native identities after optional consent and their first online report. Historical installs cannot be reconstructed. Web/PWA opens are not Android installs.
- Updates/process restarts retain identity; clearing app data or reinstalling creates a new identity. There is no accurate uninstall counter or total-current-physical-install count.
- Account counts use server-verified customer/technician JWTs and distinct retained account IDs. One account on two phones is two installations/one account. Roles overlap and are not additive. Deletion/withdrawal removes account links, so these totals may decrease.
- UTC timestamps and Asia/Kolkata calendar days are used. Periods are 7/30/90 inclusive of today. Active installations use heartbeat time; version distribution is the latest version on installations active in that period, not historical version events.
- No audio, location, advertising ID, IMEI or hardware identifier is collected. Withdrawal removes links and timestamp/version details after reconnect. Anonymous totals and a minimal pseudonymous deduplication/consent ledger remain. Never log request bodies, proofs, JWTs or native state files.

## Safe staged rollout (requires separate production approval)

1. Back up and review the intended database, database resolver result, privacy disclosure, trusted proxy configuration, and staging MySQL/TiDB compatibility. This implementation was tested against disposable MariaDB, not the production TiDB cluster.
2. Inspect SQL without connecting: `npm run db:migrate:app-analytics`. This runner does not load `.env` or invoke a full database transfer.
3. In an explicitly configured deployment environment, set the reviewed DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and TLS settings. Supply the exact resolved database name explicitly: `npm run db:migrate:app-analytics -- --apply --database=REVIEWED_NAME`. Only four additive tables are created; no business rows are copied/dropped. Use trusted TLS settings appropriate for the database.
4. Verify: `npm run db:migrate:app-analytics -- --check --database=REVIEWED_NAME`. Required columns, UUID keys and indexes are checked. Reapplying is idempotent, not a repair of incompatible existing tables.
5. Deploy backend with `APP_ANALYTICS_ENABLED=false` (default) and `APP_ANALYTICS_RETENTION_ENABLED=false` (default). Admin reads return disabled, not misleading zero counts. No ingestion creates schema.
6. Canary a separately built Android client with `VITE_APP_ANALYTICS_ENABLED=true`. Verify compatible signing and increased versionCode, native backup/update/reinstall behavior and both account roles before publication. Browser builds do not register installations.
7. Enable `APP_ANALYTICS_ENABLED=true` only after schema/canary acceptance. Enable `APP_ANALYTICS_RETENTION_ENABLED=true` to purge raw download sessions older than 30 days in bounded batches every minute. Monitor admin partial-coverage health, storage capacity, rate limits and real proxy behavior.

Rollback: turn collection off. Keep retention enabled independently if required. Withdrawal remains available while collection is off; a missing analytics schema is an explicit no-record withdrawal, not a migration trigger. Do not drop analytics/business tables as an incident response. Anonymous health is process-local and resets on process restart; it is not a durable monitoring service.

## Isolation and abuse boundaries

Analytics uses a separate two-connection mysql2 pool and a bounded queue (500 pending, concurrency two). The 2-second operation deadline physically destroys overdue borrowed connections; active capacity remains occupied until the driver settles. Five consecutive storage failures open a 30-second circuit. Client validation/proof failures do not open it. Website file delivery enqueues after response completion and never awaits analytics.

Registration is 30/minute/IP; telemetry is 6/minute/installation; bodies are at most 2 KiB. Installation proofs deter accidental/spoofed updates to existing records, but public registration is not device attestation and can be abused. Validate deployment proxy trust and monitor anomalous growth. Admin endpoints retain the existing admin guard.

## Verification

`npm test` runs unit tests; real DB tests are explicitly gated by `APP_ANALYTICS_TEST_DB=1`. The disposable helper uses only loopback port 13307 (override APP_ANALYTICS_TEST_PORT), a synthetic test password, and random `resqnow_analytics_test_*` databases. It never reads production DB_* values or `.env`, and refuses unsafe deletion names. Start an isolated local MySQL-compatible server before enabling these tests. `npm run build` syntax-checks backend JavaScript.

The frontend `npm run test:e2e:analytics` starts the actual feature routers/guards and APK HTTP handler against this disposable schema. Its fake APK bytes test HTTP delivery only, and its browser native bridge is a simulation, not an Android-install test. Harness-only routes and larger lifecycle-test budgets are never mounted by production index.js. Keep traces off because telemetry requests contain proofs/tokens; store only sanitized screenshots in ignored output directories.

Production schema changes, merge/push, APK signing/publication and production flag changes require owner approval; none is performed by the test harness.

## Local implementation verification (28 October 2026)

Code `31d029e` passed all 616 backend tests with real disposable DB tests enabled, and all 241 JavaScript files passed syntax build. The independent review's storage-loss health and concurrent account-deletion findings were fixed with RED-to-GREEN tests. Link cleanup now locks the parent account within the existing deletion transaction, so it does not rely on gap locks. Per-job breaker accounting counts one timeout/rejection only once. Frontend verification/remaining Android release gates are documented in its matching acceptance report; no production rollout is implied.
