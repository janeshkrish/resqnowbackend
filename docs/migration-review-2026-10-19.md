# TiDB migration review, 2026-10-19

Status: **full preservation authorized; live apply stopped during read-only source verification because external connectivity repeatedly failed**. A completed cutover must be supported by the private result file and live readiness checks. Railway remains in maintenance; the original database is unchanged.

Production runs on Railway. Its `/ready` endpoint is HTTP 503 because the legacy TiDB schema requires migration. The signed-in GitHub log shows that the separate deployment job failed because it expected missing Render/SQL settings. The workflow has been corrected locally so the legacy Render job is opt-in; Railway remains the production host.

The source `test` contains **75 tables and 48,529 rows**. A private consistent backup of every table, including binary content, was written to `uuid-migration-private/production-source-20261019.jsonl.gz` and independently read back. All table counts, content digests, schema hashes and the compressed file SHA-256 passed verification.

Backup SHA-256: `b76a8e889088b59f9b77ebf432e34a5394d24b3107b867ce8c4bfa0d204d090a`.

The earlier archival proposal is superseded by the user's instruction to retain every record. Its exclusion report and hash must not be used to apply a migration. The full preservation planner validates all **48,529 source rows** and all **29 legacy modules**, with no table or row exclusions. The final rehearsal binds this policy to the verified backup and prints its new SHA-256. Any changed source content requires a new backup/review.

The target is `test_relational_v2`, containing 42 current models and 29 retained legacy modules. All 52 current customer records and 27 technician records are included. Missing parents affect the following records, which are also included:

| Source table | Records with unresolved relationships |
| --- | ---: |
| service_requests | 20 |
| admin_actions_log | 20 |
| user_vehicles | 2 |
| job_monitoring_alerts | 2 |
| payments | 1 |
| Total | 45 |

The available request, billing and audit evidence does not reliably identify every missing owner. The planner restores eight historical customer identities and four historical technician identities with deterministic UUIDs and provenance. Customer identities have no phone/email and a disabled historical role/status. Technician identities are rejected, hidden, inactive, unavailable and logged out, with non-deliverable migration-only email identifiers. They preserve relationships without assigning private history or balances to an unrelated live account. Original contacts, amounts, outcomes and request statuses are retained. No original row is deleted or excluded.

A separate migrator bug was fixed: Razorpay `pay_...` values in JSON metadata are external provider IDs and must not be resolved as internal payment row IDs. Full-preservation tests cover legacy business keys, converted relationships, disabled restored identities, strict target validation and an unchanged source. The complete backend suite passes 582 tests; the build passes syntax checks for 221 files.

Use [the Railway procedure](railway-tidb-deployment.md). Do not set startup maintenance true while old writers are running, and do not bypass validation by disabling migration checks. No original database records were modified during preparation.

At release, also apply the staged correction of malformed Railway `BACKEND_URL` to the clean Railway public URL; `BACKEND_PUBLIC_URL` is already correct and currently takes precedence. Firebase Authentication is now initialized with Phone enabled, both production domains authorized and India allowed by SMS region policy. Billing and real SMS delivery remain unverified. Railway automatic deployments are temporarily paused for the migration and must be restored after cutover validation.

The maintenance deployment `3fe73684-4246-4955-a969-ca65878b5135` was verified active. The previous API/embedded-worker deployment `f4987e5c-3eaa-4473-8502-d4bca2f3a962` was verified removed. The live `/health` response was verified as `maintenance=true` before applying. The complete rehearsal verified every table against the backup and produced full-preservation review SHA-256 `c272ae968192537a3d0a304b308b7d0966bb2cfc94a5c56ee4118cefd05980ec`.

Two apply attempts were stopped during the read-only binary-file verification after this computer lost reliable external connectivity (DNS failures, HTTP timeouts, TiDB connection timeout and GitHub connection resets). No destination transfer started. The reserved result files `full-cutover-result.json` and `full-cutover-retry-result.json` are empty and are not completion evidence. Their logs explain the interruption. No migration process remains running. The Railway hosted console also failed to load, so hosted execution was unavailable. Do not describe the cutover as completed until target validation and live readiness succeed.

To resume: verify reliable HTTPS and TiDB SQL connectivity, check the actual Railway deployment and staged settings again, keep maintenance active and automatic deployments paused, then rerun the full-preservation apply command using a **new** private result path. The prepared release consists of `npm start`, health check `/ready`, and the corrected `BACKEND_URL`; confirm all three changes in Railway before deploying. The last console navigation showed only one staged change, so do not assume the earlier optimistic settings saves persisted through the outage. Run `node uuid-migration-private/verify-cutover.mjs <completed-result>` for independent counts, numeric totals and business status verification before release. Finally require live database readiness and restore automatic deployment.
