-- Command Center + request lifecycle hardening migration
-- Date: 2026-03-09

-- Prevent status truncation issues on close/status updates
ALTER TABLE service_requests MODIFY COLUMN status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE service_requests MODIFY COLUMN payment_status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE service_requests MODIFY COLUMN cancellation_reason VARCHAR(1024);

-- Close reason persistence
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS closing_reason VARCHAR(512);

-- Monitoring model fields
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS accepted_time DATETIME NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS start_time DATETIME NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS scheduled_time DATETIME NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS sla_deadline DATETIME NULL;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS customer_location_lat DECIMAL(10, 8);
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS customer_location_lng DECIMAL(11, 8);
CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status);
CREATE INDEX IF NOT EXISTS idx_service_requests_technician_status ON service_requests(technician_id, status);
CREATE INDEX IF NOT EXISTS idx_service_requests_created_at ON service_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_service_requests_updated_at ON service_requests(updated_at);

ALTER TABLE technicians ADD COLUMN IF NOT EXISTS current_lat DECIMAL(10, 8);
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS current_lng DECIMAL(11, 8);
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS last_location_update DATETIME NULL;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS acceptance_rate DECIMAL(5,2) DEFAULT 0.00;
ALTER TABLE technicians ADD COLUMN IF NOT EXISTS skill_set JSON;

ALTER TABLE payments MODIFY COLUMN status VARCHAR(50) DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS technician_location_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  service_request_id INT NULL,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tech_location_history_tech_time (technician_id, captured_at),
  INDEX idx_tech_location_history_request_time (service_request_id, captured_at)
);

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
);
