import { SOURCE_TABLES } from "../relationships.js";
import { quoteIdentifier } from "./uuidMigration.js";

// An operator-reviewed scope never modifies the source. Excluded rows/tables
// remain in the retained legacy database, with their original IDs and content.
// The normal migrator stays strict unless this explicit wrapper is supplied.
export function reviewedSourceConnection(connection, review) {
  const archiveTables = new Set(review.unmodeledTablesRetainedInSource || []);
  for (const table of archiveTables) {
    quoteIdentifier(table);
    if (SOURCE_TABLES.includes(table)) throw new Error(`Cannot archive an entire active model table: ${table}`);
  }
  const exclusions = new Map(Object.entries(review.quarantinedRowsRetainedInSource || {}).map(([table, ids]) => {
    quoteIdentifier(table);
    if (!SOURCE_TABLES.includes(table) || !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)) throw new Error("Invalid reviewed row exclusions.");
    return [table, new Set(ids)];
  }));
  const query = async (sql, params = []) => {
    if (!/^(SELECT|SHOW|SET|START TRANSACTION|ROLLBACK)\b/i.test(sql.trim())) throw new Error("Reviewed legacy source is read-only.");
    const table = sql.match(/FROM `(\w+)`/)?.[1];
    const excluded = exclusions.get(table);
    if (excluded?.size && /ORDER BY id LIMIT 100$/.test(sql)) {
      // Filter before LIMIT: filtering a returned page could hide later rows if
      // all 100 rows in an intermediate page were retained only in the archive.
      const condition = `${/\bWHERE\b/i.test(sql) ? "AND" : "WHERE"} id NOT IN (${[...excluded].map(() => "?").join(",")}) `;
      sql = sql.replace(/ORDER BY id LIMIT 100$/, `${condition}ORDER BY id LIMIT 100`);
      params = [...params, ...excluded];
    }
    const [rows, fields] = await connection.query(sql, params);
    if (/FROM information_schema.columns/.test(sql)) {
      const unknown = rows.filter(row => !SOURCE_TABLES.includes(row.table_name) && !archiveTables.has(row.table_name));
      if (unknown.length) throw new Error(`Unreviewed legacy table: ${unknown[0].table_name}`);
      return [rows.filter(row => !archiveTables.has(row.table_name)), fields];
    }
    if (/FROM information_schema.key_column_usage/.test(sql)) {
      const active = rows.filter(row => !archiveTables.has(row.table_name));
      if (active.some(row => archiveTables.has(row.referenced_table_name))) throw new Error("Active table references an archived table; reconcile the relationship first.");
      return [active, fields];
    }
    return [excluded ? rows.filter(row => !excluded.has(String(row.id))) : rows, fields];
  };
  return new Proxy(connection, { get(target, property) {
    if (property === "query") return query;
    if (property === "execute") return () => { throw new Error("Reviewed legacy source is read-only."); };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
