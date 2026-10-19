import mysql from "mysql2/promise";
import { TABLES } from "../schema/index.js";
import { COLUMN_TARGETS, POLYMORPHIC } from "../relationships.js";
import { migratedId } from "../identifiers.js";
import { UUID_TYPE, quoteIdentifier } from "./uuidMigration.js";
import { assertConsolidationColumns, consolidatedSchema, destinationTable, transformRelationalRow } from "./relationalRows.js";

// TiDB cannot change an integer clustered primary key into a string in place.
// Export a converted snapshot for restoration into a separate EMPTY database.
// This creates exactly the modeled tables; no persistent mapping/shadow tables.
export function convertCreateTable(sql, table, columns, foreignKeys) {
  if (table === "otp_requests") return TABLES.otp_requests;
  const relationships = new Set(columns.filter(column => column.column_name === "id" ||
    Object.hasOwn(COLUMN_TARGETS, column.column_name) ||
    Object.hasOwn(POLYMORPHIC[table] || {}, column.column_name) ||
    column.column_name === "admin_email" || (table === "admin_audit_logs" && column.column_name === "targetId") || foreignKeys.some(fk => fk.table_name === table && fk.column_name === column.column_name))
    .map(column => column.column_name));
  let output = sql.split(/\r?\n/).filter(line => !/^\s*CONSTRAINT\s+.*\bFOREIGN KEY\b/i.test(line)).map(line => {
    const match = line.match(/^\s*`(\w+)`\s+/);
    if (!match || !relationships.has(match[1]) || (["reference_id", "target_id"].includes(match[1]) && !foreignKeys.some(fk => fk.table_name === table && fk.column_name === match[1]))) return line;
    const column = columns.find(column => column.column_name === match[1]);
    const name = match[1] === "admin_email" ? "admin_id" : match[1];
    const nullable = column.is_nullable !== "NO" && name !== "id";
    return `  ${quoteIdentifier(name)} ${UUID_TYPE} ${nullable ? "NULL" : "NOT NULL"},`;
  }).join("\n");
  output = output.replace(/,\s*\n\)/g, "\n)").replace(/\bAUTO_INCREMENT\s*=\s*\d+\s*/ig, "");
  if (table === "technician_approval_audit") output = output.replaceAll("`admin_email`", "`admin_id`");
  return output;
}

export function convertedRow(plan, table, original, conversions) {
  const row = { ...original, ...(conversions.get(String(original.id)) || {}) };
  if (table === "technician_approval_audit") delete row.admin_email;
  return row;
}

export function consolidatedOtpRows(plan) {
  const latest = new Map();
  const compareId = (a, b) => /^\d+$/.test(String(a)) && /^\d+$/.test(String(b))
    ? BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
    : String(a).localeCompare(String(b));
  for (const row of [...plan.otp.requests].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || compareId(a.id, b.id))) latest.set(row.email, row);
  const limits = new Map(plan.otp.limits.map(row => [row.email, row]));
  return [...new Set([...latest.keys(), ...limits.keys()])].map(email => {
    const request = latest.get(email);
    const limit = limits.get(email);
    const requests = plan.otp.requests.filter(row => row.email === email);
    // Every old row is retained inside the existing destination record. Runtime
    // challenge consumption never updates this history. Already migrated state
    // keeps its history unchanged when copied again.
    const history = requests.length === 1 && request.migration_history != null && !limit
      ? typeof request.migration_history === "string" ? JSON.parse(request.migration_history) : request.migration_history
      : {
        requests: requests.map(row => ({ ...row, id: migratedId("otp_requests", row.id) })),
        rate_limits: plan.otp.limits.filter(row => row.email === email).map(row => ({ ...row, id: migratedId("otp_rate_limits", row.id ?? row.email) })),
      };
    return {
      id: migratedId("otp_requests", request?.id ?? `throttle:${email}`), email,
      otp_hash: request?.otp_hash ?? null, expires_at: request?.expires_at ?? null,
      otp_request_count: limit?.otp_request_count ?? request?.otp_request_count ?? 0,
      otp_last_request_time: limit?.otp_last_request_time ?? request?.otp_last_request_time ?? null,
      otp_window_start_time: limit?.otp_window_start_time ?? request?.otp_window_start_time ?? null,
      migration_history: history,
      ...(request?.created_at || limit?.created_at ? { created_at: request?.created_at || limit?.created_at } : {}),
      ...(request?.updated_at || limit?.updated_at ? { updated_at: request?.updated_at || limit?.updated_at } : {}),
    };
  });
}

