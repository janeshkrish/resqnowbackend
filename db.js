import mysql from "mysql2/promise";
import { withUuidPersistence } from "./models/persistence.js";
import { prepareDeploymentDatabase } from "./models/migrations/deploymentMigration.js";

let pool = null;
let poolPromise = null;

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function assertDatabaseConfig() {
  if (!isProductionLike()) return;

  const requiredKeys = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = requiredKeys.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    throw new Error(`[DB CONFIG] Missing required environment variables: ${missing.join(", ")}`);
  }

  const host = String(process.env.DB_HOST || "").trim().toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    throw new Error("[DB CONFIG] DB_HOST cannot point to localhost in production/Render.");
  }
}

export async function getPool() {
  assertDatabaseConfig();
  if (pool) return pool;
  if (!poolPromise) poolPromise = createPool().finally(() => { poolPromise = null; });
  return poolPromise;
}

async function createPool() {
  const deployment = await prepareDeploymentDatabase(process.env);
  const port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 4000;
  const useSsl = process.env.DB_SSL === "true" || process.env.DB_SSL === "1";
  const candidate = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number.isNaN(port) ? 4000 : port,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: deployment.database,
    waitForConnections: true,
    connectionLimit: 100,
    queueLimit: 0,
    ...(useSsl && {
      // TiDB Cloud uses TLS; allow non-strict verification for convenience unless user provides certs
      ssl: {
        rejectUnauthorized: process.env.DB_SSL_STRICT === 'true',
      },
    }),
  });

  // Quick connectivity check to surface helpful error messages early
  try {
    await candidate.query('SELECT 1');
  } catch (err) {
    console.error(`Database connectivity test failed to ${process.env.DB_HOST}:${process.env.DB_PORT} (ssl=${process.env.DB_SSL}).`, err.message || err);
    await candidate.end();
    throw err;
  }

  pool = withUuidPersistence(candidate);
  return pool;
}

export async function closePool() {
  if (poolPromise) { try { await poolPromise; } catch { /* initialization already failed */ } }
  if (!pool) return;
  const current = pool;
  pool = null;
  try {
    await current.end();
  } catch (err) {
    console.error("Error while closing DB pool:", err?.message || err);
  }
}

export async function query(sql, params = []) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}


// Preserve existing imports while keeping database definitions under models.
export * from "./models/bootstrap.js";
