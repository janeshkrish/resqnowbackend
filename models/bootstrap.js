import { getPool } from "../db.js";
import { EMAIL_TEMPLATE_DEFAULTS } from "../utils/emailTemplateDefaults.js";
import { TABLES } from "./schema/index.js";

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



export async function ensureTechniciansTable() {
  const p = await getPool();
  await p.execute(TABLES.technicians);
}



export async function ensureUsersTable() {
  const p = await getPool();
  await p.execute(TABLES.users);
}



export async function ensureOtpRequestsTable() {
  const p = await getPool();
  await p.execute(TABLES.otp_requests);
}



export const ensureOtpRateLimitsTable = ensureOtpRequestsTable;



export async function ensureServiceRequestsTable() {
  const p = await getPool();
  await p.execute(TABLES.service_requests);
  await ensureDispatchPricingSnapshotColumn(p, "service_requests");
}



export async function ensureRequestTimelineTable() {
  const p = await getPool();
  await p.execute(TABLES.request_timeline);
  await addIndexIfNotExists(
    p,
    "request_timeline",
    "idx_request_timeline_request_time",
    "request_id, created_at"
  );
}



export async function ensureRequestAttachmentsTable() {
  const p = await getPool();
  await p.execute(TABLES.request_attachments);
  await addIndexIfNotExists(
    p,
    "request_attachments",
    "idx_request_attachments_request_time",
    "request_id, created_at"
  );
}



export async function ensureTechnicianServicesTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_services);
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



export async function ensureDispatchOffersTable() {
  const p = await getPool();
  await p.execute(TABLES.dispatch_offers);
  await ensureDispatchPricingSnapshotColumn(p, "dispatch_offers");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_request_status", "service_request_id, status");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_request_tech", "service_request_id, technician_id");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_tech_status", "technician_id, status");
  await addIndexIfNotExists(p, "dispatch_offers", "idx_dispatch_offers_latest", "service_request_id, technician_id, sent_at, id");
}



export async function ensureTechnicianLocationHistoryTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_location_history);
  await addColumnIfNotExists(p, 'technician_location_history', 'recorded_at DATETIME(3) NULL');
  await addColumnIfNotExists(p, 'technician_location_history', 'received_at DATETIME(3) NULL');
  await addColumnIfNotExists(p, 'technician_location_history', 'sequence_id BIGINT NULL');
  await addColumnIfNotExists(p, 'technician_location_history', 'accuracy_m DECIMAL(8, 2) NULL');
  await addColumnIfNotExists(p, 'technician_location_history', 'speed_mps DECIMAL(8, 3) NULL');
  await addColumnIfNotExists(p, 'technician_location_history', 'heading_degrees DECIMAL(7, 3) NULL');
  await addIndexIfNotExists(
    p,
    'technician_location_history',
    'idx_tech_location_history_request_recorded',
    'service_request_id, recorded_at',
  );
}



export async function ensureTechnicianLoginSessionsTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_login_sessions);
}



export async function ensureTechnicianActivityAlertsTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_activity_alerts);
}



export async function ensureJobMonitoringAlertsTable() {
  const p = await getPool();
  await p.execute(TABLES.job_monitoring_alerts);
}



export async function ensureNotificationsTable() {
  const p = await getPool();
  await p.execute(TABLES.notifications);
}



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
  await p.execute(TABLES.email_templates);
  await addColumnIfNotExists(p, "email_templates", "subject VARCHAR(255) NOT NULL DEFAULT ''");
  await addColumnIfNotExists(p, "email_templates", "content MEDIUMTEXT NOT NULL");
  await addIndexIfNotExists(p, "email_templates", "idx_email_templates_event_type", "event_type");
  await seedDefaultEmailTemplates(p);
}



