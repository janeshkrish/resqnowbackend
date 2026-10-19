import "../loadEnv.js";
import mysql from "mysql2/promise";

const connection = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 4000), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 15000,
  ...(process.env.DB_SSL === "true" || process.env.DB_SSL === "1" ? { ssl: { rejectUnauthorized: process.env.DB_SSL_STRICT === "true" } } : {}),
});
try {
  const [[version]] = await connection.query("SELECT VERSION() AS version");
  const [tables] = await connection.query("SELECT table_name AS table_name, table_type AS table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name");
  const report = [];
  for (const table of tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.table_name)) throw new Error("Unsupported table identifier.");
    const [[count]] = await connection.query(`SELECT COUNT(*) AS count FROM \`${table.table_name}\``);
    const [columns] = await connection.query("SELECT column_name AS column_name, column_type AS column_type, extra AS extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [table.table_name]);
    report.push({ table: table.table_name, type: table.table_type, rows: count.count, columns });
  }
  console.log(JSON.stringify({ version: version.version, tables: report }, null, 2));
} finally { await connection.end(); }
