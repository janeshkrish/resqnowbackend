import "../loadEnv.js";
import { getPool } from "../db.js";
import { estimateRequestAmountAsync } from "../services/pricingEstimator.js";
import { getPlatformPricingConfig } from "../services/platformPricing.js";

const DEFAULT_STATUSES = ["pending", "assigned"];

const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

function parseArgs(argv) {
  const args = {
    apply: false,
    limit: null,
    requestId: null,
    statuses: [...DEFAULT_STATUSES],
  };

  argv.forEach((arg) => {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--limit=")) {
      const parsed = Number(arg.split("=")[1]);
      args.limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    }
    if (arg.startsWith("--request-id=")) {
      const parsed = Number(arg.split("=")[1]);
      args.requestId = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    }
    if (arg.startsWith("--statuses=")) {
      const statuses = arg
        .split("=")[1]
        .split(",")
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean);
      if (statuses.length > 0) args.statuses = statuses;
    }
  });

  return args;
}

function buildWhereClause({ requestId, statuses }) {
  const clauses = [];
  const params = [];

  if (Number.isFinite(requestId) && requestId > 0) {
    clauses.push("sr.id = ?");
    params.push(requestId);
  }

  if (Array.isArray(statuses) && statuses.length > 0) {
    clauses.push(`sr.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const pool = await getPool();
  const pricingConfig = await getPlatformPricingConfig();
  const { whereSql, params } = buildWhereClause(args);

  let sql = `
    SELECT
      sr.id,
      sr.status,
      sr.service_type,
      sr.vehicle_type,
      sr.amount,
      sr.service_charge,
      sr.technician_id,
      t.pricing AS technician_pricing,
      t.service_costs AS technician_service_costs
    FROM service_requests sr
    LEFT JOIN technicians t ON t.id = sr.technician_id
    ${whereSql}
    ORDER BY sr.id ASC
  `;

  if (Number.isFinite(args.limit) && args.limit > 0) {
    sql += ` LIMIT ${args.limit}`;
  }

  const [rows] = await pool.query(sql, params);
  const updates = [];

  for (const row of rows) {
    const currentAmount =
      roundMoney(row?.amount) ??
      roundMoney(row?.service_charge) ??
      null;

    const technicianProfile = Number.isFinite(Number(row?.technician_id)) && Number(row?.technician_id) > 0
      ? {
          pricing: row?.technician_pricing ?? null,
          service_costs: row?.technician_service_costs ?? null,
        }
      : null;

    const estimatedAmountRaw = await estimateRequestAmountAsync(
      { service_type: row?.service_type, vehicle_type: row?.vehicle_type },
      technicianProfile,
      pricingConfig
    );
    const estimatedAmount = roundMoney(estimatedAmountRaw);
    if (estimatedAmount == null || estimatedAmount <= 0) continue;

    if (currentAmount == null || Math.abs(currentAmount - estimatedAmount) >= 0.01) {
      updates.push({
        id: row.id,
        status: row.status,
        technician_id: row.technician_id,
        old_amount: currentAmount,
        new_amount: estimatedAmount,
      });
    }
  }

  console.log("[Backfill Request Amounts] Scan complete");
  console.log(`- Rows scanned: ${rows.length}`);
  console.log(`- Rows needing update: ${updates.length}`);

  if (updates.length > 0) {
    console.log("- Sample changes:");
    updates.slice(0, 20).forEach((item) => {
      console.log(
        `  #${item.id} [${item.status}] tech=${item.technician_id ?? "none"} amount ${item.old_amount ?? "null"} -> ${item.new_amount}`
      );
    });
  }

  if (!args.apply) {
    console.log("Dry run only. Re-run with --apply to persist changes.");
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of updates) {
      await conn.execute(
        "UPDATE service_requests SET amount = ?, updated_at = NOW() WHERE id = ?",
        [item.new_amount, item.id]
      );
    }
    await conn.commit();
    console.log(`[Backfill Request Amounts] Updated rows: ${updates.length}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Backfill Request Amounts] Failed:", err?.message || err);
    process.exit(1);
  });

