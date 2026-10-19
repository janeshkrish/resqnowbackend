import { getPool } from "../db.js";
import { isUuid } from "./identifiers.js";

// Admin credentials still come from the existing environment configuration, but
// their audit identity is a real users.id instead of a copied email address.
export async function ensureAdminIdentity(email, pool = null) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) throw new Error("Admin email is required.");
  const connection = pool || await getPool();
  await connection.execute(
    `INSERT INTO users (full_name, email, role, is_verified, status)
     VALUES ('Admin', ?, 'admin', TRUE, 'approved')
     ON DUPLICATE KEY UPDATE role = 'admin'`,
    [normalizedEmail]
  );
  const [rows] = await connection.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
  if (!isUuid(rows[0]?.id)) throw new Error("Admin account requires a migrated UUID identity.");
  return rows[0].id;
}

export function adminActorId(req) {
  return req.adminExtended?.adminId || req.admin?.userId || req.admin?.id || null;
}
