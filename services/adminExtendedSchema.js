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
  await runDdlWithRetry(pool, "create table admin_actions_log", () => pool.query(
    `CREATE TABLE IF NOT EXISTS admin_actions_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id VARCHAR(255) NOT NULL,
      action_type VARCHAR(120) NOT NULL,
      target_type VARCHAR(120) NOT NULL DEFAULT 'service_request',
      target_id VARCHAR(120) NOT NULL,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ));

  await runDdlWithRetry(pool, "create table technician_admin_notes", () => pool.query(
    `CREATE TABLE IF NOT EXISTS technician_admin_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      technician_id INT NOT NULL,
      admin_id VARCHAR(255) NOT NULL,
      note_type VARCHAR(64) NOT NULL DEFAULT 'note',
      note_text TEXT,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (technician_id) REFERENCES technicians(id)
    )`
  ));

  await runDdlWithRetry(pool, "create table admin_complaints", () => pool.query(
    `CREATE TABLE IF NOT EXISTS admin_complaints (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      status ENUM('open', 'assigned', 'resolved') DEFAULT 'open',
      assigned_admin_id VARCHAR(255),
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  ));

  await runDdlWithRetry(pool, "create table admin_complaint_updates", () => pool.query(
    `CREATE TABLE IF NOT EXISTS admin_complaint_updates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      complaint_id INT NOT NULL,
      update_type VARCHAR(64) NOT NULL,
      note_text TEXT,
      metadata JSON,
      created_by VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (complaint_id) REFERENCES admin_complaints(id) ON DELETE CASCADE
    )`
  ));

  await runDdlWithRetry(pool, "create table admin_audit_logs", () => pool.query(
    `CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      adminId VARCHAR(255) NOT NULL,
      actionType VARCHAR(255) NOT NULL,
      targetId VARCHAR(255),
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      metadata JSON
    )`
  ));
}

async function adminExtendedCreateIndexes(pool) {
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_actions_created_at", "(created_at)");
  await adminExtendedEnsureIndex(pool, "admin_actions_log", "idx_admin_actions_type_target", "(action_type, target_id)");
  await adminExtendedEnsureIndex(pool, "technician_admin_notes", "idx_technician_notes_tech_created", "(technician_id, created_at)");
  await adminExtendedEnsureIndex(pool, "admin_complaints", "idx_admin_complaints_status", "(status)");
  await adminExtendedEnsureIndex(pool, "admin_complaints", "idx_admin_complaints_assigned", "(assigned_admin_id)");
  await adminExtendedEnsureIndex(pool, "admin_complaint_updates", "idx_admin_complaint_updates_complaint", "(complaint_id, created_at)");
  await adminExtendedEnsureIndex(pool, "admin_audit_logs", "idx_admin_audit_admin_timestamp", "(adminId, timestamp)");
  await adminExtendedEnsureIndex(pool, "admin_audit_logs", "idx_admin_audit_action_timestamp", "(actionType, timestamp)");
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
