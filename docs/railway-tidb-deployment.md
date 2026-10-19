# Railway and TiDB production deployment

Production uses Railway, not the historical Render endpoint. The service is `resqnowbackend` in the `production` environment, with Redis in the same Railway project. Its public API is `https://resqnowbackend-production-c392.up.railway.app`.

The GitHub workflow verifies tests and syntax. Railway's connected `main` branch owns ordinary releases. The old Render deployment job now requires explicit `DEPLOY_PROVIDER=render` as a repository variable; it must not run for this Railway installation.

## Initial migration procedure

1. Inspect the source schema and relationships through read-only queries. Do not set `DB_MIGRATION_MODE=off` to bypass the UUID guard.
2. Review legacy modules and invalid references. The 2026-10-19 inspection found 75 source tables, including 29 legacy modules. Retain every module and source record in the destination. Preserve legacy business primary keys and convert their references into current application tables to UUIDs.
3. Recover missing identities only from authoritative evidence. If no reliable identity exists, preserve their relationships using deterministic, disabled historical identities with explicit provenance. These identities must not enable login, dispatch or payouts. Preserve original request statuses, contacts, payment amounts and outcomes. The CLI rejects row-excluding apply operations.
4. Save a separate consistent source snapshot, including binary data, schema definitions, and per-table count/content digests. The private snapshot directory `uuid-migration-private/` is excluded from Git. `scripts/backup-deployment-source.mjs` accepts a private connection JSON file and a new output path; it performs no data writes.
5. Pause Railway automatic deployments for the cutover. Identify every database writer, including any external jobs. The current backend embeds its workers; the observed Railway project has no separate worker service. Deploy `node scripts/deployment-maintenance.mjs` with `/health` as its health check. Verify the maintenance response and that old deployments are removed before migration.
6. Verify source fingerprints against the backup, run the reviewed transfer into a separate empty/owned `test_relational_v2` target, and require content digests, counts and strict target relationship validation to pass. The transfer keeps the original `test` database unchanged. A failed verification must leave the target unpublished and Railway in maintenance.
7. Preserve the original `DB_NAME=test` selection and the default target naming, or explicitly configure `DB_MIGRATION_TARGET=test_relational_v2`. The application's matching ready marker selects the verified target. Never point an older application back at the source after new target writes begin.
8. Restore `npm start`, configure the Railway health check as `/ready`, keep `DB_MIGRATION_MAINTENANCE=false`, and deploy. Require HTTP 200 with `ok=true` and `database.ready=true`. Restore ordinary automatic deployments after the cutover completes.
9. Check customer/technician login, service requests, dispatch, payments and wallet history. UUID cutover can invalidate old sessions and old-ID Redis state; do not flush the whole Redis database or delete queued jobs without reviewing their contents.

All source records are accounted for in the destination. Retired OTP tables consolidate into retained migration history, and audit/note tables consolidate into their current models. Therefore destination row counts are not expected to equal the simple sum of source rows. Record the source-to-destination counts and restored historical identities in the private migration evidence. The original database and independent backup remain intact.

The reviewed migration command is read-only by default:

```powershell
npm.cmd run db:migrate:reviewed -- --all-records --connection migration-connection.local --backup-manifest uuid-migration-private/production-source-20261019.jsonl.gz.manifest.json
```

It checks every original table's schema, row count and content digest against the backup, validates the full record counts, and prints the exact review SHA-256. It does not stop services or change the database. To apply the authorized migration, first stop all writers through Railway maintenance, then add `--apply --writers-stopped --review-sha <rehearsed hash> --backend-url https://resqnowbackend-production-c392.up.railway.app --result <new-private-result.local>`. Both maintenance checks and strict target relationship/content validation are mandatory. Original source tables are never written by this command.

## SMS login is a separate setup

Firebase Authentication sends SMS codes. Enable Authentication and Phone sign-in, configure the production domains and India SMS policy, and obtain owner approval for the billing plan required for real SMS. The API then verifies the Firebase token against the matching project and issues a ResQNow session. Database readiness alone does not certify SMS delivery.

See [production login recovery](production-login-recovery.md), [Railway deployments](https://docs.railway.com/deployments/reference), and [Firebase phone authentication](https://firebase.google.com/docs/auth/web/phone-auth).
