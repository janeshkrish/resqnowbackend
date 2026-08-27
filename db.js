import mysql from "mysql2/promise";
import { EMAIL_TEMPLATE_DEFAULTS } from "./utils/emailTemplateDefaults.js";

let pool = null;
const DDL_MAX_RETRIES = 3;
const DDL_RETRY_BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeIdentifier(value) {
  return String(value || "").trim().replace(/`/g, "");
}

function extractColumnName(columnDef) {
  const match = String(columnDef || "").trim().match(/^`?([A-Za-z0-9_]+)`?/);
  return match ? match[1] : "";
}

function normalizeColumnDefault(value) {
  if (value == null) return null;
  return String(value).trim().replace(/^['"]|['"]$/g, "");
}

function isTiDbRetryableDdlError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("information schema is changed during execution") ||
    message.includes("information schema changed during execution") ||
    message.includes("schema is changed during execution") ||
    message.includes("schema changed during execution")
  );
}

async function runDdlWithRetry(poolLike, operationName, handler) {
  let lastError = null;

  for (let attempt = 1; attempt <= DDL_MAX_RETRIES; attempt += 1) {
    try {
      return await handler();
    } catch (error) {
      lastError = error;
      if (!isTiDbRetryableDdlError(error) || attempt >= DDL_MAX_RETRIES) {
        throw error;
      }

      const delayMs = DDL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[DB DDL] Retry ${attempt}/${DDL_MAX_RETRIES} for ${operationName} after ${delayMs}ms: ${error?.message || error}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function columnExists(poolLike, tableName, columnName) {
  const [rows] = await poolLike.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [normalizeIdentifier(tableName), normalizeIdentifier(columnName)]
  );
  return rows.length > 0;
}

async function getColumnMetadata(poolLike, tableName, columnName) {
  const [rows] = await poolLike.query(
    `SELECT
       data_type,
       column_type,
       column_default,
       is_nullable,
       character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [normalizeIdentifier(tableName), normalizeIdentifier(columnName)]
  );
  return rows[0] || null;
}

async function indexExists(poolLike, tableName, indexName) {
  const [rows] = await poolLike.query(
    `SELECT 1
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND index_name = ?
     LIMIT 1`,
    [normalizeIdentifier(tableName), normalizeIdentifier(indexName)]
  );
  return rows.length > 0;
}

async function ensureVarcharColumnDefinition(poolLike, tableName, columnName, length, defaultValue) {
  const metadata = await getColumnMetadata(poolLike, tableName, columnName);
  if (!metadata) return;

  const currentLength = Number(metadata.character_maximum_length || 0);
  const currentDefault = normalizeColumnDefault(metadata.column_default);
  const needsAlter =
    String(metadata.data_type || "").toLowerCase() !== "varchar" ||
    currentLength < Number(length) ||
    normalizeColumnDefault(defaultValue) !== currentDefault;

  if (!needsAlter) return;

  await runDdlWithRetry(
    poolLike,
    `modify ${tableName}.${columnName}`,
    () =>
      poolLike.query(
        `ALTER TABLE ${normalizeIdentifier(tableName)} MODIFY COLUMN ${normalizeIdentifier(columnName)} VARCHAR(${length}) DEFAULT ?`,
        [defaultValue]
      )
  );
}

async function ensureLargeReasonColumn(poolLike, tableName, columnName, minimumLength) {
  const metadata = await getColumnMetadata(poolLike, tableName, columnName);
  if (!metadata) return;

  const dataType = String(metadata.data_type || "").toLowerCase();
  const currentLength = Number(metadata.character_maximum_length || 0);
  const alreadyWideEnough =
    ["text", "mediumtext", "longtext"].includes(dataType) ||
    (dataType === "varchar" && currentLength >= Number(minimumLength));

  if (alreadyWideEnough) return;

  await runDdlWithRetry(
    poolLike,
    `modify ${tableName}.${columnName}`,
    () =>
      poolLike.query(
        `ALTER TABLE ${normalizeIdentifier(tableName)} MODIFY COLUMN ${normalizeIdentifier(columnName)} VARCHAR(${minimumLength})`
      )
  );
}

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function assertDatabaseConfig() {
  if (!isProductionLike()) return;

  const requiredKeys = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = requiredKeys.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    throw new Error(`[DB CONFIG] Missing required environment variables: ${missing.join(", ")}`);
  }

  const host = String(process.env.DB_HOST || "").trim().toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("[DB CONFIG] DB_HOST cannot point to localhost in production/Render.");
  }
}

export async function getPool() {
  assertDatabaseConfig();
  if (pool) return pool;
  const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 4000;
  const useSsl = process.env.DB_SSL === "true" || process.env.DB_SSL === "1";
  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number.isNaN(port) ? 4000 : port,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "test",
    waitForConnections: true,
    connectionLimit: 100,
    queueLimit: 0,
    ...(useSsl && {
      // TiDB Cloud uses TLS; allow non-strict verification for convenience unless user provides certs
      ssl: {
        rejectUnauthorized: process.env.DB_SSL_STRICT === 'true',
      },
    }),
  });

  // Quick connectivity check to surface helpful error messages early
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`Database connectivity test failed to ${process.env.DB_HOST}:${process.env.DB_PORT} (ssl=${process.env.DB_SSL}).`, err.message || err);
    throw err;
  }

  return pool;
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  try {
    await current.end();
  } catch (err) {
    console.error("Error while closing DB pool:", err?.message || err);
  }
}

export async function query(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

const TECHNICIANS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technicians (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  upi_id VARCHAR(120),
  upi_name VARCHAR(255),
  service_type VARCHAR(100),
  location VARCHAR(255),
  status ENUM('pending','approved','rejected') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  password_hash VARCHAR(255),
  address VARCHAR(512),
  region VARCHAR(255),
  district VARCHAR(255),
  state VARCHAR(255),
  locality VARCHAR(255),
  service_area_range INT DEFAULT 10,
  experience INT DEFAULT 0,
  specialties JSON,
  pricing JSON,
  settings JSON
)
`.trim();

export async function ensureTechniciansTable() {
  const p = await getPool();
  await p.execute(TECHNICIANS_TABLE_SQL);
}

const USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  google_id VARCHAR(255) UNIQUE,
  is_verified BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'approved',
  settings JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();

export async function ensureUsersTable() {
  const p = await getPool();
  await p.execute(USERS_TABLE_SQL);
}

const OTP_REQUESTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS otp_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_otp_email_created (email, created_at)
)
`.trim();

export async function ensureOtpRequestsTable() {
  const p = await getPool();
  await p.execute(OTP_REQUESTS_TABLE_SQL);
}

const OTP_RATE_LIMITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS otp_rate_limits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  otp_request_count INT NOT NULL DEFAULT 0,
  otp_last_request_time DATETIME NULL,
  otp_window_start_time DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_otp_rate_limits_email (email)
)
`.trim();

export async function ensureOtpRateLimitsTable() {
  const p = await getPool();
  await p.execute(OTP_RATE_LIMITS_TABLE_SQL);
}

const SERVICE_REQUESTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS service_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  technician_id INT,
  service_type VARCHAR(100) NOT NULL,
  vehicle_type VARCHAR(50),
  vehicle_model VARCHAR(100),
  address VARCHAR(512),
  description TEXT,
  location_lat FLOAT,
  location_lng FLOAT,
  drop_address VARCHAR(512),
  drop_latitude DECIMAL(10, 8),
  drop_longitude DECIMAL(11, 8),
  route_distance_km DECIMAL(10, 2),
  estimated_duration INT,
  route_metadata_json JSON,
  pricing_breakdown_json JSON,
  estimated_price DECIMAL(10, 2),
  final_price DECIMAL(10, 2),
  technician_estimated_earning DECIMAL(10, 2),
  vehicle_loaded_time DATETIME NULL,
  drop_arrival_time DATETIME NULL,
  amount DECIMAL(10, 2) DEFAULT 0.00,
  applied_coupon_code VARCHAR(64),
  applied_discount_percent DECIMAL(8,6) DEFAULT 0.000000,
  applied_discount_amount DECIMAL(10,2) DEFAULT 0.00,
  payment_status VARCHAR(50) DEFAULT 'pending',
  status VARCHAR(50) DEFAULT 'pending',
  contact_phone VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureServiceRequestsTable() {
  const p = await getPool();
  await p.execute(SERVICE_REQUESTS_TABLE_SQL);
}

const REQUEST_TIMELINE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS request_timeline (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  status VARCHAR(50) NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  actor_type VARCHAR(40) NULL,
  actor_id VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_timeline_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
)
`.trim();

