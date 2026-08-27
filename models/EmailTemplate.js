import { getPool } from "../db.js";
import { EMAIL_TEMPLATE_DEFAULTS } from "../utils/emailTemplateDefaults.js";

function mapTemplateRow(row) {
  if (!row) return null;

  return {
    eventType: row.event_type,
    subject: row.subject,
    content: row.content,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function find(filter = {}) {
  const pool = await getPool();
  const eventType = String(filter?.eventType || "").trim().toUpperCase();

  if (eventType) {
    const [rows] = await pool.query(
      `SELECT event_type, subject, content, created_at, updated_at
       FROM email_templates
       WHERE event_type = ?
       ORDER BY event_type ASC`,
      [eventType]
    );
    return rows.map(mapTemplateRow);
  }

  const [rows] = await pool.query(
    `SELECT event_type, subject, content, created_at, updated_at
     FROM email_templates
     ORDER BY event_type ASC`
  );
  return rows.map(mapTemplateRow);
}

async function findOne(filter = {}) {
  const eventType = String(filter?.eventType || "").trim().toUpperCase();
  if (!eventType) return null;

  const pool = await getPool();
  const [rows] = await pool.query(
    `SELECT event_type, subject, content, created_at, updated_at
     FROM email_templates
     WHERE event_type = ?
     LIMIT 1`,
    [eventType]
  );

  return mapTemplateRow(rows[0]);
}

async function findOneAndUpdate(filter = {}, update = {}, options = {}) {
  const eventType = String(filter?.eventType || "").trim().toUpperCase();
  if (!eventType) {
    throw new Error("eventType is required.");
  }

  const existing = await findOne({ eventType });
  if (!existing && !options?.upsert) {
    return null;
  }

  const subject = String(update?.subject || "").trim();
  const content = String(update?.content || "").trim();
  const pool = await getPool();

  await pool.execute(
    `INSERT INTO email_templates (event_type, subject, content)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       subject = VALUES(subject),
       content = VALUES(content),
       updated_at = CURRENT_TIMESTAMP`,
    [eventType, subject, content]
  );

  if (options?.new === false) {
    return existing;
  }

  return findOne({ eventType });
}

const EmailTemplate = {
  defaults: EMAIL_TEMPLATE_DEFAULTS,
  find,
  findOne,
  findOneAndUpdate,
};

export default EmailTemplate;
