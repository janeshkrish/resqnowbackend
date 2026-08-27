-- Marketplace wallet + payout migration
-- Supports platform-collected Razorpay payments, technician wallet credits,
-- manual payouts, and payout queue export.

ALTER TABLE platform_pricing_config
  ADD COLUMN IF NOT EXISTS payment_fee_percent DECIMAL(8,6) NOT NULL DEFAULT 0.020000;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS base_amount DECIMAL(10,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS payment_fee DECIMAL(10,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS refunded_amount DECIMAL(10,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ledger_status VARCHAR(20) DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS wallet_transaction_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSON NULL,
  ADD COLUMN IF NOT EXISTS verified_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS captured_at DATETIME NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_fee DECIMAL(12,2) DEFAULT 0.00;

CREATE TABLE IF NOT EXISTS technician_wallets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL UNIQUE,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  total_earned DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  withdrawable_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_paid_out DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  on_hold_balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  last_transaction_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_id BIGINT NOT NULL,
  technician_id INT NOT NULL,
  service_request_id INT NULL,
  payment_id INT NULL,
  payout_id BIGINT NULL,
  entry_type VARCHAR(40) NOT NULL,
  direction ENUM('credit', 'debit') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  allocated_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance_before DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00,
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
);

CREATE UNIQUE INDEX uniq_wallet_transactions_idempotency_key
  ON wallet_transactions (idempotency_key);

CREATE TABLE IF NOT EXISTS payouts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payout_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  technician_id INT NOT NULL,
  wallet_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  payout_method VARCHAR(40) NULL,
  destination_reference VARCHAR(255) NULL,
  external_reference VARCHAR(255) NULL,
  notes TEXT NULL,
  created_by VARCHAR(255) NULL,
  processed_by VARCHAR(255) NULL,
  processed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (wallet_id) REFERENCES technician_wallets(id)
);

CREATE TABLE IF NOT EXISTS payout_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payout_id BIGINT NOT NULL,
  wallet_transaction_id BIGINT NOT NULL,
  payment_id INT NULL,
  service_request_id INT NULL,
  amount DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payout_id) REFERENCES payouts(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES wallet_transactions(id),
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
);

CREATE INDEX idx_wallet_transactions_technician_time
  ON wallet_transactions (technician_id, created_at);
CREATE INDEX idx_wallet_transactions_payment
  ON wallet_transactions (payment_id);
CREATE INDEX idx_payouts_technician_status
  ON payouts (technician_id, status);
CREATE UNIQUE INDEX uniq_payouts_idempotency_key
  ON payouts (idempotency_key);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  refund_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  payment_id INT NOT NULL,
  service_request_id INT NOT NULL,
  technician_id INT NULL,
  wallet_transaction_id BIGINT NULL,
  amount DECIMAL(12,2) NOT NULL,
  technician_adjustment_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
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
);

CREATE INDEX idx_payment_refunds_payment
  ON payment_refunds (payment_id);
CREATE UNIQUE INDEX uniq_payment_refunds_idempotency_key
  ON payment_refunds (idempotency_key);
