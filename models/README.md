# Database models, relationships and TiDB deployment migration

All **42 active table definitions** are under `models/schema/`. The preceding UUID refactor defined 45; the original backend defined 46 including separate OTP throttling. The hosted database inventory is unverified: configured credentials returned `ER_ACCESS_DENIED_ERROR` during read-only inspection on 2026-10-15.

| Group | Tables |
| --- | --- |
| Identity | users, otp_requests, device_tokens |
| Technicians | technicians, technician_fleet_vehicles, technician_team_members, technician_login_sessions, technician_activity_alerts |
| Requests | service_requests, request_timeline, request_attachments, dispatch_offers, technician_location_history, job_monitoring_alerts, reviews, user_vehicles |
| Commerce | payments, technician_dues, technician_wallets, wallet_transactions, payouts, withdrawal_requests, payout_allocations, payment_refunds, invoices, platform_pricing_config |
| Catalog and pricing | technician_services, service_master, vehicle_category_master, vehicle_subcategory_master, service_vehicle_mapping, service_pricing_field_master, towing_fleet_master, technician_service_pricing |
| Content | notifications, email_templates, files |
| Administration | account_notes, admin_actions_log, admin_complaints, admin_complaint_updates |
| Fuel prices | fuel_prices |

`bootstrap.js` owns schema additions, indexes and seeds; `adminSchema.js` owns admin initialization. `db.js` selects the deployment database and preserves existing helper imports. Historical integer-schema SQL lives in `models/migrations/legacy/`; do not apply it to a UUID database. `schema.sql` points to the canonical models.

## Table reduction

| Previous tables | Current relationship | Preservation |
| --- | --- | --- |
| technician_admin_notes + admin_customer_notes | account_notes has a users.id or technicians.id owner and a users.id author | Both histories, visibility metadata and timestamps retained; exactly one owner is required by migration and each write path |
| technician_approval_audit + admin_audit_logs + admin_actions_log | admin_actions_log uses source = approval, http or action; actor references users.id and approval technician references technicians.id | Every distinct event retained, including status transitions, reasons and HTTP metadata |
| otp_requests + otp_rate_limits | One otp_requests state row per email destination | Current challenge/counters plus every original challenge and throttle record retained in migration_history JSON |

Different legacy tables map to different UUIDs even when their old integer IDs matched. Queries filter by owner/source to retrieve each history. Approval action/status/reason fields and the customer-note response alias are preserved; approval actors use `admin_id` instead of email.

Many-to-many relationship tables such as `service_vehicle_mapping` and `payout_allocations` are necessary. Wallet entries, payment attempts, refunds, invoices, location history, login sessions and complaint updates represent distinct facts. Removing them would discard history or force duplicated/embedded data. Dashboards query source records; no summary, ID-mapping or migration-history tables are added. The retained original database is a rollback copy, so the cluster temporarily holds both original tables and the 42 target tables.

## UUIDs and queries

Every primary key is an application-generated UUID stored as `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`. `persistence.js` binds a fresh UUID for each normal, bulk or transactional INSERT. A successful single-row insert exposes it through `insertId`. Upserts must select the existing record by its unique business key instead of relying on an invented ID.

`relationships.js` records internal parents. `constraints.js` installs missing single-parent foreign keys after all tables exist. Polymorphic references use type discriminators and are checked during migration. Admins use the existing `users` table; references store its UUID instead of email/name.

Pre-registration OTP destinations, contact/message fields and immutable invoice details remain data. Google, Firebase, Razorpay, UPI and map-provider IDs retain provider formats. Counters and amounts retain their numeric types. Payment receipts/retry keys are bounded to provider/column limits. Migration rewrites known internal retry keys and nested JSON IDs.

Latest-record queries use timestamps and an ID tie breaker. UUID ordering cannot represent creation order. Customer request numbering also uses timestamps. No performance improvement is claimed without representative query plans/timings; UUID strings consume more index space than integers.

## Automatic TiDB deployment transfer

