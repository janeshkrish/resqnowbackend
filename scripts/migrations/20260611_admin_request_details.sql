-- Admin request details, audit timeline, and attachment relations.
-- Additive only: existing service request and technician data is preserved.

CREATE TABLE IF NOT EXISTS request_timeline (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  status VARCHAR(50) NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  actor_type VARCHAR(40) NULL,
  actor_id VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_timeline_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS request_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id INT NOT NULL,
  file_name VARCHAR(255) NULL,
  file_url VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(120) NULL,
  attachment_type VARCHAR(40) NOT NULL DEFAULT 'document',
  uploaded_by_type VARCHAR(40) NULL,
  uploaded_by_id VARCHAR(255) NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_request_attachments_request_time (request_id, created_at),
  FOREIGN KEY (request_id) REFERENCES service_requests(id) ON DELETE CASCADE
);
