import { COLUMN_TARGETS, MODEL_TABLES, POLYMORPHIC, referenceTarget } from "./relationships.js";

// Install missing single-entity foreign keys after every table exists. This also
// handles cycles such as payments -> wallet_transactions -> payments.
export async function ensureModelRelationships(pool) {
  const [columns] = await pool.query("SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns WHERE table_schema = DATABASE()");
  const [existing] = await pool.query("SELECT table_name AS table_name, column_name AS column_name, referenced_table_name AS referenced_table_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL");
  const present = new Set(columns.map(column => `${column.table_name}.${column.column_name}`));
  for (const column of columns) {
    const table = column.table_name;
    const name = column.column_name;
    if (!MODEL_TABLES.includes(table) || !Object.hasOwn(COLUMN_TARGETS, name) || POLYMORPHIC[table]?.[name]) continue;
    const target = referenceTarget(table, name);
    if (!present.has(`${target}.id`)) continue;
    const previous = existing.find(item => item.table_name === table && item.column_name === name);
    if (previous) {
      if (previous.referenced_table_name !== target) throw new Error(`Foreign key mismatch: ${table}.${name}`);
      continue;
    }
    const constraint = `fk_${table}_${name}`.slice(0, 64);
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` FOREIGN KEY (\`${name}\`) REFERENCES \`${target}\` (id)`);
    } catch (error) {
      // Another startup may have installed the same constraint concurrently.
      if (!["ER_FK_DUP_NAME", "ER_DUP_KEYNAME"].includes(error.code)) throw error;
    }
  }
}