export async function ensureReviewsTable() {
  const p = await getPool();
  await p.execute(TABLES.reviews);
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

async function ensureDispatchPricingSnapshotColumn(poolLike, tableName) {
  await addColumnIfNotExists(poolLike, tableName, "pricing_snapshot JSON DEFAULT NULL");
  // These columns are required by dispatch/acceptance queries. Do not let an ALTER
  // permission failure silently start a backend that cannot save agreed prices.
  if (!(await columnExists(poolLike, tableName, "pricing_snapshot"))) {
    throw new Error(`Missing ${tableName}.pricing_snapshot. Apply the dispatch pricing migration before deployment.`);
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
  await addColumnIfNotExists(p, 'technicians', 'current_job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
  // Hidden by an admin: kept, but offered no new jobs and left off the customers' nearby map.
  await addColumnIfNotExists(p, 'technicians', 'admin_hidden BOOLEAN DEFAULT FALSE');
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



export async function ensureFilesTable() {
  const p = await getPool();
  await p.execute(TABLES.files);
}



export async function ensureUserVehiclesTable() {
  const p = await getPool();
  await p.execute(TABLES.user_vehicles);
  await addColumnIfNotExists(p, 'user_vehicles', "status VARCHAR(32) DEFAULT 'ready'");
}



export async function ensureTechnicianFleetVehiclesTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_fleet_vehicles);
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



export async function ensureTechnicianTeamMembersTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_team_members);
  await addColumnIfNotExists(p, "technician_team_members", "assigned_vehicle_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL");
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



export async function ensureDeviceTokensTable() {
  const p = await getPool();
  await p.execute(TABLES.device_tokens);
}



export async function ensurePaymentsTable() {
  const p = await getPool();
  await p.execute(TABLES.payments);
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
  await addColumnIfNotExists(p, 'payments', 'wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
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
  await addColumnIfNotExists(p, "payments", "wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL");
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
  await addIndexIfNotExists(p, "payments", "idx_payments_request_created", "service_request_id, created_at, id");
  await addIndexIfNotExists(p, "payments", "idx_payments_technician_payout_status", "payment_to_technician_status");
  await addIndexIfNotExists(p, "payments", "idx_payments_wallet_transaction", "wallet_transaction_id");
  await addUniqueIndexIfNotExists(p, "payments", "uniq_payments_razorpay_order_id", "razorpay_order_id");
  await addUniqueIndexIfNotExists(p, "payments", "uniq_payments_razorpay_payment_id", "razorpay_payment_id");
}



export async function ensureTechnicianDuesTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_dues);
  await addColumnIfNotExists(p, 'technician_dues', 'service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
}



export async function ensureTechnicianWalletsTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_wallets);
  await addColumnIfNotExists(p, 'technician_wallets', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'technician_wallets', 'total_earned DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'withdrawable_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'total_paid_out DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'on_hold_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'technician_wallets', 'last_transaction_at DATETIME NULL');
}



