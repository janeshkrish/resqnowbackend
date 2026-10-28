# Backend release-quality verification

Verification uses only a disposable loopback MySQL-compatible instance, never a production
.env or migration target. It does not deploy, publish/sign an APK or enable updates.
Use Node22 and an isolated checkout with no production environment files.

Start your own disposable database on127.0.0.1:13307 with a synthetic root password.
Set NODE_ENV=test, DB_MIGRATION_MODE=off, APP_ANALYTICS_TEST_DB=1,
APP_ANALYTICS_TEST_PORT=13307 and APP_ANALYTICS_TEST_PASSWORD to that synthetic password.
Keep any generic DB settings loopback/synthetic too.
The analytics helper creates guarded resqnow_analytics_test_* databases and removes
only those it owns. Do not point a helper at a database containing customer information.

Run the entire suite with node scripts/test.mjs and capture TAP output.
Preserve its exit status when using a pipe (bash: set -euo pipefail).
Then run node scripts/verify-test-report.mjs <tap-file> and npm run build.
Both the original test exit status and the complete-report check are required.
Zero tests, missing/duplicate summaries, skipped/todo/cancelled or failing cases block
verification even if a test process returned zero. The verifier prints aggregates only,
not arbitrary report contents. Generated output/quality/ evidence is ignored.

The existing Verify backend workflow now provisions an ephemeral MySQL8.4 service
on port13307, explicitly enables real DB cases and enforces the same full-suite checks.
Its synthetic password is a public test fixture, not a secret.
Existing production concurrency and the opt-in Render adapter are unchanged.
The deploy job still depends on verification; Railway integration remains owner-managed.

Local verification uses MariaDB11.4.5. A local pass is not a hosted MySQL8.4 CI pass or
proof of staging TiDB compatibility. Those require their own real executions and
production/staging authorization. No deploy or DB transfer was run by this cleanup.