export async function ensureRequestTimelineTable() {
  const p = await getPool();
  await p.execute(REQUEST_TIMELINE_TABLE_SQL);
  await addIndexIfNotExists(
    p,
    "request_timeline",
    "idx_request_timeline_request_time",
    "request_id, created_at"
  );
}

const REQUEST_ATTACHMENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS request_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(120) NULL,
  attachment_type VARCHAR(40) NOT NULL DEFAULT 'document',
  uploaded_by_type VARCHAR(40) NULL,
  uploaded_by_id VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_attachments_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
)
`.trim();

export async function ensureRequestAttachmentsTable() {
  const p = await getPool();
  await p.execute(REQUEST_ATTACHMENTS_TABLE_SQL);
  await addIndexIfNotExists(
    p,
    "request_attachments",
    "idx_request_attachments_request_time",
    "request_id, created_at"
  );
}

const TECHNICIAN_SERVICES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_services (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  service_domain VARCHAR(100) NOT NULL,
  vehicle_type VARCHAR(32) NOT NULL DEFAULT '',
  visit_charge DECIMAL(10, 2) NULL,
  service_charge DECIMAL(10, 2) NULL,
  extra_km_charge DECIMAL(10, 2) NULL,
  labour_min DECIMAL(10, 2) NULL,
  labour_max DECIMAL(10, 2) NULL,
  delivery_charge DECIMAL(10, 2) NULL,
  price_2w_min DECIMAL(10, 2) NULL,
  price_2w_max DECIMAL(10, 2) NULL,
  price_4w_min DECIMAL(10, 2) NULL,
  price_4w_max DECIMAL(10, 2) NULL,
  base_price DECIMAL(10, 2) NULL,
  free_km DECIMAL(10, 2) NULL,
  per_km_price DECIMAL(10, 2) NULL,
  night_charge DECIMAL(10, 2) NULL,
  night_type VARCHAR(16) NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_technician_services (technician_id, service_domain, vehicle_type),
  INDEX idx_technician_services_lookup (technician_id, service_domain),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianServicesTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_SERVICES_TABLE_SQL);
  await addColumnIfNotExists(p, "technician_services", "vehicle_type VARCHAR(32) NOT NULL DEFAULT ''");
  await addColumnIfNotExists(p, "technician_services", "visit_charge DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "service_charge DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "extra_km_charge DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "labour_min DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "labour_max DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "delivery_charge DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "price_2w_min DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "price_2w_max DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "price_4w_min DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "price_4w_max DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "base_price DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "free_km DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "per_km_price DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "night_charge DECIMAL(10, 2) NULL");
  await addColumnIfNotExists(p, "technician_services", "night_type VARCHAR(16) NULL");
  await addColumnIfNotExists(p, "technician_services", "metadata JSON");
}

const DISPATCH_OFFERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  service_request_id INT NOT NULL,
  technician_id INT NOT NULL,
  status ENUM('pending', 'accepted', 'rejected', 'expired') DEFAULT 'pending',
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureDispatchOffersTable() {
  const p = await getPool();
  await p.execute(DISPATCH_OFFERS_TABLE_SQL);
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_request_status", "service_request_id, status");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_request_tech", "service_request_id, technician_id");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_tech_status", "technician_id, status");
}

const TECHNICIAN_LOCATION_HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_location_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  service_request_id INT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tech_location_history_tech_time (technician_id, captured_at),
  INDEX idx_tech_location_history_request_time (service_request_id, captured_at)
)
`.trim();

export async function ensureTechnicianLocationHistoryTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_LOCATION_HISTORY_TABLE_SQL);
}

const TECHNICIAN_LOGIN_SESSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_login_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at DATETIME NULL,
  ended_reason VARCHAR(64) NULL,
  duration_seconds INT UNSIGNED DEFAULT 0,
  source VARCHAR(64) DEFAULT 'unknown',
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_tech_login_sessions_tech_login (technician_id, login_at),
  INDEX idx_tech_login_sessions_tech_logout (technician_id, logout_at),
  INDEX idx_tech_login_sessions_open (technician_id, logout_at, last_seen_at)
)
`.trim();

export async function ensureTechnicianLoginSessionsTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_LOGIN_SESSIONS_TABLE_SQL);
}

const TECHNICIAN_ACTIVITY_ALERTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_activity_alerts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  alert_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) DEFAULT 'sent',
  message TEXT,
  metadata JSON,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_technician_activity_alerts_type_time (alert_type, sent_at),
  INDEX idx_technician_activity_alerts_tech_time (technician_id, sent_at)
)
`.trim();

export async function ensureTechnicianActivityAlertsTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_ACTIVITY_ALERTS_TABLE_SQL);
}