export async function ensureWalletTransactionsTable() {
  const p = await getPool();
  await p.execute(TABLES.wallet_transactions);
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



export async function ensurePayoutsTable() {
  const p = await getPool();
  await p.execute(TABLES.payouts);
  await addColumnIfNotExists(p, 'payouts', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'payouts', 'withdrawal_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'payouts', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'payouts', 'status VARCHAR(20) NOT NULL DEFAULT "draft"');
  await addColumnIfNotExists(p, 'payouts', 'payout_method VARCHAR(40) NULL');
  await addColumnIfNotExists(p, 'payouts', 'destination_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'destination_name VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payouts', 'notes TEXT NULL');
  await addColumnIfNotExists(p, 'payouts', 'created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'payouts', 'processed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'payouts', 'processed_at DATETIME NULL');
  await addIndexIfNotExists(p, 'payouts', 'idx_payouts_technician_status', 'technician_id, status');
  await addIndexIfNotExists(p, 'payouts', 'idx_payouts_processed_at', 'processed_at');
  await addUniqueIndexIfNotExists(p, 'payouts', 'uniq_payouts_withdrawal_request', 'withdrawal_request_id');
  await addUniqueIndexIfNotExists(p, 'payouts', 'uniq_payouts_idempotency_key', 'idempotency_key');
}



export async function ensureWithdrawalRequestsTable() {
  const p = await getPool();
  await p.execute(TABLES.withdrawal_requests);
  await addColumnIfNotExists(p, 'withdrawal_requests', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'currency VARCHAR(10) NOT NULL DEFAULT "INR"');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'status VARCHAR(20) NOT NULL DEFAULT "pending"');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'upi_id VARCHAR(120) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'beneficiary_name VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'note TEXT NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'rejection_reason VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'reviewed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'processed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'processing_started_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'paid_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'rejected_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'cancelled_at DATETIME NULL');
  await addColumnIfNotExists(p, 'withdrawal_requests', 'metadata JSON NULL');
  await addIndexIfNotExists(p, 'withdrawal_requests', 'idx_withdrawal_requests_technician_status', 'technician_id, status');
  await addIndexIfNotExists(p, 'withdrawal_requests', 'idx_withdrawal_requests_status_created', 'status, created_at');
  await addUniqueIndexIfNotExists(p, 'withdrawal_requests', 'uniq_withdrawal_requests_idempotency_key', 'idempotency_key');
}



export async function ensurePayoutAllocationsTable() {
  const p = await getPool();
  await p.execute(TABLES.payout_allocations);
  await addIndexIfNotExists(p, 'payout_allocations', 'idx_payout_allocations_payout', 'payout_id');
  await addIndexIfNotExists(p, 'payout_allocations', 'idx_payout_allocations_wallet_txn', 'wallet_transaction_id');
}



export async function ensurePaymentRefundsTable() {
  const p = await getPool();
  await p.execute(TABLES.payment_refunds);
  await addColumnIfNotExists(p, 'payment_refunds', 'idempotency_key VARCHAR(128) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'technician_adjustment_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payment_refunds', 'status VARCHAR(30) NOT NULL DEFAULT "processed"');
  await addColumnIfNotExists(p, 'payment_refunds', 'reason VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'external_reference VARCHAR(255) NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'processed_at DATETIME NULL');
  await addColumnIfNotExists(p, 'payment_refunds', 'metadata JSON NULL');
  await addIndexIfNotExists(p, 'payment_refunds', 'idx_payment_refunds_payment', 'payment_id');
  await addIndexIfNotExists(p, 'payment_refunds', 'idx_payment_refunds_technician', 'technician_id, created_at');
  await addUniqueIndexIfNotExists(p, 'payment_refunds', 'uniq_payment_refunds_idempotency_key', 'idempotency_key');
}

// Invoices table keeps generated invoice PDF in TiDB (LONGBLOB) for Render-safe storage.


export async function ensureInvoicesTable() {
  const p = await getPool();
  await p.execute(TABLES.invoices);
  await addIndexIfNotExists(p, "invoices", "idx_invoices_request_created", "service_request_id, created_at, id");
  await addColumnIfNotExists(p, 'invoices', 'user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'invoices', 'order_id VARCHAR(255) NOT NULL DEFAULT ""');
  await addColumnIfNotExists(p, 'invoices', 'razorpay_payment_id VARCHAR(255)');
  await addColumnIfNotExists(p, 'invoices', 'amount DECIMAL(10,2)');
  await addColumnIfNotExists(p, 'invoices', 'invoice_pdf LONGBLOB');
  await addColumnIfNotExists(p, 'invoices', 'status VARCHAR(50) DEFAULT "GENERATED"');
  await addColumnIfNotExists(p, 'invoices', 'service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
  await addColumnIfNotExists(p, 'invoices', 'technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
  await addColumnIfNotExists(p, 'invoices', 'platform_fee DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'payment_fee DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'technician_amount DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'gst DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'total_amount DECIMAL(12,2) DEFAULT 0.00');
}



export async function ensurePlatformPricingConfigTable() {
  const p = await getPool();
  await p.execute(TABLES.platform_pricing_config);
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



export async function ensureTechnicianApprovalAuditTable() {
  const p = await getPool();
  await p.execute(TABLES.admin_actions_log);
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
  await addColumnIfNotExists(p, 'service_requests', 'pricing_overridden_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin');
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
  await addColumnIfNotExists(p, 'service_requests', 'assigned_vehicle_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'service_requests', 'assigned_employee_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
  await addColumnIfNotExists(p, 'service_requests', 'vehicle_brand VARCHAR(100) NULL');
  await addColumnIfNotExists(p, 'service_requests', 'vehicle_subtype VARCHAR(50) NULL');
  await addColumnIfNotExists(p, 'service_requests', 'tow_truck_type VARCHAR(40) NULL');
  await addColumnIfNotExists(p, 'service_requests', 'request_details_json JSON NULL');

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
  await addIndexIfNotExists(p, "service_requests", "idx_service_requests_user_created", "user_id, created_at, id");
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

  // Mobile number login: the number Firebase verified, and the Firebase account it belongs to.
  // A customer who signs up with only a number has no email, so email may be empty.
  await addColumnIfNotExists(p, 'users', 'phone_e164 VARCHAR(20)');
  await addColumnIfNotExists(p, 'users', 'firebase_uid VARCHAR(128)');
  await addUniqueIndexIfNotExists(p, 'users', 'uniq_users_phone_e164', 'phone_e164');
  await addUniqueIndexIfNotExists(p, 'users', 'uniq_users_firebase_uid', 'firebase_uid');
  try {
    await allowNullColumn(p, 'users', 'email');
  } catch (err) {
    console.log("Note: could not make users.email optional:", err.message);
  }
}

async function allowNullColumn(poolLike, tableName, columnName) {
  const metadata = await getColumnMetadata(poolLike, tableName, columnName);
  if (!metadata) return;
  const nullable = String(metadata.is_nullable ?? metadata.IS_NULLABLE ?? "").toUpperCase();
  const columnType = String(metadata.column_type ?? metadata.COLUMN_TYPE ?? "").trim();
  if (nullable !== "NO" || !/^[a-z]+(\(\d+\))?$/i.test(columnType)) return;

  await runDdlWithRetry(
    poolLike,
    `modify ${tableName}.${columnName}`,
    () =>
      poolLike.query(
        `ALTER TABLE ${normalizeIdentifier(tableName)} MODIFY COLUMN ${normalizeIdentifier(columnName)} ${columnType} NULL`
      )
  );
}

// --- Dynamic Service Configuration Tables ---



export async function ensureServiceMasterTable() {
  const p = await getPool();
  await p.execute(TABLES.service_master);
}



export async function ensureVehicleCategoryMasterTable() {
  const p = await getPool();
  await p.execute(TABLES.vehicle_category_master);
}



export async function ensureVehicleSubcategoryMasterTable() {
  const p = await getPool();
  await p.execute(TABLES.vehicle_subcategory_master);
}



export async function ensureServiceVehicleMappingTable() {
  const p = await getPool();
  await p.execute(TABLES.service_vehicle_mapping);
}



export async function ensureServicePricingFieldMasterTable() {
  const p = await getPool();
  await p.execute(TABLES.service_pricing_field_master);
}



export async function ensureTowingFleetMasterTable() {
  const p = await getPool();
  await p.execute(TABLES.towing_fleet_master);
}



export async function ensureTechnicianServicePricingTable() {
  const p = await getPool();
  await p.execute(TABLES.technician_service_pricing);
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
