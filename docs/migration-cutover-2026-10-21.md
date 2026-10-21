# TiDB cutover, 2026-10-21

Database migration is complete. Railway API restoration is still blocked by the Railway platform incident: https://status.railway.com/incident/QH8L8B3E. Do not rerun the initial transfer or replace the ready target.

## Verified database state

- Original `test`: all 75 tables and 48,529 source records retained unchanged.
- Ready target `test_relational_v2`: 71 tables and 48,525 destination rows. Consolidated OTP/audit/note histories retain their source records; 12 disabled historical identities and a historical administrator preserve unresolved relationships. Source and destination totals therefore differ by design.
- All 29 legacy modules retained; no excluded source tables or records.
- All content digests, copied counts, foreign keys and strict UUID relationships passed the transfer's validation before the ready marker was written.
- All 86 uploaded files copied and content-verified, including approximately 161 MB of binary data.
- Independent verification passed all original/destination counts, 114 numeric totals for original records, and the status groups for service requests, payments, invoices and payouts. Additional restored identities are excluded from comparisons of original numeric totals because their schema-default ratings/prices are new values.
- Runtime selection with maintenance disabled reused the verified target and passed `assertUuidSchema`.
- The independent backup was read back and verified again: SHA-256 `b76a8e889088b59f9b77ebf432e34a5394d24b3107b867ce8c4bfa0d204d090a`.
- Full-preservation review SHA-256: `c272ae968192537a3d0a304b308b7d0966bb2cfc94a5c56ee4118cefd05980ec`.

Private evidence, excluded from Git, is in `uuid-migration-private/`:

- `full-cutover-20261021-decimal-result.json`: completed transfer, counts and restored-identity provenance.
- `independent-cutover-verification.json`: independent counts, numeric totals and status checks.
- `production-source-20261019.jsonl.gz` and its manifest: intact source backup.

Earlier empty result files are failed-attempt reservations, not completion evidence. The first October 21 attempt lost the lock connection during a large file read. The next attempt stopped at exact content validation because TiDB rendered decimal defaults `500` and `5.0` as `500.00` and `5.00`. Neither attempt activated its incomplete target.

## Targeted local fixes

`models/migrations/deploymentMigration.js` now keeps both SQL sessions active during long reads/writes, preserves the original lock session and stops writes after heartbeat/lock failure. It also pads DECIMAL values to the declared scale without converting money through floating point or changing the source backup digest format.

Regression coverage includes long binary reads, loss of lock, heartbeat cleanup, decimal defaults on restored identities and large exact decimal values. The full backend suite passed (586 tests); the build passed syntax checks for 225 JavaScript files. These code changes remain local and uncommitted. The live Railway image is still commit `1f03dea2e247c14f0dbc7d96d3b1d31a7433666b`; it can reuse the ready target without transferring data again.

## Railway release still required

The saved settings were reviewed as exactly two changes and submitted using **Deploy Changes**:

| Setting | Previous | Submitted |
| --- | --- | --- |
| Start Command | `node scripts/deployment-maintenance.mjs` | `npm start` |
| Healthcheck Path | `/health` | `/ready` |

`BACKEND_URL` was already the correct Railway public URL. Keep `DB_NAME=test`, the default target `test_relational_v2`, automatic migration mode, and startup maintenance false/unset. The matching ready marker selects the completed target. Do not disable migration checks.

Railway still displayed **Limited Access / Deploys have been paused temporarily**, with no new deployment appearing after submission. The active deployment remained `076b10be-ace6-4d6c-bebb-893ff103e612`. Its `/health` and `/ready` both returned HTTP 200 with `maintenance=true`, which is not API readiness. The hosted console's WebSocket connection also failed.

When Railway resumes deployments, deploy the saved `npm start` + `/ready` configuration and require `https://resqnowbackend-production-c392.up.railway.app/ready` to return HTTP 200 with `ok=true`, `database.ready=true` and no maintenance response. Then check the live application flows and re-enable automatic deployments, which remain disabled pending successful API cutover. No migration process remains running.

The active deployment's **Redeploy** dialog explicitly reuses its exact configuration, so that action would retain its maintenance command. Use the current service settings for the recovery release.
