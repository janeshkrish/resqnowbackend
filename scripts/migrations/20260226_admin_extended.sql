-- Admin Extended migration
-- Features covered: 2, 3, 11, 12

CREATE TABLE IF NOT EXISTS admin_actions_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id VARCHAR(255) NOT NULL,
  action_type VARCHAR(120) NOT NULL,
  target_type VARCHAR(120) NOT NULL DEFAULT 'service_request',
  target_id VARCHAR(120) NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS technician_admin_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  admin_id VARCHAR(255) NOT NULL,
  note_type VARCHAR(64) NOT NULL DEFAULT 'note',
  note_text TEXT,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES technicians(id)
);

CREATE TABLE IF NOT EXISTS admin_complaints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
  status ENUM('open', 'assigned', 'resolved') DEFAULT 'open',
  assigned_admin_id VARCHAR(255),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_complaint_updates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  complaint_id INT NOT NULL,
  update_type VARCHAR(64) NOT NULL,
  note_text TEXT,
  metadata JSON,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (complaint_id) REFERENCES admin_complaints(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  adminId VARCHAR(255) NOT NULL,
  actionType VARCHAR(255) NOT NULL,
  targetId VARCHAR(255),
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_actions_log'
    AND index_name = 'idx_admin_actions_created_at'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_actions_created_at ON admin_actions_log (created_at)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_actions_log'
    AND index_name = 'idx_admin_actions_type_target'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_actions_type_target ON admin_actions_log (action_type, target_id)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'technician_admin_notes'
    AND index_name = 'idx_technician_notes_tech_created'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_technician_notes_tech_created ON technician_admin_notes (technician_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_complaints'
    AND index_name = 'idx_admin_complaints_status'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_complaints_status ON admin_complaints (status)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_complaints'
    AND index_name = 'idx_admin_complaints_assigned'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_complaints_assigned ON admin_complaints (assigned_admin_id)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_complaint_updates'
    AND index_name = 'idx_admin_complaint_updates_complaint'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_complaint_updates_complaint ON admin_complaint_updates (complaint_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_audit_logs'
    AND index_name = 'idx_admin_audit_admin_timestamp'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_audit_admin_timestamp ON admin_audit_logs (adminId, timestamp)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'admin_audit_logs'
    AND index_name = 'idx_admin_audit_action_timestamp'
);
SET @sql := IF(@idx_exists = 0, 'CREATE INDEX idx_admin_audit_action_timestamp ON admin_audit_logs (actionType, timestamp)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