export function insertSql(table, row) {
  const entries = Object.entries(row);
  const values = entries.map(([, value]) => {
    if (value != null && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) return JSON.stringify(value);
    return value;
  });
  return mysql.format(`INSERT INTO ${quoteIdentifier(table)} (${entries.map(([name]) => quoteIdentifier(name)).join(", ")}) VALUES (${values.map(() => "?").join(", ")});`, values);
}

export async function exportUuidDatabase(connection, plan, write) {
  assertConsolidationColumns(plan);
  await write("-- ResQNow UUID snapshot. Restore into a separate EMPTY database.\n-- Private database data: do not commit or share this file.\nSET NAMES utf8mb4;\nSET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';\nSET time_zone = '+00:00';\n");
  const sources = Object.keys(plan.metadata.tables);
  const actualTables = [...new Set(sources.map(destinationTable))];
  for (const table of actualTables) {
    if (consolidatedSchema(table)) {
      await write(`${consolidatedSchema(table).replace("IF NOT EXISTS ", "")};\n`);
      continue;
    }
    const [[row]] = await connection.query(`SHOW CREATE TABLE ${quoteIdentifier(table)}`);
    const original = row["Create Table"];
    // CREATE (without IF NOT EXISTS) prevents importing over an existing application.
    const ddl = convertCreateTable(original, table, plan.metadata.tables[table], plan.metadata.foreignKeys).replace(/CREATE TABLE IF NOT EXISTS/i, "CREATE TABLE");
    await write(`${ddl};\n`);
  }
  const exportedCounts = {};
  for (const table of actualTables) {
    let count = 0;
    if (table === "otp_requests") {
      for (const row of consolidatedOtpRows(plan)) { await write(`${insertSql(table, row)}\n`); count++; }
    } else {
      for (const source of sources.filter(source => destinationTable(source) === table)) {
        const conversions = new Map(plan.conversions.filter(row => row.table === source).map(row => [row.oldId, row.changes]));
        let cursor = null;
        for (;;) {
          const [rows] = await connection.query(
            `SELECT * FROM ${quoteIdentifier(source)} ${cursor == null ? "" : "WHERE id > ?"} ORDER BY id LIMIT 100`,
            cursor == null ? [] : [cursor]
          );
          if (!rows.length) break;
          for (const original of rows) {
            await write(`${insertSql(table, transformRelationalRow(plan, source, original, conversions.get(String(original.id))))}\n`);
            count++;
          }
          cursor = rows.at(-1).id;
        }
      }
      if (table === "users") {
        for (const principal of plan.newUsers) {
          await write(`${insertSql(table, { id: principal.id, full_name: "Historical admin", email: principal.email, is_verified: true, status: "approved" })}\n`);
          count++;
        }
      }
    }
    exportedCounts[table] = count;
    const expected = table === "otp_requests" ? consolidatedOtpRows(plan).length : sources.filter(source => destinationTable(source) === table).reduce((sum, source) => sum + plan.counts[source], 0) + (table === "users" ? plan.newUsers.length : 0);
    if (count !== expected) throw new Error(`Source changed during export: ${table} expected ${expected} rows, found ${count}. Stop writers and export again.`);
  }
  return exportedCounts;
}
