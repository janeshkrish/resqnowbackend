export const notifications = `
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();

export const email_templates = `
CREATE TABLE IF NOT EXISTS email_templates (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL UNIQUE,
  subject VARCHAR(255) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
`.trim();

export const files = `
CREATE TABLE IF NOT EXISTS files (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  filename VARCHAR(255) UNIQUE NOT NULL,
  content LONGBLOB NOT NULL,
  mimetype VARCHAR(100),
  size INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
`.trim();
