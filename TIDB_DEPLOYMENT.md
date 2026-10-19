# TiDB deployment instructions for ResQNow

This guide explains how to make a push to GitHub automatically migrate the existing TiDB data and deploy the backend.

**Hosting supported by the current workflow: Render.** It supports one API web service and its background workers, using Node or Docker. If the backend is hosted elsewhere, its deployment integration must be added before following this guide.

**Current status:** the code and workflow are written, but no hosted migration or deployment has been performed. The previous local TiDB connection returned `Access denied`. Complete the setup below with working credentials first.

## 1. Understand the database names

The migration creates a separate database in the **same TiDB cluster**. It preserves the original database and copies its records into the new schema.

Throughout this guide, these names are examples:

| Setting | Example | Meaning |
| --- | --- | --- |
| `DB_NAME` | `resqnow` | Your existing database containing the live records |
| `DB_MIGRATION_TARGET` | `resqnow_relational_v2` | The destination database for the new schema |

Replace the examples with your actual names. Keep these settings consistent in GitHub and subsequent deployments. Leave `DB_LEGACY_NAME` unset when using this guide.

The destination must be absent or empty on the first migration; the tool can create it. Do not choose another application's database. A failed copy can be rebuilt only when its tables carry this migration's matching ownership marker.

**After migration, keep `DB_NAME` pointing to the original source in this configuration.** The backend automatically selects the verified destination. You will see both databases in TiDB Cloud; select the destination when viewing the new tables.

## 2. Get working TiDB connection details

