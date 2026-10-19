export const service_requests = `
CREATE TABLE IF NOT EXISTS service_requests (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
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
  pricing_snapshot JSON,
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

export const request_timeline = `
CREATE TABLE IF NOT EXISTS request_timeline (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  status VARCHAR(50) NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  actor_type VARCHAR(40) NULL,
  actor_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_timeline_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
)
`.trim();

export const request_attachments = `
CREATE TABLE IF NOT EXISTS request_attachments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(120) NULL,
  attachment_type VARCHAR(40) NOT NULL DEFAULT 'document',
  uploaded_by_type VARCHAR(40) NULL,
  uploaded_by_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_attachments_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
)
`.trim();

export const dispatch_offers = `
CREATE TABLE IF NOT EXISTS dispatch_offers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending', 'accepted', 'rejected', 'expired') DEFAULT 'pending',
  pricing_snapshot JSON,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
)
`.trim();

export const technician_location_history = `
CREATE TABLE IF NOT EXISTS technician_location_history (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  recorded_at DATETIME(3) NULL,
  received_at DATETIME(3) NULL,
  sequence_id BIGINT NULL,
  accuracy_m DECIMAL(8, 2) NULL,
  speed_mps DECIMAL(8, 3) NULL,
  heading_degrees DECIMAL(7, 3) NULL,
  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tech_location_history_tech_time (technician_id, captured_at),
  INDEX idx_tech_location_history_request_time (service_request_id, captured_at),
  INDEX idx_tech_location_history_request_recorded (service_request_id, recorded_at)
)
`.trim();

export const job_monitoring_alerts = `
CREATE TABLE IF NOT EXISTS job_monitoring_alerts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
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

export const reviews = `
CREATE TABLE IF NOT EXISTS reviews (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  rating DECIMAL(2, 1) NOT NULL,
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (service_request_id) REFERENCES service_requests(id)
)
`.trim();

export const user_vehicles = `
CREATE TABLE IF NOT EXISTS user_vehicles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type VARCHAR(50) NOT NULL,
  make VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  license_plate VARCHAR(50),
  status VARCHAR(32) DEFAULT 'ready',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
)
`.trim();