const JOB_MONITORING_ALERTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS job_monitoring_alerts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  service_request_id INT NOT NULL,
  technician_id INT NULL,
  reason_code VARCHAR(64) NOT NULL,
  reason_text VARCHAR(255) NOT NULL,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'yellow',
  eta_minutes DECIMAL(10, 2) NULL,
  eta_arrival DATETIME NULL,
  sla_deadline DATETIME NULL,
  technician_lat DECIMAL(10, 8) NULL,
  technician_lng DECIMAL(11, 8) NULL,
  customer_lat DECIMAL(10, 8) NULL,
  customer_lng DECIMAL(11, 8) NULL,
  metadata JSON,
  is_active BOOLEAN DEFAULT TRUE,
  first_detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_job_monitoring_alerts_active (is_active, risk_level, last_detected_at),
  INDEX idx_job_monitoring_alerts_request (service_request_id, is_active),
  INDEX idx_job_monitoring_alerts_reason (reason_code, is_active)
)
`.trim();

export async function ensureJobMonitoringAlertsTable() {
  const p = await getPool();
  await p.execute(JOB_MONITORING_ALERTS_TABLE_SQL);
}

const NOTIFICATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();

export async function ensureNotificationsTable() {
  const p = await getPool();
  await p.execute(NOTIFICATIONS_TABLE_SQL);
}

const EMAIL_TEMPLATES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS email_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL UNIQUE,
  subject VARCHAR(255) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

async function seedDefaultEmailTemplates(poolLike) {
  for (const template of EMAIL_TEMPLATE_DEFAULTS) {
    await poolLike.execute(
      `INSERT INTO email_templates (event_type, subject, content)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE event_type = event_type`,
      [template.eventType, template.subject, template.content]
    );
  }
}

export async function ensureEmailTemplatesTable() {
  const p = await getPool();
  await p.execute(EMAIL_TEMPLATES_TABLE_SQL);
  await addColumnIfNotExists(p, "email_templates", "subject VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfNotExists(p, "email_templates", "content MEDIUMTEXT NOT NULL");
  await addIndexIfNotExists(p, "email_templates", "idx_email_templates_event_type", "event_type");
  await seedDefaultEmailTemplates(p);
}

const REVIEWS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  user_id INT NOT NULL,
  service_request_id INT,
  rating DECIMAL(2, 1) NOT NULL,
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensureReviewsTable() {
  const p = await getPool();
  await p.execute(REVIEWS_TABLE_SQL);
}

// Helper to add columns if they don't exist
// Using try-catch as robust way to handle "Duplicate column name" error across different MySQL versions
async function addColumnIfNotExists(pool, table, columnDef) {
  const columnName = extractColumnName(columnDef);
  if (!columnName) {
    throw new Error(`Unable to resolve column name from definition: ${columnDef}`);
  }

  if (await columnExists(pool, table, columnName)) {
    return;
  }

  try {
    await runDdlWithRetry(pool, `add column ${table}.${columnName}`, () =>
      pool.query(`ALTER TABLE ${normalizeIdentifier(table)} ADD COLUMN ${columnDef}`)
    );
  } catch (err) {
    // Ignore duplicate column error (code 1060: Duplicate column name)
    // Also ignore if it says something like "Duplicate field name"
    if (err.code !== 'ER_DUP_FIELDNAME' && err.errno !== 1060 && !err.message?.includes("Duplicate column")) {
      console.log(`Note: Could not add column ${columnDef} to ${table}, might already exist. Error: ${err.message}`);
    }
  }
}

async function addIndexIfNotExists(pool, table, indexName, columnsSql) {
  if (await indexExists(pool, table, indexName)) {
    return;
  }

  try {
    await runDdlWithRetry(pool, `create index ${table}.${indexName}`, () =>
      pool.query(
        `CREATE INDEX ${normalizeIdentifier(indexName)} ON ${normalizeIdentifier(table)} (${columnsSql})`
      )
    );
  } catch (err) {
    const message = String(err?.message || "");
    const isDuplicateIndex =
      err.code === "ER_DUP_KEYNAME" ||
      err.code === "ER_DUP_INDEX" ||
      err.errno === 1061 ||
      message.includes("Duplicate key name") ||
      message.includes("already exists");
    if (!isDuplicateIndex) {
      console.log(`Note: Could not add index ${indexName} on ${table}. Error: ${message}`);
    }
  }
}

async function addUniqueIndexIfNotExists(pool, table, indexName, columnsSql) {
  if (await indexExists(pool, table, indexName)) {
    return;
  }

  try {
    await runDdlWithRetry(pool, `create unique index ${table}.${indexName}`, () =>
      pool.query(
        `CREATE UNIQUE INDEX ${normalizeIdentifier(indexName)} ON ${normalizeIdentifier(table)} (${columnsSql})`
      )
    );
  } catch (err) {
    const message = String(err?.message || "");
    const isDuplicateIndex =
      err.code === "ER_DUP_KEYNAME" ||
      err.code === "ER_DUP_INDEX" ||
      err.errno === 1061 ||
      message.includes("Duplicate key name") ||
      message.includes("already exists");
    if (!isDuplicateIndex) {
      console.log(`Note: Could not add unique index ${indexName} on ${table}. Error: ${message}`);
    }
  }
}

export async function updateTechniciansTableSchema() {
  const p = await getPool();
  await addColumnIfNotExists(p, 'technicians', 'is_active BOOLEAN DEFAULT FALSE');
  await addColumnIfNotExists(p, 'technicians', 'is_available BOOLEAN DEFAULT FALSE');
  await addColumnIfNotExists(p, 'technicians', 'is_logged_in BOOLEAN DEFAULT FALSE');
  await addColumnIfNotExists(p, 'technicians', 'latitude DECIMAL(10, 8)');
  await addColumnIfNotExists(p, 'technicians', 'longitude DECIMAL(11, 8)');
  await addColumnIfNotExists(p, 'technicians', 'current_lat DECIMAL(10, 8)');
  await addColumnIfNotExists(p, 'technicians', 'current_lng DECIMAL(11, 8)');
  await addColumnIfNotExists(p, 'technicians', 'last_location_update DATETIME NULL');
  await addColumnIfNotExists(p, 'technicians', 'last_login_at DATETIME NULL');
  await addColumnIfNotExists(p, 'technicians', 'last_logout_at DATETIME NULL');
  await addColumnIfNotExists(p, 'technicians', 'last_seen_at DATETIME NULL');
  await addColumnIfNotExists(p, 'technicians', 'login_reminder_sent_at DATETIME NULL');
  await addColumnIfNotExists(p, 'technicians', 'acceptance_rate DECIMAL(5,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technicians', 'skill_set JSON');
  await addColumnIfNotExists(p, 'technicians', 'current_job_id INT');
  // New columns for comprehensive technician data model
  await addColumnIfNotExists(p, 'technicians', 'resume_url VARCHAR(1024)');
  await addColumnIfNotExists(p, 'technicians', 'documents JSON');
  await addColumnIfNotExists(p, 'technicians', 'upi_id VARCHAR(120)');
  await addColumnIfNotExists(p, 'technicians', 'upi_name VARCHAR(255)');
  try {
    await p.query(
      `UPDATE technicians
       SET upi_id = JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id'))
       WHERE (upi_id IS NULL OR TRIM(upi_id) = '')
         AND payment_details IS NOT NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id')) IS NOT NULL
         AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_id'))) <> ''`
    );
  } catch (err) {
    console.log("Note: could not backfill technicians.upi_id from payment_details:", err.message);
  }
  try {
    await p.query(
      `UPDATE technicians
       SET upi_name = COALESCE(
         NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_name'))), ''),
         NULLIF(TRIM(proprietor_name), ''),
         NULLIF(TRIM(name), '')
       )
       WHERE upi_name IS NULL OR TRIM(upi_name) = ''`
    );
  } catch (err) {
    console.log("Note: could not backfill technicians.upi_name:", err.message);
  }
  await addColumnIfNotExists(p, 'technicians', 'proprietor_name VARCHAR(255)');
  await addColumnIfNotExists(p, 'technicians', 'alternate_phone VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'whatsapp_number VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'google_maps_link VARCHAR(1024)');
  await addColumnIfNotExists(p, 'technicians', 'aadhaar_number VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'pan_number VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'business_type VARCHAR(100)');
  await addColumnIfNotExists(p, 'technicians', 'gst_number VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'trade_license_number VARCHAR(50)');
  await addColumnIfNotExists(p, 'technicians', 'working_hours JSON');
  await addColumnIfNotExists(p, 'technicians', 'service_costs JSON');
  await addColumnIfNotExists(p, 'technicians', 'payment_details JSON');
  await addColumnIfNotExists(p, 'technicians', 'app_readiness JSON');
  await addColumnIfNotExists(p, 'technicians', 'vehicle_types JSON');
  await addColumnIfNotExists(p, 'technicians', 'settings JSON');

  await addColumnIfNotExists(p, 'technicians', 'registration_payment_status VARCHAR(50) DEFAULT "pending"');
  await addColumnIfNotExists(p, 'technicians', 'registration_payment_id VARCHAR(255)');
  await addColumnIfNotExists(p, 'technicians', 'registration_order_id VARCHAR(255)');

  // Columns already present in CREATE TABLE but added here for migration safety if table existed before
  await addColumnIfNotExists(p, 'technicians', 'jobs_completed INT DEFAULT 0');
  await addColumnIfNotExists(p, 'technicians', 'total_earnings DECIMAL(12, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technicians', 'rating DECIMAL(3, 2) DEFAULT 5.00');

  await addIndexIfNotExists(p, "technicians", "idx_technicians_is_logged_in", "is_logged_in");
  await addIndexIfNotExists(p, "technicians", "idx_technicians_last_seen_at", "last_seen_at");
  await addIndexIfNotExists(p, "technicians", "idx_technicians_login_reminder", "login_reminder_sent_at");

  // New column for user phone
  await addColumnIfNotExists(p, 'users', 'phone VARCHAR(50)');
}