1. Sign in to [TiDB Cloud](https://tidbcloud.com/).
2. Open the cluster containing your current live data.
3. Click **Connect** and select the appropriate connection method.
4. Copy the hostname, port, SQL username and existing database name. Use the complete username shown there; some endpoint models require a cluster prefix.
5. Use a working SQL password. Do not reset a shared production password without updating its existing consumers.
6. Keep TLS enabled. The GitHub workflow also enables certificate verification.
7. Configure network access so both Render and the GitHub deployment runner can connect. Where an IP access list is required, allow the actual connection sources. Allowing only your laptop's IP will not allow GitHub or Render to connect.

See [TiDB connection instructions](https://docs.pingcap.com/tidbcloud/connect-via-standard-connection-serverless/) for endpoint-specific settings.

The SQL account needs permission to read/inspect the source and create the destination database, then CREATE, INSERT, SELECT, ALTER and DROP within the destination. Source rows are never updated or dropped by the transfer. DROP is used only to rebuild an owned, unpublished destination after an interruption.

If TiDB restricts client IPs, use a trusted deployment runner with an allowed, stable outbound IP. You can select its runner label with the optional `DEPLOY_RUNNER` GitHub variable in step 5.

## 3. Check access and prepare a backup

For an optional local, read-only connection check, put the following in the backend's untracked `.env` file. Replace every placeholder:

```dotenv
DB_HOST=<hostname from TiDB Connect>
DB_PORT=4000
DB_USER=<complete SQL username>
DB_PASSWORD="<working SQL password>"
DB_NAME=resqnow
DB_SSL=true
DB_SSL_STRICT=true
```

Use the actual port and source name if they differ. Run from `resqnowbackend`:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run db:inspect
```

Expected result: the database version, table names, columns and row counts are printed. This command does not migrate or change data. Local success confirms access from your computer; the deployment runner still needs its own network access.

Before the first production transfer:

- Take an independent backup/export using the options available for your TiDB plan. See [TiDB export instructions](https://docs.pingcap.com/tidbcloud/serverless-export/).
- Rehearse the workflow against a separate staging source, destination and staging services.
- Schedule a maintenance window: the workflow intentionally pauses the API and workers during migration and deployment.
- Identify every process that writes to this database. Include all Render background workers in step 5. Stop or integrate external writers before production transfer; this workflow does not manage external cron jobs or unsupported Render cron services.
- Confirm that the deployed clients accept UUID strings. Existing sessions need to sign in again after the UUID cutover, and old-ID queue/tracking state needs coordinated handling.

## 4. Prepare Render once

For the API and **each** production worker:

1. Open the service in the Render dashboard.
2. Confirm it uses this backend GitHub repository and the `main` branch.
3. Disable Render's native **Auto-Deploy before pushing** the workflow. GitHub Actions will own deployment order; a separate automatic rollout could start while old instances still write.
4. Remove any separate pre-deploy command. The workflow runs database migration itself.
5. Keep the normal application start command configured:

   | Service | Normal Node start command |
   | --- | --- |
   | API web service | `npm start` |
   | Background dispatch worker | `npm run worker:dispatch` |

   For Docker services, keep the existing Docker command override or image default. The workflow temporarily changes and then restores it.

6. Copy the service ID beginning with `srv-`. Collect the API ID and every worker ID. Services must be active, with no competing deploy in progress when the workflow starts.

Keep existing non-database production settings, such as JWT, Redis, URLs, payment and mail configuration. The workflow updates the relevant database settings without replacing unrelated environment variables.

Create a Render API key with access to these services. See [Render API key setup](https://render.com/docs/api). Store it as the GitHub secret in the next step; do not put it in the repository.

## 5. Configure GitHub once

Open the **backend GitHub repository**, then:

1. Go to **Settings -> Environments**.
2. Create an environment named exactly **`production`**.
3. Allow deployments from `main`.
4. For unattended deployment, do not configure a required reviewer or wait timer for this environment.
5. Add the following environment secrets and variables. Enter their raw values without surrounding quotation marks in the GitHub UI.

### Environment secrets

| Secret name | What to enter |
| --- | --- |
| `RENDER_API_KEY` | The Render API key created in step 4 |
| `DB_HOST` | TiDB hostname, without `https://` or a port suffix |
| `DB_USER` | Complete TiDB SQL username |
| `DB_PASSWORD` | Working TiDB SQL password |
| `ADMIN_EMAIL` | The admin email configured in production; used to resolve historical admin labels where needed |

### Environment variables

| Variable name | Example value | Required? |
| --- | --- | --- |
| `RENDER_SERVICE_IDS` | `srv-api123,srv-worker456` | Yes: exactly one API and every production background worker |
| `DB_NAME` | `resqnow` | Yes: the existing/source database |
| `DB_PORT` | `4000` | Optional: defaults to `4000` |
| `DB_MIGRATION_TARGET` | `resqnow_relational_v2` | Optional: defaults to `<DB_NAME>_relational_v2` for ordinary-length names |
| `DEPLOY_RUNNER` | `resqnow-production-runner` | Optional: a configured runner label; otherwise uses `ubuntu-latest` |

If there is no separate worker, `RENDER_SERVICE_IDS` contains only the API service ID. Do not include frontend/static-site IDs. Leave `DB_LEGACY_NAME` unset for this configuration.

You do **not** need to supply `GITHUB_SHA` or `GITHUB_REPOSITORY`: GitHub provides them. The workflow also supplies `DB_MIGRATION_MODE=auto`, `DB_SSL=true` and `DB_SSL_STRICT=true`, and manages maintenance automatically.

Ensure GitHub Actions is enabled. If your GitHub plan does not support environments for this repository's visibility, resolve that before relying on this environment-based workflow. See [GitHub environment setup and availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## 6. Push the reviewed backend changes

Confirm the committed changes include the workflow, migration models, deployment scripts and related backend updates. Do not commit `.env`, credentials, database exports or customer data.

Run the local checks if you have not already done so:

```powershell
npm.cmd test
npm.cmd run build
```

Commit the reviewed changes using your normal Git process. Then push `main`:

```powershell
git push origin main
```

Open GitHub -> **Actions -> Verify, migrate TiDB, and deploy** and select the run for that commit. The workflow is defined in [`.github/workflows/deploy-production.yml`](.github/workflows/deploy-production.yml).

For a manual retry, open that workflow, choose **Run workflow**, and select `main`. Other branches do not run the production deployment job.

## 7. What the workflow does automatically

| Stage | What happens |
| --- | --- |
| Verify | Installs locked dependencies, runs tests and checks JavaScript syntax |
| Preflight | Checks Render configuration, competing deploys and TiDB connectivity before changing running services |
| Maintenance | Deploys the pushed commit with a maintenance process on the API and workers; it imports no application, queue or database modules |
| Drain | Waits for previous instances to exit before reading the migration snapshot |
| Transfer | Creates the destination and copies existing records into the new UUID schema |
| Verify data | Reads destination records back and validates counts, content digests and UUID relationships before activation |
| Release API | Updates database settings, restores the API start command and deploys the tested commit; schema initialization completes before `/ready` succeeds |
| Release workers | Restores/deploys workers only after the API is ready |

Look for messages such as:

```text
[Deploy] srv-...: maintenance process is live
[Deploy] draining old instances for ... seconds
[DB migration] ...: copied ... rows
[Deploy] verified database selected: resqnow_relational_v2
[Deploy] commit ...: API and workers released
```

The workflow saves normal start commands in each service's `RESQNOW_RELEASE_COMMAND` setting for recovery. Leave that setting intact. Do not manually change maintenance flags on every push; the workflow handles them.

## 8. Verify the result in TiDB and the application

Select **the destination database**, not the original source, in your TiDB SQL client. Replace the example destination below with your configured name.

Check the table count:

```sql
SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = 'resqnow_relational_v2'
  AND table_type = 'BASE TABLE';
```

Expected result for the current schema: **42 tables**. The cluster still contains the original database as well.

Check that primary ID columns use the UUID storage type:

```sql
SELECT table_name, column_type
FROM information_schema.columns
WHERE table_schema = 'resqnow_relational_v2'
  AND column_name = 'id'
  AND NOT (data_type = 'char' AND character_maximum_length = 36);
```

Expected result: **no rows**. To inspect sample IDs and a parent relationship:

```sql
USE resqnow_relational_v2;

SELECT id FROM users LIMIT 5;

SELECT COUNT(*) AS requests_without_a_user
FROM service_requests AS sr
LEFT JOIN users AS u ON u.id = sr.user_id
WHERE sr.user_id IS NOT NULL AND u.id IS NULL;
```

IDs should be UUID strings. `requests_without_a_user` should be `0`.

Check preserved OTP history without displaying the historical hashes:

```sql
SELECT email,
       JSON_LENGTH(migration_history, '$.requests') AS preserved_challenges,
       JSON_LENGTH(migration_history, '$.rate_limits') AS preserved_throttle_records
FROM otp_requests
WHERE migration_history IS NOT NULL;
```

OTP physical row counts are consolidated; every original OTP/throttle record remains in `migration_history`. Notes and audit tables also merge, so old and new table counts do not match one-for-one. Historical admin identities can add rows to `users`.

Finally:

1. Confirm the GitHub workflow completed successfully and Render runs the expected commit.
2. Check `https://YOUR_BACKEND_HOST/ready`. After release it must return HTTP `200`, `ok: true` and `database.ready: true`. A maintenance probe returning `200` with `maintenance: true` is not an application-ready result.
3. Test customer/technician login, registration, approval, request creation/dispatch, tracking, payments, invoices, wallets, refunds and withdrawals.

These SQL examples are spot checks. The automated migration performs broader verification before activating the target. A real staging rehearsal and application checks remain necessary.

## 9. Later pushes

After successful cutover, the same GitHub settings continue to work. Startup recognizes the completed destination and uses its current records. It does not reimport the old source over new production writes.

Keep the database naming settings stable. Routine pushes still run the maintenance/deployment sequence. Future column renames, removals or other destructive changes need explicit migrations; arbitrary schema edits cannot infer how to preserve old data.

## 10. If deployment fails

| Error or symptom | What to do |
| --- | --- |
| `Missing deployment settings` | Add the named secrets/variables to the GitHub `production` environment |
| `Access denied` | Check the exact TiDB username, password and SQL privileges in GitHub; a TiDB website login is not a SQL credential |
| Connection timeout or TLS error | Check the hostname, port, allowed outbound IPs, endpoint access and trusted TLS configuration |
| `Disable Render Auto-Deploy` | Disable native auto-deploy on every listed API/worker, then retry |
| Service uses the wrong repository/branch or has another deploy running | Correct its configuration or wait for the other deploy to finish |
| Unknown table/column, orphan reference or ambiguous identity | Keep maintenance active and add/fix the migration mapping or source relationship; do not delete records to bypass validation |
| Destination contains unowned data | Inspect that database; do not delete it blindly or overwrite an active database. Use an appropriate empty target before the initial cutover |
| Migration fails after maintenance starts | Fix the reported error and rerun the workflow. Matching unpublished destination tables are rebuilt; the source is preserved |
| API readiness fails | Inspect API bootstrap logs. Workers remain in maintenance until readiness succeeds |
| Workflow is canceled or times out | Inspect GitHub/Render states, resolve the interruption and rerun. Keep `RESQNOW_RELEASE_COMMAND` intact |

If some release steps already succeeded, inspect which services are live before retrying. Do not start an old application against a partially migrated target, and do not resume writes to the old source after new target writes begin. The databases are not continuously synchronized; a later rollback needs reconciliation or restoration.

Keep the original database and backup until cutover is accepted. The workflow does not automatically delete either.

For implementation details, see [the deployment reference](docs/github-tidb-deployment.md), [database models and migration rules](models/README.md), and [local verification evidence](docs/database-uuid-verification-2026-10-15.md).
