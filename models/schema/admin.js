export const admin_actions_log = `
CREATE TABLE IF NOT EXISTS admin_actions_log (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      action_type VARCHAR(255) NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'action',
      technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      previous_status VARCHAR(50) NULL,
      new_status VARCHAR(50) NULL,
      reason TEXT NULL,
      target_type VARCHAR(120) NOT NULL DEFAULT 'service_request',
      target_id VARCHAR(120) NULL,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
`.trim();

export const admin_complaints = `
CREATE TABLE IF NOT EXISTS admin_complaints (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      severity ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      status ENUM('open', 'assigned', 'resolved') DEFAULT 'open',
      assigned_admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
      created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
`.trim();

export const admin_complaint_updates = `
CREATE TABLE IF NOT EXISTS admin_complaint_updates (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      complaint_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      update_type VARCHAR(64) NOT NULL,
      note_text TEXT,
      metadata JSON,
      created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (complaint_id) REFERENCES admin_complaints(id) ON DELETE CASCADE
    )
`.trim();


export const account_notes = `
CREATE TABLE IF NOT EXISTS account_notes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  technician_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  note_type VARCHAR(64) NOT NULL DEFAULT 'note',
  note_text TEXT NULL,
  metadata JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_account_notes_user_time (user_id, created_at, id),
  INDEX idx_account_notes_technician_time (technician_id, created_at, id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (technician_id) REFERENCES technicians(id),
  FOREIGN KEY (admin_id) REFERENCES users(id)
)
`.trim();