Previously migration was manual. API and standalone-worker `getPool()` now call `migrations/deploymentMigration.js` before opening the application pool. An integer schema or retired tables trigger transfer into a **separate database on the same cluster**. [TiDB restricts primary-key type changes](https://docs.pingcap.com/tidb/stable/sql-statement-modify-column/), so this path does not alter old primary keys in place.

Source records are never updated or dropped. This is a one-time maintenance transfer, not continuous replication. Stop all old API instances, workers, cron jobs and other writers throughout transfer/cutover. A snapshot cannot include later writes to the original database. Back up the source and rehearse against representative staging data before production cutover.

For automatic GitHub pushes, use [the production workflow setup](../docs/github-tidb-deployment.md). After one-time GitHub secret/variable and Render setup, that workflow deploys maintenance processes, drains old writers, runs migration, and releases the tested commit. It does not require manually enabling maintenance on every push.

Every original OTP row is stored in `otp_requests.migration_history`, including historical hashes, expiry values, counters and timestamps. Historical IDs are converted to UUIDs. Runtime verification only consumes current state and leaves migration history untouched. The migrated target therefore retains all original OTP content even though physical OTP row counts are consolidated. The ownership marker now identifies this full-preservation policy; an older target created by the previous history-retiring code is not silently reused or overwritten.

### First deployment

Keep existing TiDB host, port, username, password and TLS settings in the hosting environment. Use the existing database as `DB_NAME`:

```dotenv
DB_NAME=resqnow
DB_MIGRATION_MODE=auto
DB_MIGRATION_TARGET=resqnow_relational_v2
DB_MIGRATION_MAINTENANCE=true
```

Names above are examples; use your actual source name. Target defaults to `<DB_NAME>_relational_v2` (long names are shortened). The account needs source SELECT/schema inspection, database creation, and target CREATE/INSERT/SELECT/ALTER/DROP privileges. Target DROP only rebuilds this migration's unpublished staging copy after interruption.

1. Stop old writers, take a verified backup and drain old-ID dispatch jobs using deployment procedures.
2. Set these variables consistently on API and standalone workers. Start the API with normal `npm start`. Set the platform startup/readiness timeout to accommodate the measured transfer time.
3. Startup obtains a [cluster-wide TiDB advisory lock](https://docs.pingcap.com/tidb/v8.5/locking-functions/), preflights source identities/references, and builds 42 target tables. Unknown tables, unmapped ID columns, unknown consolidated fields, orphan references and ambiguous actors/targets stop migration.
4. It converts UUIDs, parent references, known JSON IDs, retry keys and merged histories. Binary/PDF data is copied as bound buffers in batches.
5. Every target row is read back. Counts and a multiset SHA-256 content digest must match transformed expected rows. UUID/relationship validation must pass and original foreign-key rules are restored before activation.
6. A versioned comment on the existing `users` table marks the verified database ready. The pool selects it dynamically. API bootstrap must complete before `/ready` returns 200; API routes, uploads, payment webhooks and sockets reject traffic during initialization.
7. Validate critical flows and UUID compatibility in all clients, then expose traffic. On later starts set `DB_MIGRATION_MAINTENANCE=false`. Keep database naming settings stable: startup reuses the verified target without reimporting or overwriting new records.

Other startup processes wait for the same lock for up to five minutes; configure platform restart allowance for long transfers. All target writes use the lock-owning session, so a lost lock connection cannot continue writing. After failure readiness stays false. Restarting with maintenance enabled rebuilds only tables carrying this migration's exact unpublished ownership marker; unrelated target data is refused. DDL is not rolled back automatically. The original database is never automatically deleted.

Once target writes begin, resuming old application writes against the source creates two diverging databases. A later rollback requires reconciliation/restore. Retain the original and backup until cutover is accepted.

### Alternative naming and explicit command

To have `DB_NAME` explicitly name the destination, configure this consistently from the first transfer:

```dotenv
DB_LEGACY_NAME=resqnow_old
DB_NAME=resqnow_new
DB_MIGRATION_MODE=auto
DB_MIGRATION_MAINTENANCE=true
```

The same migration can run before application startup:

```powershell
npm.cmd run db:migrate:deploy -- --maintenance
```

`--maintenance` attests that old writers are stopped. `--help` does not connect. `DB_MIGRATION_MODE=off` bypasses transfer checks for isolated tests or independently migrated deployments; API/worker schema guards still reject old integer/retired schemas. No real environment values or credentials were changed by this implementation.

## Inspection and manual fallback

```powershell
npm.cmd run db:inspect
npm.cmd run db:migrate:uuid -- --plan --plan-file <private-directory>/plan.json
npm.cmd run db:migrate:uuid -- --export <private-directory>/uuid-export.sql --maintenance
```

Inspection reads version, metadata and exact counts without data changes. Plan/export access `DB_NAME` directly, so specify the intended database. Keep plans/exports private. Export uses the same consolidation, retains schema extras for unchanged tables, binary data and original foreign-key rules. Restore only into an empty database and verify before switching `DB_NAME`. Only an export ending `EXPORT COMPLETE` with its manifest is complete.

MySQL in-place `--apply --plan-file ... --backup ... --maintenance` remains available only for UUID-only conversions on supported schemas. It refuses TiDB integer primary-key changes and schemas containing OTP or notes/audit consolidation; use the full-preservation deployment transfer or export instead.

## Verification and limits

Run `npm.cmd test` and `npm.cmd run build`. The runner explicitly selects test files and disables automatic database access in existing driver mocks; operational email scripts are excluded. Stateful database-double tests exercise preservation, content verification, interrupted recovery, ownership protection, locks, pagination, merged export and HTTP readiness. A local Socket.IO test checks initialization rejection and reconnection.

These tests do not certify actual TiDB DDL, permissions, snapshot/GC duration or hosted locking. Hosted inspection returned access denied; no live migration, staging rehearsal, benchmark or provider transaction was performed. Planning keeps identity/reference maps and selected JSON in memory; size the deployment through rehearsal.

Frontend source is unchanged. Clients must treat IDs as opaque UUID strings; existing sessions must sign in again and old-ID tracking/cache state must be cleared using deployment procedures. Verify registration/login, technician approval, request creation/dispatch/cancellation, tracking, payments, invoices, wallet credits, refunds and withdrawals before exposing traffic.
