export const technicians = `
CREATE TABLE IF NOT EXISTS technicians (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
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

export const technician_fleet_vehicles = `
CREATE TABLE IF NOT EXISTS technician_fleet_vehicles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

export const technician_team_members = `
CREATE TABLE IF NOT EXISTS technician_team_members (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'driver',
  assigned_vehicle_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_technician_team_members_lookup (technician_id, status, updated_at),
  INDEX idx_technician_team_members_vehicle (assigned_vehicle_id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export const technician_login_sessions = `
CREATE TABLE IF NOT EXISTS technician_login_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

export const technician_activity_alerts = `
CREATE TABLE IF NOT EXISTS technician_activity_alerts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
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