const FILES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) UNIQUE NOT NULL,
  content LONGBLOB NOT NULL,
  mimetype VARCHAR(100),
  size INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();

export async function ensureFilesTable() {
  const p = await getPool();
  await p.execute(FILES_TABLE_SQL);
}

const USER_VEHICLES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS user_vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  make VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  license_plate VARCHAR(50),
  status VARCHAR(32) DEFAULT 'ready',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
`.trim();

export async function ensureUserVehiclesTable() {
  const p = await getPool();
  await p.execute(USER_VEHICLES_TABLE_SQL);
  await addColumnIfNotExists(p, 'user_vehicles', "status VARCHAR(32) DEFAULT 'ready'");
}

const TECHNICIAN_FLEET_VEHICLES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_fleet_vehicles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  vehicle_type VARCHAR(64) NOT NULL,
  vehicle_number VARCHAR(64) NOT NULL,
  capacity VARCHAR(64) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'available',
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_technician_fleet_vehicle_number (technician_id, vehicle_number),
  INDEX idx_technician_fleet_vehicles_lookup (technician_id, status, updated_at),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianFleetVehiclesTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_FLEET_VEHICLES_TABLE_SQL);
  await addColumnIfNotExists(p, "technician_fleet_vehicles", "capacity VARCHAR(64) NULL");
  await addColumnIfNotExists(p, "technician_fleet_vehicles", "status VARCHAR(24) NOT NULL DEFAULT 'available'");
  await addColumnIfNotExists(p, "technician_fleet_vehicles", "metadata JSON NULL");
  await addColumnIfNotExists(p, "technician_fleet_vehicles", "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  await addIndexIfNotExists(
    p,
    "technician_fleet_vehicles",
    "idx_technician_fleet_vehicles_lookup",
    "technician_id, status, updated_at"
  );
}

const TECHNICIAN_TEAM_MEMBERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_team_members (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'driver',
  assigned_vehicle_id BIGINT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_technician_team_members_lookup (technician_id, status, updated_at),
  INDEX idx_technician_team_members_vehicle (assigned_vehicle_id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianTeamMembersTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_TEAM_MEMBERS_TABLE_SQL);
  await addColumnIfNotExists(p, "technician_team_members", "assigned_vehicle_id BIGINT NULL");
  await addColumnIfNotExists(p, "technician_team_members", "status VARCHAR(24) NOT NULL DEFAULT 'active'");
  await addColumnIfNotExists(p, "technician_team_members", "metadata JSON NULL");
  await addColumnIfNotExists(p, "technician_team_members", "updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  await addIndexIfNotExists(
    p,
    "technician_team_members",
    "idx_technician_team_members_lookup",
    "technician_id, status, updated_at"
  );
  await addIndexIfNotExists(
    p,
    "technician_team_members",
    "idx_technician_team_members_vehicle",
    "assigned_vehicle_id"
  );
}

const DEVICE_TOKENS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS device_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  user_type ENUM('user', 'technician') NOT NULL,
  token VARCHAR(512) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, user_type)
)
`.trim();

export async function ensureDeviceTokensTable() {
  const p = await getPool();
  await p.execute(DEVICE_TOKENS_TABLE_SQL);
}

const PAYMENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  service_request_id INT NOT NULL,
  payment_method VARCHAR(50) DEFAULT 'razorpay',
  status VARCHAR(50) DEFAULT 'pending',
  currency VARCHAR(10) DEFAULT 'INR',
  amount DECIMAL(10, 2),
  base_amount DECIMAL(10, 2) DEFAULT 0.00,
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255),
  razorpay_signature VARCHAR(255),
  platform_fee DECIMAL(10, 2) DEFAULT 0.00,
  payment_fee DECIMAL(10, 2) DEFAULT 0.00,
  technician_amount DECIMAL(10, 2) DEFAULT 0.00,
  refunded_amount DECIMAL(10, 2) DEFAULT 0.00,
  refund_status VARCHAR(20) DEFAULT 'none',
  is_settled BOOLEAN DEFAULT TRUE,
  payment_to_technician_status VARCHAR(20) DEFAULT 'pending',
  ledger_status VARCHAR(20) DEFAULT 'pending',
  wallet_transaction_id BIGINT NULL,
  pricing_snapshot JSON,
  verified_at DATETIME NULL,
  captured_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensurePaymentsTable() {
  const p = await getPool();
  await p.execute(PAYMENTS_TABLE_SQL);
  // Ensure columns exist if table already existed without them
  await addColumnIfNotExists(p, 'payments', 'currency VARCHAR(10) DEFAULT "INR"');
  await addColumnIfNotExists(p, 'payments', 'base_amount DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'platform_fee DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'payment_fee DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'technician_amount DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'refunded_amount DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'refund_status VARCHAR(20) DEFAULT "none"');
  await addColumnIfNotExists(p, 'payments', 'is_settled BOOLEAN DEFAULT TRUE');
  await addColumnIfNotExists(p, 'payments', "payment_to_technician_status VARCHAR(20) DEFAULT 'pending'");
  await addColumnIfNotExists(p, 'payments', "ledger_status VARCHAR(20) DEFAULT 'pending'");
  await addColumnIfNotExists(p, 'payments', 'wallet_transaction_id BIGINT NULL');
  await addColumnIfNotExists(p, 'payments', 'pricing_snapshot JSON');
  await addColumnIfNotExists(p, 'payments', 'verified_at DATETIME NULL');
  await addColumnIfNotExists(p, 'payments', 'captured_at DATETIME NULL');
}

export async function updatePaymentsTableSchema() {
  const p = await getPool();
  try {
    await ensureVarcharColumnDefinition(p, "payments", "status", 50, "pending");
  } catch (err) {
    console.log("Note: could not modify payments.status column:", err.message);
  }

  await addColumnIfNotExists(p, "payments", "payment_to_technician_status VARCHAR(20) DEFAULT 'pending'");
  await addColumnIfNotExists(p, "payments", "currency VARCHAR(10) DEFAULT 'INR'");
  await addColumnIfNotExists(p, "payments", "base_amount DECIMAL(10, 2) DEFAULT 0.00");
  await addColumnIfNotExists(p, "payments", "payment_fee DECIMAL(10, 2) DEFAULT 0.00");
  await addColumnIfNotExists(p, "payments", "refunded_amount DECIMAL(10, 2) DEFAULT 0.00");
  await addColumnIfNotExists(p, "payments", "refund_status VARCHAR(20) DEFAULT 'none'");
  await addColumnIfNotExists(p, "payments", "ledger_status VARCHAR(20) DEFAULT 'pending'");
  await addColumnIfNotExists(p, "payments", "wallet_transaction_id BIGINT NULL");
  await addColumnIfNotExists(p, "payments", "pricing_snapshot JSON");
  await addColumnIfNotExists(p, "payments", "verified_at DATETIME NULL");
  await addColumnIfNotExists(p, "payments", "captured_at DATETIME NULL");
  try {
    await p.query(
      `UPDATE payments
       SET payment_to_technician_status = 'pending'
       WHERE payment_to_technician_status IS NULL OR TRIM(payment_to_technician_status) = ''`
    );
  } catch (err) {
    console.log("Note: could not normalize payments.payment_to_technician_status:", err.message);
  }

  try {
    await p.query(
      `UPDATE payments
       SET ledger_status = 'pending'
       WHERE ledger_status IS NULL OR TRIM(ledger_status) = ''`
    );
  } catch (err) {
    console.log("Note: could not normalize payments.ledger_status:", err.message);
  }

  await addIndexIfNotExists(p, "payments", "idx_payments_request_status", "service_request_id, status");
  await addIndexIfNotExists(p, "payments", "idx_payments_technician_payout_status", "payment_to_technician_status");
  await addIndexIfNotExists(p, "payments", "idx_payments_wallet_transaction", "wallet_transaction_id");
  await addUniqueIndexIfNotExists(p, "payments", "uniq_payments_razorpay_order_id", "razorpay_order_id");
  await addUniqueIndexIfNotExists(p, "payments", "uniq_payments_razorpay_payment_id", "razorpay_payment_id");
}

const TECHNICIAN_DUES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_dues (
  id INT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  service_request_id INT,
  amount DECIMAL(10, 2) NOT NULL,
  reason VARCHAR(255),
  status ENUM('pending', 'paid') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensureTechnicianDuesTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_DUES_TABLE_SQL);
  await addColumnIfNotExists(p, 'technician_dues', 'service_request_id INT');
}

const TECHNICIAN_WALLETS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_wallets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL UNIQUE,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  total_earned DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  withdrawable_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  total_paid_out DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  on_hold_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  last_transaction_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianWalletsTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_WALLETS_TABLE_SQL);
  await addColumnIfNotExists(p, 'technician_wallets', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'technician_wallets', 'total_earned DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'withdrawable_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'total_paid_out DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'on_hold_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'last_transaction_at DATETIME NULL');
}

const WALLET_TRANSACTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_id BIGINT NOT NULL,
  technician_id INT NOT NULL,
  service_request_id INT NULL,
  payment_id INT NULL,
  payout_id BIGINT NULL,
  entry_type VARCHAR(40) NOT NULL,
  direction ENUM('credit', 'debit') NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  allocated_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  balance_before DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  balance_after DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  description VARCHAR(255) NULL,
  reference_type VARCHAR(40) NULL,
  reference_id VARCHAR(64) NULL,
  idempotency_key VARCHAR(128) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wallet_id) REFERENCES technician_wallets(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id)
)
`.trim();

export async function ensureWalletTransactionsTable() {
  const p = await getPool();
  await p.execute(WALLET_TRANSACTIONS_TABLE_SQL);
  await addColumnIfNotExists(p, 'wallet_transactions', 'allocated_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'wallet_transactions', 'description VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'wallet_transactions', 'reference_type VARCHAR(40) NULL');
  await addColumnIfNotExists(p, 'wallet_transactions', 'reference_id VARCHAR(64) NULL');
  await addColumnIfNotExists(p, 'wallet_transactions', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'wallet_transactions', 'metadata JSON NULL');
  await addIndexIfNotExists(p, 'wallet_transactions', 'idx_wallet_transactions_technician_time', 'technician_id, created_at');
  await addIndexIfNotExists(p, 'wallet_transactions', 'idx_wallet_transactions_payment', 'payment_id');
  await addIndexIfNotExists(p, 'wallet_transactions', 'idx_wallet_transactions_payout', 'payout_id');
  await addUniqueIndexIfNotExists(p, 'wallet_transactions', 'uniq_wallet_transactions_idempotency_key', 'idempotency_key');
}

const PAYOUTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payouts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payout_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  withdrawal_request_id BIGINT NULL,
  technician_id INT NOT NULL,
  wallet_id BIGINT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  payout_method VARCHAR(40) NULL,
  destination_reference VARCHAR(255) NULL,
  destination_name VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  notes TEXT NULL,
  created_by VARCHAR(255) NULL,
  processed_by VARCHAR(255) NULL,
  processed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (wallet_id) REFERENCES technician_wallets(id)
)
`.trim();

export async function ensurePayoutsTable() {
  const p = await getPool();
  await p.execute(PAYOUTS_TABLE_SQL);
  await addColumnIfNotExists(p, 'payouts', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'payouts', 'withdrawal_request_id BIGINT NULL');
  await addColumnIfNotExists(p, 'payouts', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'payouts', 'status VARCHAR(20) NOT NULL DEFAULT "draft"');
  await addColumnIfNotExists(p, 'payouts', 'payout_method VARCHAR(40) NULL');
  await addColumnIfNotExists(p, 'payouts', 'destination_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'destination_name VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'notes TEXT NULL');
  await addColumnIfNotExists(p, 'payouts', 'created_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'processed_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'processed_at DATETIME NULL');
  await addIndexIfNotExists(p, 'payouts', 'idx_payouts_technician_status', 'technician_id, status');
  await addIndexIfNotExists(p, 'payouts', 'idx_payouts_processed_at', 'processed_at');
  await addUniqueIndexIfNotExists(p, 'payouts', 'uniq_payouts_withdrawal_request', 'withdrawal_request_id');
  await addUniqueIndexIfNotExists(p, 'payouts', 'uniq_payouts_idempotency_key', 'idempotency_key');
}

