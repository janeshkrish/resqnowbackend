import { getPool } from "../db.js";
import { ensureAdminExtendedSchema } from "./adminExtendedSchema.js";

function adminExtendedToJson(value) {
  try {
    return value == null ? null : JSON.stringify(value);
  } catch {
    return JSON.stringify({ fallback: "metadata_serialization_failed" });
  }
}

export async function adminExtendedLogAdminAction({
  adminId,
  actionType,
  targetType = "service_request",
  targetId,
  metadata = null,
}) {
  await ensureAdminExtendedSchema();
  const pool = await getPool();

  await pool.execute(
    `INSERT INTO admin_actions_log (admin_id, action_type, target_type, target_id, metadata)
     VALUES (?, ?, ?, ?, ?)`,
    [String(adminId || "admin"), String(actionType || "unknown"), String(targetType || "unknown"), String(targetId || "unknown"), adminExtendedToJson(metadata)]
  );
}

