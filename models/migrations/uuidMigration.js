import { isUuid, migratedId } from "../identifiers.js";
import { boundedIdempotencyKey } from "../../utils/paymentReference.js";
import { COLUMN_TARGETS, EXTERNAL_IDS, JSON_ID_TARGETS, MODEL_TABLES, SOURCE_TABLES, POLYMORPHIC, referenceTarget } from "../relationships.js";

export const UUID_TYPE = "CHAR(36) CHARACTER SET ascii COLLATE ascii_bin";
export const quoteIdentifier = (value) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Unsafe database identifier: ${value}`);
  return `\`${value}\``;
};

const key = value => String(value);
const aliases = new Set(["admin", "unknown-admin"]);
const nonEntityTargets = new Set(["all", "broadcast", "system", "settings", "configuration", "notification", "notifications", "technicians"]);

export function migrateIdempotencyKey(table, value, resolve) {
  if (!value) return value;
  const [prefix, id, ...suffix] = String(value).split(":");
  const targets = {
    "payment-credit": "payments", "payment-payout": "payments", "refund-adjustment": "payments",
    "manual-payout": "payouts", "withdrawal-request": "withdrawal_requests", "withdrawal-payout": "withdrawal_requests",
    "wallet-payout": table === "payouts" ? "technicians" : "payouts",
  };
  if (!targets[prefix] || !id) return value;
  return boundedIdempotencyKey([prefix, resolve(targets[prefix], id, `${table}.idempotency_key`), ...suffix].join(":"));
}

export function migrateJsonIds(value, resolve, path = "") {
  if (Array.isArray(value)) return value.map((item, index) => migrateJsonIds(item, resolve, `${path}[${index}]`));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const target = JSON_ID_TARGETS[name];
    if (target && item != null && item !== "" && item !== 0) {
      const convert = id => resolve(target, id, `${path}.${name}`);
      return [name, Array.isArray(item) ? item.map(convert) : convert(item)];
    }
    return [name, migrateJsonIds(item, resolve, `${path}.${name}`)];
  }));
}

export async function inspectDatabase(connection) {
  const [columns] = await connection.query(
    `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type,
            column_type AS column_type, is_nullable AS is_nullable, column_default AS column_default,
            extra AS extra, character_maximum_length AS character_maximum_length,
            character_set_name AS character_set_name, collation_name AS collation_name
     FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`
  );
  const [foreignKeys] = await connection.query(
    `SELECT k.table_name AS table_name, k.constraint_name AS constraint_name, k.column_name AS column_name,
            k.referenced_table_name AS referenced_table_name, k.referenced_column_name AS referenced_column_name,
            k.ordinal_position AS ordinal_position, r.update_rule AS update_rule, r.delete_rule AS delete_rule
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema
       AND r.table_name = k.table_name AND r.constraint_name = k.constraint_name
     WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL
     ORDER BY k.table_name, k.constraint_name, k.ordinal_position`
  );
  const tables = new Map();
  for (const column of columns) {
    if (!tables.has(column.table_name)) tables.set(column.table_name, []);
    tables.get(column.table_name).push(column);
  }
  const unknown = [...tables].filter(([name]) => !SOURCE_TABLES.includes(name));
  if (unknown.length) throw new Error(`Unmodeled tables require review before conversion: ${unknown.map(([name]) => name).join(", ")}`);
  for (const fk of foreignKeys) {
    if (!SOURCE_TABLES.includes(fk.table_name) || !SOURCE_TABLES.includes(fk.referenced_table_name) || fk.referenced_column_name !== "id") {
      throw new Error(`Unmodeled relationship: ${fk.table_name}.${fk.column_name} -> ${fk.referenced_table_name}.${fk.referenced_column_name}`);
    }
    const target = referenceTarget(fk.table_name, fk.column_name);
    if (target && target !== fk.referenced_table_name) throw new Error(`Relationship disagrees with models: ${fk.table_name}.${fk.column_name}`);
  }
  return { tables, foreignKeys };
}

function identityColumn(column, table, foreignKeys) {
  const name = column.column_name;
  return name === "id" || Object.hasOwn(COLUMN_TARGETS, name) || Object.hasOwn(POLYMORPHIC[table] || {}, name) ||
    name === "admin_email" || (table === "admin_audit_logs" && name === "targetId") || foreignKeys.some(fk => fk.table_name === table && fk.column_name === name);
}

