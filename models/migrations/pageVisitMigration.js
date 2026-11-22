import * as schema from '../schema/pageVisit.js';

export const PAGE_VISIT_SCHEMA_VERSION = 1;

const indexes = {
  page_visit: {
    PRIMARY: ['id'],
    idx_page_visit_created_at: ['created_at'],
    idx_page_visit_ip: ['ip_address'],
    idx_page_visit_session: ['session_id'],
  },
};

export async function migratePageVisit({ pool, mode = 'plan' }) {
  if (!['plan', 'check', 'apply'].includes(mode)) {
    throw new Error('Expected plan, check or apply');
  }

  const statements = Object.values(schema);
  if (mode === 'plan') {
    return { version: PAGE_VISIT_SCHEMA_VERSION, statements };
  }

  if (mode === 'apply') {
    for (const sql of statements) {
      await pool.query(sql);
    }
  }

  const tables = [];
  for (const name of Object.keys(schema)) {
    const [columns] = await pool.query(`SHOW COLUMNS FROM ${name}`);
    if (!columns.some((c) => c.Field === 'id' && /^char\(36\)$/i.test(c.Type) && c.Key === 'PRI')) {
      throw new Error('Page visit schema requires UUID primary keys');
    }

    const [actualIndexes] = await pool.query(`SHOW INDEX FROM ${name}`);
    for (const [key, fields] of Object.entries(indexes[name])) {
      const actual = actualIndexes
        .filter((i) => i.Key_name === key)
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index);

      if (actual.map((i) => i.Column_name).join(',') !== fields.join(',')) {
        throw new Error(`Missing or incompatible index: ${name}.${key}`);
      }
    }
    tables.push(name);
  }

  return { version: PAGE_VISIT_SCHEMA_VERSION, tables };
}
