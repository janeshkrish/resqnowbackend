import mysql from "mysql2/promise";

let pool = null;

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
  amount DECIMAL(10, 2) DEFAULT 0.00,
  applied_coupon_code VARCHAR(64),
  applied_discount_percent DECIMAL(8,6) DEFAULT 0.000000,
  applied_discount_amount DECIMAL(10,2) DEFAULT 0.00,
  payment_status VARCHAR(50) DEFAULT 'pending',
  status ENUM('pending','assigned','accepted','en-route','in-progress','completed','cancelled') DEFAULT 'pending',
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
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // Ignore duplicate column error (code 1060: Duplicate column name)
    // Also ignore if it says something like "Duplicate field name"
    if (err.code !== 'ER_DUP_FIELDNAME' && err.errno !== 1060 && !err.message?.includes("Duplicate column")) {
      console.log(`Note: Could not add column ${columnDef} to ${table}, might already exist. Error: ${err.message}`);
    }
  }
}

export async function updateTechniciansTableSchema() {
  const p = await getPool();
  await addColumnIfNotExists(p, 'technicians', 'is_active BOOLEAN DEFAULT FALSE');
  await addColumnIfNotExists(p, 'technicians', 'is_available BOOLEAN DEFAULT FALSE');
  await addColumnIfNotExists(p, 'technicians', 'latitude DECIMAL(10, 8)');
  await addColumnIfNotExists(p, 'technicians', 'longitude DECIMAL(11, 8)');
  await addColumnIfNotExists(p, 'technicians', 'current_job_id INT');
  // New columns for comprehensive technician data model
  await addColumnIfNotExists(p, 'technicians', 'resume_url VARCHAR(1024)');
  await addColumnIfNotExists(p, 'technicians', 'documents JSON');
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
  amount DECIMAL(10, 2),
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255),
  razorpay_signature VARCHAR(255),
  platform_fee DECIMAL(10, 2) DEFAULT 0.00,
  technician_amount DECIMAL(10, 2) DEFAULT 0.00,
  is_settled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export async function ensurePaymentsTable() {
  const p = await getPool();
  await p.execute(PAYMENTS_TABLE_SQL);
  // Ensure columns exist if table already existed without them
  await addColumnIfNotExists(p, 'payments', 'platform_fee DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'technician_amount DECIMAL(10, 2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'payments', 'is_settled BOOLEAN DEFAULT TRUE');
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
  await addColumnIfNotExists(p, 'invoices', 'technician_amount DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'gst DECIMAL(12,2) DEFAULT 0.00');
  await addColumnIfNotExists(p, 'invoices', 'total_amount DECIMAL(12,2) DEFAULT 0.00');
}

const PLATFORM_PRICING_CONFIG_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS platform_pricing_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  platform_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000,
  welcome_coupon_code VARCHAR(64) NOT NULL DEFAULT 'RESQ10',
  welcome_coupon_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000,
  welcome_coupon_max_uses_per_user INT NOT NULL DEFAULT 2,
  welcome_coupon_active BOOLEAN DEFAULT TRUE,
  registration_fee DECIMAL(12,2) NOT NULL DEFAULT 500.00,
  booking_fee DECIMAL(12,2) NOT NULL DEFAULT 199.00,
  pay_now_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.000000,
  default_service_amount DECIMAL(12,2) NOT NULL DEFAULT 500.00,
  service_base_prices JSON,
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
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_code VARCHAR(64) NOT NULL DEFAULT "RESQ10"');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.100000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_max_uses_per_user INT NOT NULL DEFAULT 2');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'welcome_coupon_active BOOLEAN DEFAULT TRUE');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'registration_fee DECIMAL(12,2) NOT NULL DEFAULT 500.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'booking_fee DECIMAL(12,2) NOT NULL DEFAULT 199.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'pay_now_discount_percent DECIMAL(8,6) NOT NULL DEFAULT 0.000000');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'default_service_amount DECIMAL(12,2) NOT NULL DEFAULT 500.00');
  await addColumnIfNotExists(p, 'platform_pricing_config', 'service_base_prices JSON');
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
  await addColumnIfNotExists(p, 'service_requests', 'started_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'completed_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'cancelled_at TIMESTAMP NULL');
  await addColumnIfNotExists(p, 'service_requests', 'cancellation_reason VARCHAR(512)');

  // Ensure status column can hold longer status strings like 'payment_pending'
  try {
    // Changing to VARCHAR(50) to be flexible and avoid "Data too long" for longer status strings
    await p.query("ALTER TABLE service_requests MODIFY COLUMN status VARCHAR(50) DEFAULT 'pending'");
  } catch (err) {
    // Ignore if modify fails on some DB versions, but log for visibility
    console.log("Note: could not modify service_requests.status column:", err.message);
  }
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
