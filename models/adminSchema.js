import { TABLES } from "./schema/index.js";
import { getPool } from "../db.js";

let adminExtendedSchemaReadyPromise = null;
const DDL_MAX_RETRIES = 3;
const DDL_RETRY_BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDdlError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("information schema is changed during execution") ||
    message.includes("information schema changed during execution") ||
    message.includes("schema is changed during execution") ||
    message.includes("schema changed during execution")
  );
}

async function runDdlWithRetry(pool, operationName, handler) {
  for (let attempt = 1; attempt <= DDL_MAX_RETRIES; attempt += 1) {
    try {
      return await handler();
    } catch (error) {
      if (!isRetryableDdlError(error) || attempt >= DDL_MAX_RETRIES) {
        throw error;
      }

      const delayMs = DDL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[AdminExtendedSchema] Retry ${attempt}/${DDL_MAX_RETRIES} for ${operationName} after ${delayMs}ms: ${error?.message || error}`
      );
      await sleep(delayMs);
    }
  }
}

async function adminExtendedEnsureIndex(pool, tableName, indexName, definitionSql) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND index_name = ?
     LIMIT 1`,
    [tableName, indexName]
  );

  if (rows.length > 0) return;
  await runDdlWithRetry(pool, `create index ${tableName}.${indexName}`, () =>
    pool.query(`CREATE INDEX ${indexName} ON ${tableName} ${definitionSql}`)
  );
}

async function adminExtendedCreateTables(pool) {
  await pool.query(TABLES.account_notes);
  await runDdlWithRetry(pool, "create table admin_actions_log", () => pool.query(
    TABLES.admin_actions_log
  ));


  await runDdlWithRetry(pool, "create table admin_complaints", () => pool.query(
    TABLES.admin_complaints
  ));


  await runDdlWithRetry(pool, "create table admin_complaint_updates", () => pool.query(
    TABLES.admin_complaint_updates
  ));

}

async function adminExtendedCreateIndexes(pool) {
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_actions_created_at", "(created_at)");
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_actions_type_target", "(action_type, target_id)");
  await adminExtendedEnsureIndex(pool, "account_notes", "idx_account_notes_tech_created", "(technician_id, created_at)");
  await adminExtendedEnsureIndex(pool, "admin_complaints", "idx_admin_complaints_status", "(status)");
  await adminExtendedEnsureIndex(pool, "admin_complaints", "idx_admin_complaints_assigned", "(assigned_admin_id)");
  await adminExtendedEnsureIndex(pool, "admin_complaint_updates", "idx_admin_complaint_updates_complaint", "(complaint_id, created_at)");
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_log_admin_time", "(admin_id, created_at)");
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_log_source_time", "(source, created_at)");
}

export async function ensureAdminExtendedSchema() {
  if (adminExtendedSchemaReadyPromise) return adminExtendedSchemaReadyPromise;

  adminExtendedSchemaReadyPromise = (async () => {
    const pool = await getPool();
    await adminExtendedCreateTables(pool);
    await adminExtendedCreateIndexes(pool);
  })().catch((error) => {
    adminExtendedSchemaReadyPromise = null;
    throw error;
  });

  return adminExtendedSchemaReadyPromise;
}
