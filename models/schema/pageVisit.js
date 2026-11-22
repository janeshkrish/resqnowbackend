const uuid = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';

export const page_visit = `CREATE TABLE IF NOT EXISTS page_visit (
  id ${uuid} NOT NULL PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL,
  page_visited VARCHAR(255) NOT NULL,
  previous_page VARCHAR(255) NOT NULL,
  time_spent_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  device VARCHAR(100) NOT NULL DEFAULT 'Unknown',
  browser VARCHAR(100) NOT NULL DEFAULT 'Unknown',
  location VARCHAR(150) NOT NULL DEFAULT 'Local/Unknown',
  session_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(120) NULL,
  user_email VARCHAR(150) NULL,
  user_phone VARCHAR(40) NULL,
  user_role VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_page_visit_created_at (created_at),
  INDEX idx_page_visit_ip (ip_address),
  INDEX idx_page_visit_session (session_id),
  INDEX idx_page_visit_user_email (user_email)
)`;
