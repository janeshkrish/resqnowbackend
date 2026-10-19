# Database refactor and TiDB deployment verification - 2026-10-15

The local backend defines **42 active tables** under `models/schema/`. The original code defined 46 and the preceding UUID refactor defined 45. Shared notes replace the technician/customer note tables. Existing admin actions now also hold approval and HTTP audit events distinguished by source. OTP challenges and throttle counters share one row per destination. Historical financial and operational records remain distinct; no summary, ID-mapping or migration-history tables are introduced.

All primary IDs and internal account references use UUIDs. Deployment startup detects legacy schemas, copies into a separate database on the same TiDB cluster, verifies transformed data and relationships, and selects the target dynamically. Every original OTP challenge and throttle record is retained in `otp_requests.migration_history` alongside current state; no superseded OTP content is discarded. Original/source data is preserved. A versioned table comment records completion. HTTP and Socket.IO reject traffic until initialization completes.

The new push-to-main GitHub workflow verifies the code, deploys maintenance-only API/worker processes on Render, drains previous instances, migrates TiDB, and releases the exact tested commit. Workers wait for API/database readiness. Each service saves its original command for failure/retry recovery. Production credentials and service IDs still require one-time GitHub configuration; no live GitHub/Render settings were changed.

Fresh verification:

- `npm.cmd test`: **555 passed, 0 failed, 0 skipped**. Includes 17 UUID tests, 13 deployment/consolidation tests, 13 production-pipeline tests and a local Socket.IO readiness/retry test alongside existing application tests.
- `npm.cmd run build`: **209 JavaScript files passed syntax checking**.
- Both `db:migrate:deploy -- --help` and `db:migrate:uuid -- --help` completed without database access.
- `deploy:production -- --help` completed without database/provider access. Workflow YAML parsing verified its main trigger, serialization, verification dependency and immutable action references; GitHub has not executed the workflow.
- `git -c core.whitespace=cr-at-eol diff --check`: passed; this checkout has mixed historical LF/CRLF endings.
- No CREATE TABLE definitions remain in db.js, routes, controllers or services. Latest/history queries use creation/event timestamps rather than treating UUID order as chronology.

Deployment tests use a stateful database double with separate schemas, metadata, row data, primary-key uniqueness, foreign-key metadata and persistent table comments. They cover deterministic UUID relationships, histories with colliding old integer IDs, binary payloads, synthetic historical admin identities, OTP state, pagination, untouched source records, content-corruption rejection, unpublished-copy recovery, nonempty-target protection, lock waiting/loss, restart preservation of new target writes, portable merged export and HTTP readiness. Socket readiness is exercised through a real local Socket.IO server/client.

Production pipeline tests use a stateful Render API double to verify credential preflight, exact-commit maintenance/release ordering, drain timing, unrelated environment preservation, native/Docker start-command recovery, failures without migration, failure retries, competing deploy rejection and API readiness before worker release. A real child-process HTTP smoke test verifies the standalone maintenance process serves probes and rejects application/webhook/upload traffic without importing the application. These checks do not certify hosted Render rollout semantics.

Limits:

- Read-only inspection of the configured hosted database failed with `ER_ACCESS_DENIED_ERROR`. Its actual table count, schema drift, row counts and query performance remain unverified. No hosted schema or data was changed.
- No real TiDB migration/restore rehearsal was possible. Database doubles do not certify TiDB DDL, privileges, advisory-lock behavior, large snapshots/GC duration or performance. Rehearse against representative staging data before production cutover.
- Identity/reference maps and selected JSON are held in memory during planning. Measure memory and transfer duration, then configure hosting startup timeouts accordingly.
- Transfer is a maintenance snapshot, not live replication. All original writers must remain stopped. The cluster retains the original database plus the 42-table target; cleanup is a separate later action. Source rollback after new target writes needs reconciliation.
- No browser/native client or live payment flow was tested. Frontend source is unchanged and must support UUID strings, refreshed sessions and coordinated clearing/draining of old-ID caches/jobs.
- During the earlier UUID refactor, generic `node --test` discovery unexpectedly executed an operational email smoke script and sent one email. The explicit `npm test` runner now excludes operational scripts; these migration checks sent no emails.

See [models/README.md](../models/README.md) for the schema and [GitHub deployment setup](github-tidb-deployment.md) for one-time secrets/variables and recovery. No database credentials or real environment values were modified.