// Plan contains explicit values and can be reviewed/applied without re-reading rows.
// Treat it like a database backup: it includes existing JSON audit data and emails.
export async function buildUuidMigrationPlan(connection, { adminEmail = "" } = {}) {
  const metadata = await inspectDatabase(connection);
  const [[versionRow]] = await connection.query("SELECT VERSION() AS version");
  const engine = String(versionRow.version);
  const inPlaceSupported = !/tidb/i.test(engine) || ![...metadata.tables].some(([table, columns]) => MODEL_TABLES.includes(table) && columns.some(column => column.column_name === "id" && column.data_type !== "char"));
  for (const [table, columns] of metadata.tables) {
    if (!SOURCE_TABLES.includes(table)) continue;
    const unknown = columns.filter(column => column.column_name.endsWith("_id") && !EXTERNAL_IDS.has(column.column_name) && !identityColumn(column, table, metadata.foreignKeys));
    if (unknown.length) throw new Error(`Unmodeled ID columns require review: ${unknown.map(column => `${table}.${column.column_name}`).join(", ")}`);
  }
  const records = new Map();
  for (const [table, columns] of metadata.tables) {
    if (!SOURCE_TABLES.includes(table)) continue;
    const selected = columns.filter(column => identityColumn(column, table, metadata.foreignKeys) || column.data_type === "json" ||
      column.column_name === "idempotency_key" ||
      Object.values(POLYMORPHIC[table] || {}).includes(column.column_name) ||
      (table === "admin_audit_logs" && column.column_name === "actionType") ||
      (table === "users" && column.column_name === "email") ||
      (table.startsWith("otp_") && ["email", "otp_hash", "expires_at", "created_at", "updated_at", "otp_request_count", "otp_last_request_time", "otp_window_start_time"].includes(column.column_name)));
    const [rows] = await connection.query(`SELECT ${selected.map(column => quoteIdentifier(column.column_name)).join(", ")} FROM ${quoteIdentifier(table)}`);
    records.set(table, rows);
  }
  const principals = new Map((records.get("users") || []).filter(row => row.email).map(row => [row.email.toLowerCase(), row.id]));
  const idSets = new Map([...records].map(([table, rows]) => [table, new Set(rows.flatMap(row => [key(row.id), migratedId(table, row.id)]))]));
  const newUsers = new Map();
  const issues = [];
  const resolve = (target, value, context) => {
    if (value == null || value === "") return null;
    if (target === "users" && typeof value === "string" && !isUuid(value) && !/^\d+$/.test(value)) {
      const email = (aliases.has(value.toLowerCase()) ? adminEmail : value).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        issues.push(`${context}: unresolved admin/user identity ${value}`);
        return value;
      }
      if (principals.has(email)) return migratedId("users", principals.get(email));
      const id = migratedId("users", `historical-admin:${email}`);
      newUsers.set(email, { id, email });
      return id;
    }
    // An already-converted reference must still resolve to its intended parent.
    const found = idSets.get(target)?.has(key(value));
    if (!found) issues.push(`${context}: orphan ${target} reference ${value}`);
    return migratedId(target, value);
  };

  const conversions = [];
  for (const [table, rows] of records) {
    if (table === "otp_rate_limits") continue;
    const columns = metadata.tables.get(table);
    for (const row of rows) {
      const changes = {};
      for (const column of columns) {
        const name = column.column_name;
        if (name === "id" || row[name] == null) continue;
        const context = `${table}.${name} (${row.id})`;
        if (name === "idempotency_key") {
          const migrated = migrateIdempotencyKey(table, row[name], resolve);
          if (migrated !== row[name]) changes[name] = migrated;
          continue;
        }
        const fk = metadata.foreignKeys.find(fk => fk.table_name === table && fk.column_name === name);
        const target = name === "admin_email" ? "users" : fk?.referenced_table_name || referenceTarget(table, name, row);
        if (target) {
          const destination = name === "admin_email" ? "admin_id" : name;
          const resolved = resolve(target, row[name], context);
          if (resolved !== row[destination]) changes[destination] = resolved;
        } else if (POLYMORPHIC[table]?.[name] && row[name] != null) {
          const type = String(row[POLYMORPHIC[table][name]] || "").toLowerCase();
          if (type === "system" && ["actor_id", "uploaded_by_id"].includes(name)) changes[name] = null;
          else if (!nonEntityTargets.has(type)) issues.push(`${context}: unknown polymorphic target type ${type}`);
        } else if (table === "admin_audit_logs" && name === "targetId" && row[name] != null) {
          issues.push(`${context}: cannot infer the audit target's table`);
        } else if (column.data_type === "json") {
          let json = row[name];
          if (typeof json === "string") {
            try { json = JSON.parse(json); } catch { issues.push(`${context}: invalid JSON`); continue; }
          }
          const migrated = migrateJsonIds(json, resolve, context);
          if (table === "admin_audit_logs" && row.targetId != null) {
            const auditTarget = referenceTarget(table, "targetId", row);
            for (const group of ["params", "body"]) {
              if (auditTarget && migrated?.[group]?.id != null && String(json[group]?.id) === String(row.targetId)) {
                migrated[group].id = resolve(auditTarget, json[group].id, `${context}.${group}.id`);
              }
            }
          }
          if (JSON.stringify(migrated) !== JSON.stringify(json)) changes[name] = JSON.stringify(migrated);
        } else if (name.endsWith("_id") && !EXTERNAL_IDS.has(name) && !identityColumn(column, table, metadata.foreignKeys)) {
          issues.push(`${context}: unmodeled ID column`);
        }
      }
      // ID goes last because MySQL evaluates UPDATE assignments left to right.
      if (row.id !== migratedId(table, row.id)) changes.id = migratedId(table, row.id);
      if (Object.keys(changes).length) conversions.push({ table, oldId: key(row.id), newId: migratedId(table, row.id), changes });
    }
  }
  const conversionsByRecord = new Map(conversions.map(item => [`${item.table}:${item.oldId}`, item]));
  for (const [table, rows] of records) {
    const seen = new Set();
    for (const row of rows) {
      const converted = conversionsByRecord.get(`${table}:${key(row.id)}`);
      const idempotency = converted?.changes.idempotency_key ?? row.idempotency_key;
      if (idempotency == null) continue;
      if (seen.has(idempotency)) issues.push(`${table}: duplicate idempotency key after UUID conversion`);
      seen.add(idempotency);
    }
  }
  if (issues.length) throw new Error(`UUID migration preflight failed (${issues.length} issues):\n${issues.slice(0, 30).join("\n")}`);
  return {
    version: 1, createdAt: new Date().toISOString(), adminEmail, engine, inPlaceSupported,
    metadata: { tables: Object.fromEntries(metadata.tables), foreignKeys: metadata.foreignKeys },
    counts: Object.fromEntries([...records].map(([table, rows]) => [table, rows.length])),
    newUsers: [...newUsers.values()], conversions,
    otp: { requests: records.get("otp_requests") || [], limits: records.get("otp_rate_limits") || [] },
  };
}