const WITHDRAWAL_REQUESTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  withdrawal_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  technician_id INT NOT NULL,
  wallet_id BIGINT NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  upi_id VARCHAR(120) NULL,
  beneficiary_name VARCHAR(255) NULL,
  note TEXT NULL,
  rejection_reason VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  requested_by VARCHAR(255) NULL,
  reviewed_by VARCHAR(255) NULL,
  processed_by VARCHAR(255) NULL,
  processing_started_at DATETIME NULL,
  paid_at DATETIME NULL,
  rejected_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (wallet_id) REFERENCES technician_wallets(id)
)
`.trim();

export async function ensureWithdrawalRequestsTable() {
  const p = await getPool();
  await p.execute(WITHDRAWAL_REQUESTS_TABLE_SQL);
  await addColumnIfNotExists(p, 'withdrawal_requests', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'status VARCHAR(20) NOT NULL DEFAULT "pending"');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'upi_id VARCHAR(120) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'beneficiary_name VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'note TEXT NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'rejection_reason VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'requested_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'reviewed_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'processed_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'processing_started_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'paid_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'rejected_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'cancelled_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'metadata JSON NULL');
  await addIndexIfNotExists(p, 'withdrawal_requests', 'idx_withdrawal_requests_technician_status', 'technician_id, status');
  await addIndexIfNotExists(p, 'withdrawal_requests', 'idx_withdrawal_requests_status_created', 'status, created_at');
  await addUniqueIndexIfNotExists(p, 'withdrawal_requests', 'uniq_withdrawal_requests_idempotency_key', 'idempotency_key');
}

const PAYOUT_ALLOCATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payout_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payout_id BIGINT NOT NULL,
  wallet_transaction_id BIGINT NOT NULL,
  payment_id INT NULL,
  service_request_id INT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payout_id) REFERENCES payouts(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES wallet_transactions(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensurePayoutAllocationsTable() {
  const p = await getPool();
  await p.execute(PAYOUT_ALLOCATIONS_TABLE_SQL);
  await addIndexIfNotExists(p, 'payout_allocations', 'idx_payout_allocations_payout', 'payout_id');
  await addIndexIfNotExists(p, 'payout_allocations', 'idx_payout_allocations_wallet_txn', 'wallet_transaction_id');
}

const PAYMENT_REFUNDS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS payment_refunds (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  refund_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  payment_id INT NOT NULL,
  service_request_id INT NOT NULL,
  technician_id INT NULL,
  wallet_transaction_id BIGINT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  technician_adjustment_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(30) NOT NULL DEFAULT 'processed',
  reason VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  requested_by VARCHAR(255) NULL,
  processed_at DATETIME NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensurePaymentRefundsTable() {
  const p = await getPool();
  await p.execute(PAYMENT_REFUNDS_TABLE_SQL);
  await addColumnIfNotExists(p, 'payment_refunds', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'wallet_transaction_id BIGINT NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'technician_adjustment_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payment_refunds', 'status VARCHAR(30) NOT NULL DEFAULT "processed"');
  await addColumnIfNotExists(p, 'payment_refunds', 'reason VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'requested_by VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'processed_at DATETIME NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'metadata JSON NULL');
  await addIndexIfNotExists(p, 'payment_refunds', 'idx_payment_refunds_payment', 'payment_id');
  await addIndexIfNotExists(p, 'payment_refunds', 'idx_payment_refunds_technician', 'technician_id, created_at');
  await addUniqueIndexIfNotExists(p, 'payment_refunds', 'uniq_payment_refunds_idempotency_key', 'idempotency_key');
}

// Invoices table keeps generated invoice PDF in TiDB (LONGBLOB) for Render-safe storage.
const INVOICES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  razorpay_payment_id VARCHAR(255),
  amount DECIMAL(10,2),
  invoice_pdf LONGBLOB,
  status VARCHAR(50) DEFAULT 'GENERATED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  service_request_id INT,
  technician_id INT,
  platform_fee DECIMAL(12,2) DEFAULT 0.00,
  payment_fee DECIMAL(12,2) DEFAULT 0.00,
  technician_amount DECIMAL(12,2) DEFAULT 0.00,
  gst DECIMAL(12,2) DEFAULT 0.00,
  total_amount DECIMAL(12,2) DEFAULT 0.00,
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensureInvoicesTable() {
  const p = await getPool();
  await p.execute(INVOICES_TABLE_SQL);
  await addColumnIfNotExists(p, 'invoices', 'user_id INT NOT NULL DEFAULT 0');
  await addColumnIfNotExists(p, 'invoices', 'order_id VARCHAR(255) NOT NULL DEFAULT ""');
  await addColumnIfNotExists(p, 'invoices', 'razorpay_payment_id VARCHAR(255)');
  await addColumnIfNotExists(p, 'invoices', 'amount DECIMAL(10,2)');
  await addColumnIfNotExists(p, 'invoices', 'invoice_pdf LONGBLOB');
  await addColumnIfNotExists(p, 'invoices', 'status VARCHAR(50) DEFAULT "GENERATED"');
  await addColumnIfNotExists(p, 'invoices', 'service_request_id INT');
  await addColumnIfNotExists(p, 'invoices', 'technician_id INT');
  await addColumnIfNotExists(p, 'invoices', 'platform_fee DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'payment_fee DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'technician_amount DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'gst DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'total_amount DECIMAL(12,2) DEFAULT 0.00');
}

const PLATFORM_PRICING_CONFIG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS platform_pricing_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  platform_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000,
  payment_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.020000,
  customer_price_rounding_increment INT NOT NULL DEFAULT 5,
  welcome_coupon_code VARCHAR(64) NOT NULL DEFAULT 'RESQ10',
  welcome_coupon_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000,
  welcome_coupon_max_uses_per_user INT NOT NULL DEFAULT 2,
  welcome_coupon_active BOOLEAN DEFAULT TRUE,
  registration_fee DECIMAL(12,2) NOT NULL DEFAULT 500.00,
  booking_fee DECIMAL(12,2) NOT NULL DEFAULT 199.00,
  pay_now_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.000000,
  default_service_amount DECIMAL(12,2) NOT NULL DEFAULT 500.00,
  service_base_prices JSON,
  towing_pricing_rules JSON,
  subscription_plans JSON,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

export async function ensurePlatformPricingConfigTable() {
  const p = await getPool();
  await p.execute(PLATFORM_PRICING_CONFIG_TABLE_SQL);
  await addColumnIfNotExists(p, 'platform_pricing_config', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'platform_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'payment_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.020000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'customer_price_rounding_increment INT NOT NULL DEFAULT 5');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_code VARCHAR(64) NOT NULL DEFAULT "RESQ10"');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_max_uses_per_user INT NOT NULL DEFAULT 2');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_active BOOLEAN DEFAULT TRUE');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'registration_fee DECIMAL(12,2) NOT NULL DEFAULT 500.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'booking_fee DECIMAL(12,2) NOT NULL DEFAULT 199.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'pay_now_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.000000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'default_service_amount DECIMAL(12,2) NOT NULL DEFAULT 500.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'service_base_prices JSON');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'towing_pricing_rules JSON');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'subscription_plans JSON');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'is_active BOOLEAN DEFAULT TRUE');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
}

const TECHNICIAN_APPROVAL_AUDIT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_approval_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  action ENUM('approved', 'rejected') NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  reason TEXT,
  admin_email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianApprovalAuditTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_APPROVAL_AUDIT_TABLE_SQL);
  await addColumnIfNotExists(p, 'technician_approval_audit', 'reason TEXT');
  await addColumnIfNotExists(p, 'technician_approval_audit', 'previous_status VARCHAR(50)');
  await addColumnIfNotExists(p, 'technician_approval_audit', 'admin_email VARCHAR(255)');
}

export async function updateServiceRequestsTableSchema() {
  const p = await getPool();
  // Add fields that may be missing on older DB installs
  await addColumnIfNotExists(p, 'service_requests', 'vehicle_model VARCHAR(255)');
  await addColumnIfNotExists(p, 'service_requests', 'vehicle_type VARCHAR(100)');
  await addColumnIfNotExists(p, 'service_requests', 'description TEXT');
  await addColumnIfNotExists(p, 'service_requests', 'service_charge DECIMAL(10,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'service_requests', 'applied_coupon_code VARCHAR(64)');
  await addColumnIfNotExists(p, 'service_requests', 'applied_discount_percent DECIMAL(8,6) DEFAULT 0.000000');
  await addColumnIfNotExists(p, 'service_requests', 'applied_discount_amount DECIMAL(10,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'service_requests', 'payment_method VARCHAR(50)');
  await addColumnIfNotExists(p, 'service_requests', 'contact_name VARCHAR(255)');
  await addColumnIfNotExists(p, 'service_requests', 'contact_email VARCHAR(255)');
  await addColumnIfNotExists(p, 'service_requests', 'contact_phone VARCHAR(50)');
  await addColumnIfNotExists(p, 'service_requests', 'address VARCHAR(512)');
  await addColumnIfNotExists(p, 'service_requests', 'location_lat FLOAT');
  await addColumnIfNotExists(p, 'service_requests', 'location_lng FLOAT');
  await addColumnIfNotExists(p, 'service_requests', 'drop_address VARCHAR(512)');
  await addColumnIfNotExists(p, 'service_requests', 'drop_latitude DECIMAL(10, 8)');
  await addColumnIfNotExists(p, 'service_requests', 'drop_longitude DECIMAL(11, 8)');
  await addColumnIfNotExists(p, 'service_requests', 'route_distance_km DECIMAL(10, 2)');
  await addColumnIfNotExists(p, 'service_requests', 'estimated_duration INT');
  await addColumnIfNotExists(p, 'service_requests', 'route_metadata_json JSON');
  await addColumnIfNotExists(p, 'service_requests', 'pricing_breakdown_json JSON');
  await addColumnIfNotExists(p, 'service_requests', 'estimated_price DECIMAL(10, 2)');
  await addColumnIfNotExists(p, 'service_requests', 'final_price DECIMAL(10, 2)');
  await addColumnIfNotExists(p, 'service_requests', 'technician_estimated_earning DECIMAL(10, 2)');
  await addColumnIfNotExists(p, 'service_requests', 'vehicle_loaded_time DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'drop_arrival_time DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'pricing_override_json JSON');
  await addColumnIfNotExists(p, 'service_requests', 'pricing_overridden_by VARCHAR(255)');
  await addColumnIfNotExists(p, 'service_requests', 'pricing_overridden_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'started_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'completed_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'cancelled_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'cancellation_reason VARCHAR(512)');
  await addColumnIfNotExists(p, 'service_requests', 'closing_reason VARCHAR(512)');
  await addColumnIfNotExists(p, 'service_requests', 'accepted_time DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'start_time DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'scheduled_time DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'sla_deadline DATETIME NULL');
  await addColumnIfNotExists(p, 'service_requests', 'customer_location_lat DECIMAL(10, 8)');
  await addColumnIfNotExists(p, 'service_requests', 'customer_location_lng DECIMAL(11, 8)');
  await addColumnIfNotExists(p, 'service_requests', 'assigned_vehicle_id BIGINT NULL');
  await addColumnIfNotExists(p, 'service_requests', 'assigned_employee_id BIGINT NULL');

  // Ensure status column can hold longer status strings like 'payment_pending'
  try {
    // Changing to VARCHAR(50) to be flexible and avoid "Data too long" for longer status strings
    await ensureVarcharColumnDefinition(p, "service_requests", "status", 50, "pending");
  } catch (err) {
    // Ignore if modify fails on some DB versions, but log for visibility
    console.log("Note: could not modify service_requests.status column:", err.message);
  }

  try {
    await ensureVarcharColumnDefinition(p, "service_requests", "payment_status", 50, "pending");
  } catch (err) {
    console.log("Note: could not modify service_requests.payment_status column:", err.message);
  }

  try {
    await ensureLargeReasonColumn(p, "service_requests", "cancellation_reason", 1024);
  } catch (err) {
    console.log("Note: could not modify service_requests.cancellation_reason column:", err.message);
  }

  // Monitoring and admin filters rely heavily on these columns.
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_status", "status");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_technician_status", "technician_id, status");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_created_at", "created_at");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_updated_at", "updated_at");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_towing_route", "service_type, route_distance_km");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_assigned_vehicle", "assigned_vehicle_id");
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_assigned_employee", "assigned_employee_id");
}

export async function updateUsersTableSchema() {
  const p = await getPool();
  await addColumnIfNotExists(p, 'users', 'role VARCHAR(32) DEFAULT "user"');
  await addColumnIfNotExists(p, 'users', 'subscription VARCHAR(50) DEFAULT "free"');
  await addColumnIfNotExists(p, 'users', 'phone VARCHAR(50)');
  await addColumnIfNotExists(p, 'users', 'birthday DATE');
  await addColumnIfNotExists(p, 'users', 'gender VARCHAR(20)');
  await addColumnIfNotExists(p, 'users', 'settings JSON');
}

// --- Dynamic Service Configuration Tables ---

const SERVICE_MASTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS service_master (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    service_name VARCHAR(255) NOT NULL,
    service_slug VARCHAR(255) UNIQUE,
    description TEXT,
    icon VARCHAR(255),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

export async function ensureServiceMasterTable() {
  const p = await getPool();
  await p.execute(SERVICE_MASTER_TABLE_SQL);
}

const VEHICLE_CATEGORY_MASTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS vehicle_category_master (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    category_name VARCHAR(100),
    description TEXT,
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export async function ensureVehicleCategoryMasterTable() {
  const p = await getPool();
  await p.execute(VEHICLE_CATEGORY_MASTER_TABLE_SQL);
}

const VEHICLE_SUBCATEGORY_MASTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS vehicle_subcategory_master (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    vehicle_category_id BIGINT,
    subcategory_name VARCHAR(255),
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export async function ensureVehicleSubcategoryMasterTable() {
  const p = await getPool();
  await p.execute(VEHICLE_SUBCATEGORY_MASTER_TABLE_SQL);
}

const SERVICE_VEHICLE_MAPPING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS service_vehicle_mapping (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    service_id BIGINT,
    vehicle_category_id BIGINT
)
`.trim();

