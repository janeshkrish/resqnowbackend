import { TABLES } from "../schema/index.js";
import { referenceTarget } from "../relationships.js";

export const TABLE_MERGES = Object.freeze({
  technician_admin_notes: "account_notes", admin_customer_notes: "account_notes",
  technician_approval_audit: "admin_actions_log", admin_audit_logs: "admin_actions_log",
  otp_rate_limits: "otp_requests",
});
export const destinationTable = table => TABLE_MERGES[table] || table;

const sourceColumns = {
  account_notes: ["id", "user_id", "technician_id", "admin_id", "note_type", "note_text", "metadata", "created_at"],
  otp_requests: ["id", "email", "otp_hash", "expires_at", "created_at", "updated_at", "otp_request_count", "otp_last_request_time", "otp_window_start_time", "migration_history"],
  otp_rate_limits: ["id", "email", "created_at", "updated_at", "otp_request_count", "otp_last_request_time", "otp_window_start_time"],
  technician_admin_notes: ["id", "technician_id", "admin_id", "note_type", "note_text", "metadata", "created_at"],
  admin_customer_notes: ["id", "user_id", "admin_id", "note", "created_at"],
  technician_approval_audit: ["id", "technician_id", "action", "previous_status", "new_status", "reason", "admin_email", "admin_id", "created_at"],
  admin_audit_logs: ["id", "adminId", "actionType", "targetId", "timestamp", "metadata"],
  admin_actions_log: ["id", "admin_id", "action_type", "source", "target_type", "target_id", "metadata", "created_at", "technician_id", "previous_status", "new_status", "reason"],
};

export function assertConsolidationColumns(plan) {
  for (const [table, allowed] of Object.entries(sourceColumns)) {
    const unknown = (plan.metadata.tables[table] || []).filter(column => !allowed.includes(column.column_name));
    if (unknown.length) throw new Error(`Add a lossless migration mapping for ${unknown.map(column => `${table}.${column.column_name}`).join(", ")} before transfer.`);
  }
}

export function transformRelationalRow(plan, source, original, changes = {}) {
  const row = { ...original, ...changes };
  if (["technician_admin_notes", "admin_customer_notes", "account_notes"].includes(source)) {
    if (Boolean(row.user_id) === Boolean(row.technician_id)) throw new Error(`Note ${row.id} must belong to exactly one user or technician.`);
    return { id: row.id, user_id: row.user_id ?? null, technician_id: row.technician_id ?? null, admin_id: row.admin_id,
      note_type: row.note_type ?? "note", note_text: row.note_text ?? row.note ?? null, metadata: row.metadata ?? null,
      created_at: row.created_at };
  }
  if (source === "technician_approval_audit") {
    return { id: row.id, source: "approval", technician_id: row.technician_id, admin_id: row.admin_id,
      action_type: row.action, previous_status: row.previous_status ?? null, new_status: row.new_status,
      reason: row.reason ?? null, target_type: "technician", target_id: row.technician_id,
      metadata: null, created_at: row.created_at };
  }
  if (source === "admin_audit_logs") {
    const target = referenceTarget(source, "targetId", row);
    const type = { users: "user", technicians: "technician", service_requests: "service_request", admin_complaints: "complaint",
      payments: "payment", payouts: "payout", withdrawal_requests: "withdrawal_request" }[target] || "system";
    return { id: row.id, source: "http", admin_id: row.adminId, action_type: row.actionType,
      target_type: type, target_id: row.targetId ?? null, metadata: row.metadata ?? null, created_at: row.timestamp,
      technician_id: null, previous_status: null, new_status: null, reason: null };
  }
  if (source === "admin_actions_log") {
    return { ...row, source: row.source ?? "action", technician_id: row.technician_id ?? null,
      previous_status: row.previous_status ?? null, new_status: row.new_status ?? null, reason: row.reason ?? null };
  }
  return row;
}

export function stripForeignKeys(sql) {
  return sql.split(/\r?\n/).filter(line => !/^\s*(?:CONSTRAINT\s+.*\b)?FOREIGN KEY\b/i.test(line))
    .join("\n").replace(/,\s*\n\)/g, "\n)");
}

export function consolidatedSchema(table) {
  return ["account_notes", "admin_actions_log", "otp_requests"].includes(table) ? stripForeignKeys(TABLES[table]) : null;
}

export function consolidatedForeignKeys(foreignKeys) {
  const result = [];
  const seen = new Map();
  for (const original of foreignKeys) {
    const renamed = original.table_name === "admin_audit_logs" ? { adminId: "admin_id", targetId: "target_id" } : {};
    const row = { ...original, table_name: destinationTable(original.table_name),
      column_name: renamed[original.column_name] || original.column_name,
      referenced_table_name: destinationTable(original.referenced_table_name) };
    const signature = `${row.table_name}.${row.column_name}:${row.referenced_table_name}.${row.referenced_column_name}`;
    if (seen.has(signature)) {
      const other = seen.get(signature);
      if (other.delete_rule !== row.delete_rule || other.update_rule !== row.update_rule) throw new Error(`Conflicting foreign-key rules for ${signature}`);
      continue;
    }
    seen.set(signature, row);
    result.push(row);
  }
  return result;
}
