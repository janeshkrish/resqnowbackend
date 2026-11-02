export const password_recovery_tokens = `
CREATE TABLE IF NOT EXISTS password_recovery_tokens (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_role ENUM('user','technician') NOT NULL,
  purpose ENUM('password_reset','verify_email') NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  auth_version INT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_recovery_actor (account_id, account_role, purpose),
  INDEX idx_recovery_expiry (expires_at)
)
`.trim();

export const recovery_rate_limits = `
CREATE TABLE IF NOT EXISTS recovery_rate_limits (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  bucket_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME(3) NOT NULL,
  last_request_at DATETIME(3) NULL,
  INDEX idx_recovery_limit_window (window_started_at)
)
`.trim();
