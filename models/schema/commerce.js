export const payments = `
CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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
  wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  pricing_snapshot JSON,
  verified_at DATETIME NULL,
  captured_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export const technician_dues = `
CREATE TABLE IF NOT EXISTS technician_dues (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  amount DECIMAL(10, 2) NOT NULL,
  reason VARCHAR(255),
  status ENUM('pending', 'paid') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export const technician_wallets = `
CREATE TABLE IF NOT EXISTS technician_wallets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
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

export const wallet_transactions = `
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  wallet_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payout_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
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

export const payouts = `
CREATE TABLE IF NOT EXISTS payouts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  payout_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  withdrawal_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wallet_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  payout_method VARCHAR(40) NULL,
  destination_reference VARCHAR(255) NULL,
  destination_name VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  notes TEXT NULL,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  processed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  processed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (wallet_id) REFERENCES technician_wallets(id)
)
`.trim();

export const withdrawal_requests = `
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  withdrawal_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wallet_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  upi_id VARCHAR(120) NULL,
  beneficiary_name VARCHAR(255) NULL,
  note TEXT NULL,
  rejection_reason VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reviewed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  processed_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
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

export const payout_allocations = `
CREATE TABLE IF NOT EXISTS payout_allocations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  payout_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payout_id) REFERENCES payouts(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES wallet_transactions(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export const payment_refunds = `
CREATE TABLE IF NOT EXISTS payment_refunds (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  refund_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  payment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  wallet_transaction_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount DECIMAL(12, 2) NOT NULL,
  technician_adjustment_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(30) NOT NULL DEFAULT 'processed',
  reason VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  processed_at DATETIME NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export const invoices = `
CREATE TABLE IF NOT EXISTS invoices (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_id VARCHAR(255) NOT NULL,
  razorpay_payment_id VARCHAR(255),
  amount DECIMAL(10,2),
  invoice_pdf LONGBLOB,
  status VARCHAR(50) DEFAULT 'GENERATED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  platform_fee DECIMAL(12,2) DEFAULT 0.00,
  payment_fee DECIMAL(12,2) DEFAULT 0.00,
  technician_amount DECIMAL(12,2) DEFAULT 0.00,
  gst DECIMAL(12,2) DEFAULT 0.00,
  total_amount DECIMAL(12,2) DEFAULT 0.00,
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export const platform_pricing_config = `
CREATE TABLE IF NOT EXISTS platform_pricing_config (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
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