export async function ensureServiceVehicleMappingTable() {
  const p = await getPool();
  await p.execute(SERVICE_VEHICLE_MAPPING_TABLE_SQL);
}

const SERVICE_PRICING_FIELD_MASTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS service_pricing_field_master (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    service_id BIGINT,
    field_key VARCHAR(255),
    field_label VARCHAR(255),
    field_type VARCHAR(50),
    required BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0
)
`.trim();

export async function ensureServicePricingFieldMasterTable() {
  const p = await getPool();
  await p.execute(SERVICE_PRICING_FIELD_MASTER_TABLE_SQL);
}

const TOWING_FLEET_MASTER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS towing_fleet_master (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    fleet_name VARCHAR(255),
    description TEXT,
    active BOOLEAN DEFAULT TRUE
)
`.trim();

export async function ensureTowingFleetMasterTable() {
  const p = await getPool();
  await p.execute(TOWING_FLEET_MASTER_TABLE_SQL);
}

const TECHNICIAN_SERVICE_PRICING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS technician_service_pricing (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    technician_id INT,
    service_id BIGINT,
    vehicle_category_id BIGINT,
    vehicle_subcategory_id BIGINT NULL,
    fleet_id BIGINT NULL,
    pricing_json JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export async function ensureTechnicianServicePricingTable() {
  const p = await getPool();
  await p.execute(TECHNICIAN_SERVICE_PRICING_TABLE_SQL);
}

export async function seedInitialServiceConfig() {
  const p = await getPool();
  
  // Seed Vehicle Categories
  const [catRows] = await p.query("SELECT COUNT(*) as count FROM vehicle_category_master");
  if (catRows[0].count === 0) {
    await p.query("INSERT INTO vehicle_category_master (category_name) VALUES ('Bike'), ('Car'), ('Commercial'), ('EV')");
  }
  
  // Seed Services
  const [svcRows] = await p.query("SELECT COUNT(*) as count FROM service_master");
  if (svcRows[0].count === 0) {
    const defaultServices = [
      "Flat Tire Repair",
      "Battery Jumpstart",
      "Towing Services",
      "Mechanical Issues",
      "Fuel Delivery",
      "Lockout Assistance",
      "EV Portable Charger",
      "Winching Services"
    ];
    for (const svc of defaultServices) {
      await p.execute("INSERT INTO service_master (service_name, service_slug) VALUES (?, ?)", [svc, svc.toLowerCase().replace(/ /g, '_')]);
    }
  }

  // Seed Vehicle Subcategories
  const [subcatRows] = await p.query("SELECT COUNT(*) as count FROM vehicle_subcategory_master");
  if (subcatRows[0].count === 0) {
    const cats = await p.query("SELECT id, category_name FROM vehicle_category_master");
    for (const cat of cats[0]) {
      let subcats = [];
      if (cat.category_name === 'Bike') subcats = ['Scooter', 'Commuter Bike', 'Sports Bike', 'Premium Bike'];
      if (cat.category_name === 'Car') subcats = ['Hatchback', 'Sedan', 'SUV', 'Luxury'];
      if (cat.category_name === 'Commercial') subcats = ['Mini Truck', 'Truck', 'Bus', 'Trailer'];
      if (cat.category_name === 'EV') subcats = ['EV Bike', 'EV Car', 'EV Commercial'];
      
      for (const sc of subcats) {
        await p.execute("INSERT INTO vehicle_subcategory_master (vehicle_category_id, subcategory_name) VALUES (?, ?)", [cat.id, sc]);
      }
    }
  }

  // Seed Towing Fleets
  const [fleetRows] = await p.query("SELECT COUNT(*) as count FROM towing_fleet_master");
  if (fleetRows[0].count === 0) {
    const defaultFleets = ["Flatbed Trucks", "Front Lift Trucks", "Heavy Duty Wreckers"];
    for (const f of defaultFleets) {
      await p.execute("INSERT INTO towing_fleet_master (fleet_name) VALUES (?)", [f]);
    }
  }

  // Seed Pricing Fields (Simplified for default ones)
  const [pfRows] = await p.query("SELECT COUNT(*) as count FROM service_pricing_field_master");
  if (pfRows[0].count === 0) {
     const svcs = await p.query("SELECT id, service_name FROM service_master");
     for (const s of svcs[0]) {
       let fields = [];
       if (s.service_name === 'Flat Tire Repair') fields = [{k: 'visit_charge', l: 'Visit Charge'}, {k: 'free_distance', l: 'Free Distance'}, {k: 'cost_per_km', l: 'Cost Per KM'}, {k: 'tube_tyre_price', l: 'Tube Tyre Price'}, {k: 'tubeless_tyre_price', l: 'Tubeless Tyre Price'}];
       else if (s.service_name === 'Battery Jumpstart') fields = [{k: 'jumpstart_charge', l: 'Jumpstart Charge'}, {k: 'visit_charge', l: 'Visit Charge'}];
       else if (s.service_name === 'Towing Services') fields = [{k: 'base_charge', l: 'Base Charge'}, {k: 'free_distance', l: 'Free Distance'}, {k: 'cost_per_km', l: 'Cost Per KM'}];
       else if (s.service_name === 'Mechanical Issues') fields = [{k: 'service_charge', l: 'Service Charge'}, {k: 'visit_charge', l: 'Visit Charge'}];
       else if (s.service_name === 'Fuel Delivery') fields = [{k: 'delivery_charge', l: 'Delivery Charge'}];
       else if (s.service_name === 'Lockout Assistance') fields = [{k: 'unlock_charge', l: 'Unlock Charge'}, {k: 'visit_charge', l: 'Visit Charge'}];
       else if (s.service_name === 'EV Portable Charger') fields = [{k: 'charging_support_fee', l: 'Charging Support Fee'}, {k: 'visit_charge', l: 'Visit Charge'}];
       else if (s.service_name === 'Winching Services') fields = [{k: 'recovery_fee', l: 'Recovery Fee'}, {k: 'visit_charge', l: 'Visit Charge'}];
       
       for (const f of fields) {
         await p.execute("INSERT INTO service_pricing_field_master (service_id, field_key, field_label, field_type) VALUES (?, ?, ?, 'Number')", [s.id, f.k, f.l]);
       }
     }
  }
}
