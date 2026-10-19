import { referenceTarget } from "./relationships.js";

export async function recordApprovalAudit(pool, { technicianId, action, previousStatus, reason, adminId }) {
  await pool.execute(
    `INSERT INTO admin_actions_log
       (source, technician_id, action_type, previous_status, new_status, reason, admin_id, target_type, target_id)
     VALUES ('approval', ?, ?, ?, ?, ?, ?, 'technician', ?)`,
    [technicianId, action, previousStatus, action, reason || null, adminId, technicianId]
  );
}

export async function listApprovalAudit(pool, technicianId) {
  const [rows] = await pool.query(
    `SELECT id, technician_id, action_type AS action, previous_status, new_status, reason, admin_id, created_at
     FROM admin_actions_log WHERE source = 'approval' AND technician_id = ? ORDER BY created_at DESC, id DESC`,
    [technicianId]
  );
  return rows;
}

export async function recordHttpAudit(pool, { adminId, actionType, targetId, metadata, timestamp = new Date() }) {
  const table = referenceTarget("admin_audit_logs", "targetId", { actionType, targetId, metadata });
  const types = { users: "user", technicians: "technician", service_requests: "service_request", admin_complaints: "complaint",
    payments: "payment", payouts: "payout", withdrawal_requests: "withdrawal_request" };
  await pool.execute(
    `INSERT INTO admin_actions_log (source, admin_id, action_type, target_type, target_id, created_at, metadata)
     VALUES ('http', ?, ?, ?, ?, ?, ?)`,
    [adminId, actionType, types[table] || "system", targetId || null, timestamp, JSON.stringify(metadata)]
  );
}
