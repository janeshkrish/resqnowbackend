# Push-to-deploy with full TiDB data preservation

**Current production uses Railway. Follow [the Railway guide](railway-tidb-deployment.md).** This document describes the legacy Render adapter, which now runs only when repository variable `DEPLOY_PROVIDER=render` is explicitly set. Ordinary Railway releases use Railway's connected GitHub repository.

For a step-by-step operator guide, start with [TIDB_DEPLOYMENT.md](../TIDB_DEPLOYMENT.md).

The workflow `.github/workflows/deploy-production.yml` runs on pushes to **main** in the backend repository and on manual dispatch from main. It uses the Render deployment adapter because this repository documents Render hosting. It has not been connected to a live Render account. Other hosting providers require an adapter for their writer shutdown/deployment lifecycle.

## One-time setup

1. In GitHub repository Settings -> Environments, create `production`. Allow deployments from main. For unattended deployments, do not configure a required reviewer. Enable GitHub Actions for the repository.
2. In that environment, add these **secrets**. Never commit their values:

   | Secret | Value |
   | --- | --- |
   | RENDER_API_KEY | Render API key with access to the production API and workers |
   | DB_HOST | TiDB hostname from the cluster Connect dialog |
   | DB_USER | Complete TiDB SQL username, including its cluster prefix where applicable |
   | DB_PASSWORD | Working TiDB SQL password |
   | ADMIN_EMAIL | Same admin identity email configured in production, needed to resolve historical admin labels |

3. Add these production environment **variables**:

   | Variable | Value |
   | --- | --- |
   | RENDER_SERVICE_IDS | Comma-separated IDs of the API and **all** production background workers, e.g. `srv-api123,srv-worker456` |
   | DB_NAME | Existing/source TiDB database name, e.g. `resqnow` |
   | DB_PORT | `4000`, unless the Connect dialog specifies otherwise |
   | DB_MIGRATION_TARGET | Empty destination name, e.g. `resqnow_relational_v2`; leave unset to use the default |
   | DB_LEGACY_NAME | Usually unset. Only use the explicit legacy/source naming mode described in models/README.md |
   | DEPLOY_RUNNER | Optional runner label; default `ubuntu-latest`. Use a trusted runner with TiDB network access if your cluster restricts client IPs |

4. In Render, disable native **Auto-Deploy** for every listed API/worker **before pushing** this workflow. GitHub Actions takes responsibility for deployment; native auto-deploy could otherwise start a migration while old instances still write. Services must point to this backend repository's main branch. Node and Docker runtimes are supported. Remove separate pre-deploy commands; this workflow owns migration order.
5. Include every database writer. This adapter supports one API web service and its Render background workers. External cron jobs, other applications writing the same database and unsupported Render cron services must be stopped or integrated before using this maintenance workflow. A missing writer cannot be stopped by a list it is absent from.
6. Give the SQL account source SELECT/schema-inspection privileges and target database creation, CREATE/INSERT/SELECT/ALTER/DROP privileges. Configure network access for the deployment runner and Render. The workflow requires TLS and certificate verification.
7. Rehearse with a separate staging source/target and staging services before the first production push. The previously configured local TiDB credentials returned access denied; valid GitHub secrets are required. Retain an independent backup/export.