export function foreignKeySql(rows) {
  const first = rows[0];
  return `ALTER TABLE ${quoteIdentifier(first.table_name)} ADD CONSTRAINT ${quoteIdentifier(first.constraint_name)} FOREIGN KEY (${rows.map(row => quoteIdentifier(row.column_name)).join(", ")}) REFERENCES ${quoteIdentifier(first.referenced_table_name)} (${rows.map(row => quoteIdentifier(row.referenced_column_name)).join(", ")}) ON UPDATE ${first.update_rule} ON DELETE ${first.delete_rule}`;
}

export async function applyUuidMigrationPlan(connection, plan, { checkpoint = async () => {}, completed = new Set() } = {}) {
  if (plan.version !== 1) throw new Error("Unsupported UUID migration plan.");
  if (Object.keys(plan.metadata.tables).some(table => ["technician_admin_notes", "admin_customer_notes", "technician_approval_audit", "admin_audit_logs"].includes(table))) {
    throw new Error("This schema also needs relational table consolidation. Use the deployment transfer or portable export instead of in-place UUID-only migration.");
  }
  if (plan.inPlaceSupported === false) throw new Error("TiDB does not support this primary-key type change in place. Use --export and restore into a separate empty database, verify it, then switch DB_NAME.");
  if (plan.metadata.tables.otp_rate_limits || plan.metadata.tables.otp_requests) {
    throw new Error("Use deployment transfer or portable export to preserve every OTP/history row; in-place OTP consolidation is disabled.");
  }
  const step = async (name, run) => {
    if (completed.has(name)) return;
    await run();
    completed.add(name);
    await checkpoint([...completed]);
  };
  const metadata = await inspectDatabase(connection);
  const foreignKeys = new Map();
  for (const fk of plan.metadata.foreignKeys) {
    const name = `${fk.table_name}.${fk.constraint_name}`;
    if (!foreignKeys.has(name)) foreignKeys.set(name, []);
    foreignKeys.get(name).push(fk);
  }
  for (const [name, rows] of foreignKeys) await step(`drop-fk:${name}`, async () => {
    if (metadata.foreignKeys.some(fk => `${fk.table_name}.${fk.constraint_name}` === name)) {
      await connection.query(`ALTER TABLE ${quoteIdentifier(rows[0].table_name)} DROP FOREIGN KEY ${quoteIdentifier(rows[0].constraint_name)}`);
    }
  });
  for (const [table, columns] of Object.entries(plan.metadata.tables)) {
    if (!MODEL_TABLES.includes(table)) continue;
    for (const column of columns) {
      if (!identityColumn(column, table, plan.metadata.foreignKeys)) continue;
      if (["target_id", "reference_id"].includes(column.column_name)) continue; // mixed entity/configuration targets
      const name = column.column_name;
      await step(`column:${table}.${name}`, async () => {
        if (name === "admin_email") {
          const [existing] = await connection.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'admin_id'", [table]);
          if (!existing.length) await connection.query(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN admin_id ${UUID_TYPE} NULL`);
        } else {
          // References may currently contain long emails. Widen first, rewrite
          // identities, and only then narrow to CHAR(36), avoiding truncation.
          const type = name === "id" ? UUID_TYPE : "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";
          await connection.query(`ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(name)} ${type} ${name === "id" || column.is_nullable === "NO" ? "NOT NULL" : "NULL"}`);
        }
      });
    }
  }
  for (const principal of plan.newUsers) await step(`principal:${principal.id}`, async () => {
    await connection.execute(
      "INSERT INTO users (id, full_name, email, is_verified, status) VALUES (?, 'Historical admin', ?, TRUE, 'approved') ON DUPLICATE KEY UPDATE email = VALUES(email)",
      [principal.id, principal.email]
    );
  });
  for (const [index, conversion] of plan.conversions.entries()) await step(`row:${index}`, async () => {
    const entries = Object.entries(conversion.changes);
    const preserveTime = plan.metadata.tables[conversion.table].some(column => column.column_name === "updated_at") ? ", updated_at = updated_at" : "";
    await connection.execute(
      `UPDATE ${quoteIdentifier(conversion.table)} SET ${entries.map(([name]) => `${quoteIdentifier(name)} = ?`).join(", ")}${preserveTime} WHERE id IN (?, ?)`,
      [...entries.map(([, value]) => value), conversion.oldId, conversion.newId]
    );
  });
  for (const [table, columns] of Object.entries(plan.metadata.tables)) {
    if (!MODEL_TABLES.includes(table)) continue;
    for (const column of columns) {
      const name = column.column_name;
      if (["id", "admin_email", "target_id", "reference_id"].includes(name) || !identityColumn(column, table, plan.metadata.foreignKeys)) continue;
      await step(`uuid-column:${table}.${name}`, () => connection.query(
        `ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(name)} ${UUID_TYPE} ${column.is_nullable === "NO" ? "NOT NULL" : "NULL"}`
      ));
    }
  }
  // Reinstall the exact preexisting constraints, including their delete/update rules.
  for (const [name, rows] of foreignKeys) await step(`restore-fk:${name}`, async () => {
    const [existing] = await connection.query("SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ?", [rows[0].table_name, rows[0].constraint_name]);
    if (!existing.length) await connection.query(foreignKeySql(rows));
  });
  await step("validate", async () => {
    const current = await buildUuidMigrationPlan(connection, { adminEmail: plan.adminEmail });
    if (current.conversions.length) throw new Error("UUID conversion remains incomplete.");
    for (const [table, count] of Object.entries(plan.counts)) {
      if (table.startsWith("otp_")) continue;
      const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
      const expected = count + (table === "users" ? plan.newUsers.length : 0);
      if (Number(row.count) !== expected) throw new Error(`Row count mismatch for ${table}: expected ${expected}, got ${row.count}`);
    }
  });
  return { completed: [...completed], tables: MODEL_TABLES.length };
}
