export const users = `
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  password_hash VARCHAR(255),
  google_id VARCHAR(255) UNIQUE,
  is_verified BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'approved',
  settings JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();

export const otp_requests = `
CREATE TABLE IF NOT EXISTS otp_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  otp_hash VARCHAR(255) NULL,
  expires_at DATETIME NULL,
  otp_request_count INT NOT NULL DEFAULT 0,
  otp_last_request_time DATETIME NULL,
  otp_window_start_time DATETIME NULL,
  migration_history JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

export const device_tokens = `
CREATE TABLE IF NOT EXISTS device_tokens (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_type ENUM('user', 'technician') NOT NULL,
  token VARCHAR(512) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, user_type)
)
`.trim();