The [Render API setup](https://render.com/docs/api) explains API-key creation. [GitHub environment secrets and variables](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) describe the GitHub settings.

## What happens on each push

1. Install the locked dependencies, run all tests and JavaScript syntax validation. Production credentials are available only to the deployment job.
2. Validate service IDs, repository/branch, disabled native auto-deploy, supported runtime, absence of conflicting deployment hooks, and no competing in-progress Render deploys. Check TiDB connectivity **before changing live services**.
3. Save each service's release start command in its own `RESQNOW_RELEASE_COMMAND` environment value. This contains command metadata, not database records. Deploy the pushed commit with `node scripts/deployment-maintenance.mjs` as the temporary start command. The maintenance process imports no DB/queue/application modules. The API returns maintenance responses; workers perform no jobs.
4. Verify that maintenance runs the intended commit. Wait 60 seconds plus the largest configured Render shutdown allowance plus 10 seconds so previous API/worker instances have exited. This follows [Render's deployment lifecycle](https://render.com/docs/deploys).
5. Run the existing TiDB transfer in maintenance mode. Source records remain untouched. A new target receives UUID keys/references and consolidated histories. Target records are read back and checked by row counts, a content digest and relationship validation before activation. Unknown tables/fields or unresolved relationships cause a failure instead of dropping data.
6. Update only the relevant DB environment variables on each service; unrelated settings remain intact. Disable startup maintenance transfer after successful activation.
7. Restore the API start command and deploy the tested commit with `/ready` as its Render health check. Application bootstrap applies the current schema additions before readiness becomes true. Then restore/deploy workers to the same commit.

Subsequent pushes reuse the verified target without copying the original database again or overwriting new production writes. Current schema bootstrap still runs. Future destructive schema changes require explicit, tested migrations; pushing arbitrary schema edits cannot automatically infer a lossless transformation.

The workflow serializes production deployments and does not cancel an active migration when another commit is pushed. Service selection and commit checks prevent an unrelated service/branch from being deployed. No customer-data export or plan is uploaded as a GitHub artifact. Start-command checkpoints remain on Render for retry/recovery.

## How every old record is preserved

All application rows from known source tables are copied, with source table counts reported as `preservedSourceRows`. Notes and audit events are merged without deduplication or dropping events. Parent UUIDs, known nested JSON references and retry keys are rewritten consistently. Binary/PDF data is copied as binary.

OTP runtime state uses one row per destination, while **every original OTP challenge and rate-limit row** is retained in `otp_requests.migration_history` as JSON. Historical record IDs become deterministic UUIDs. Current challenge verification/consumption does not update this historical field. Consequently, physical OTP row counts can decrease while all original record content remains queryable. This adds a column, not an additional table. The new schema still defines 42 tables.

For example, retrieve original challenge history with:

```sql
SELECT email, JSON_EXTRACT(migration_history, '$.requests') AS previous_challenges,
       JSON_EXTRACT(migration_history, '$.rate_limits') AS previous_rate_limits
FROM otp_requests
WHERE email = 'customer@example.com';
```

The source database also remains intact. Unknown source structures stop migration for a mapping update; no tool can guarantee alignment for a schema it cannot inspect. An older completed target created by the previous history-retiring implementation is deliberately not accepted as a new full-preservation migration. Do not overwrite it or recopy a stale source over new writes; reconcile it separately first.

## Failure and recovery

For the startup maintenance guard, suspended Render services, or mobile SMS OTP failures, use [Production startup and mobile OTP recovery](production-login-recovery.md). Run `npm run deploy:production -- --check` for a read-only configuration and database-connectivity preflight before a deployment. GitHub runs this preflight as a named step and reports a failure reason in the run summary.

- Missing settings, bad SQL credentials or conflicting service configuration fail before maintenance deployment.
- Maintenance rollout must finish for all services before copying starts. Migration/verification failure leaves services in maintenance; old application commands are not restored automatically against a partial target.
- Resolve the error and rerun the failed workflow or push a fix. Original release commands are recovered from `RESQNOW_RELEASE_COMMAND`. Unpublished target tables are rebuilt only if their ownership markers match this migration. Original/source data is never dropped.
- If API readiness fails, workers stay in maintenance. If a release partially succeeds, inspect the Render deployment states and rerun; do not switch active applications back to the old source after new target writes have begun.
- Manual cancellation, runner loss or timeout can also leave maintenance active. Restart through the same workflow. Do not remove command checkpoints while a deployment is incomplete.

There is intentional downtime during maintenance/deployment. Existing sessions and clients must support UUID identities and the old-ID queue/tracking cutover. Validate customer/technician login, registration, approvals, requests, tracking, payments, invoices and wallets before first production exposure. No hosted migration, Render rollout or frontend/provider integration was executed during local implementation.
