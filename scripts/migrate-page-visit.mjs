import mysql from 'mysql2/promise';
import { migratePageVisit } from '../models/migrations/pageVisitMigration.js';

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--check') ? 'check' : 'plan';

if (mode === 'plan') {
  console.log(JSON.stringify(await migratePageVisit({ mode }), null, 2));
} else {
  const database = process.argv.find((a) => a.startsWith('--database='))?.slice(11) || process.env.DB_NAME;
  if (!database || !/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error('Specify the database using --database=NAME or configure DB_NAME');
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 4000),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database,
    connectionLimit: 1,
    ...(['1', 'true'].includes(process.env.DB_SSL)
      ? { ssl: { rejectUnauthorized: process.env.DB_SSL_STRICT === 'true' } }
      : {}),
  });

  try {
    console.log(JSON.stringify(await migratePageVisit({ pool, mode }), null, 2));
  } finally {
    await pool.end();
  }
}
