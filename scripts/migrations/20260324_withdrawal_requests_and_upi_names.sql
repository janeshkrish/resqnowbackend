-- Marketplace withdrawal requests + UPI beneficiary snapshot migration
-- Adds withdrawal request reservation flow without changing existing wallet ledger semantics.

ALTER TABLE technicians
  ADD COLUMN IF NOT EXISTS upi_name VARCHAR(255) NULL;

UPDATE technicians
SET upi_name = COALESCE(
  NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(payment_details, '$.upi_name'))), ''),
  NULLIF(TRIM(proprietor_name), ''),
  NULLIF(TRIM(name), '')
)
WHERE upi_name IS NULL
   OR TRIM(upi_name) = '';

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS withdrawal_request_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS destination_name VARCHAR(255) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payouts_withdrawal_request
  ON payouts (withdrawal_request_id);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  withdrawal_reference VARCHAR(64) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NULL,
  technician_id INT NOT NULL,
  wallet_id BIGINT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_technician_status
  ON withdrawal_requests (technician_id, status);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status_created
  ON withdrawal_requests (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_withdrawal_requests_idempotency_key
  ON withdrawal_requests (idempotency_key);
