import "../loadEnv.js";
import { getPool } from "../db.js";
import { canonicalizeServiceDomain } from "../services/serviceNormalization.js";

function stripVehiclePrefix(value) {
  return String(value || "").replace(/^(car|bike|ev|commercial)[\-_]+/i, "").trim();
}

function normalizeDomain(value) {
  const stripped = stripVehiclePrefix(value);
  return canonicalizeServiceDomain(stripped);
}

function parseSpecialties(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => String(key).trim())
      .filter(Boolean);
  }

  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];

    try {
      const parsed = JSON.parse(text);
      return parseSpecialties(parsed);
    } catch {
      if (text.includes(",")) {
        return text.split(",").map((s) => s.trim()).filter(Boolean);
      }
      return [text];
    }
  }

  return [];
}

function normalizeSpecialtiesList(list) {
  const out = [];
  const seen = new Set();
  list.forEach((item) => {
    const normalized = normalizeDomain(item);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });
  return out;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    limit: null,
    id: null,
  };

  argv.forEach((arg) => {
    if (arg === "--apply") args.apply = true;
    if (arg.startsWith("--limit=")) args.limit = Number(arg.split("=")[1]) || null;
    if (arg.startsWith("--id=")) args.id = Number(arg.split("=")[1]) || null;
  });
  return args;
}

async function run() {
  const { apply, limit, id } = parseArgs(process.argv.slice(2));
  const pool = await getPool();

  const where = [];
  const params = [];
  if (Number.isFinite(id) && id > 0) {
    where.push("id = ?");
    params.push(id);
  }

  let sql = "SELECT id, service_type, specialties FROM technicians";
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY id ASC";
  if (Number.isFinite(limit) && limit > 0) sql += ` LIMIT ${limit}`;

  const [rows] = await pool.query(sql, params);
  const changes = [];

  for (const row of rows) {
    const rawServiceType = String(row.service_type || "").trim();
    const rawSpecialties = parseSpecialties(row.specialties);

    let normalizedSpecialties = normalizeSpecialtiesList(rawSpecialties);
    const normalizedServiceTypeFromRaw = normalizeDomain(rawServiceType);

    if (normalizedSpecialties.length === 0 && normalizedServiceTypeFromRaw) {
      normalizedSpecialties = [normalizedServiceTypeFromRaw];
    }

    const normalizedServiceType =
      normalizedServiceTypeFromRaw ||
      normalizedSpecialties[0] ||
      "other";

    if (normalizedSpecialties.length === 0) {
      normalizedSpecialties = [normalizedServiceType];
    }

    const oldSpecialtiesJson = JSON.stringify(rawSpecialties);
    const newSpecialtiesJson = JSON.stringify(normalizedSpecialties);
    const serviceChanged = rawServiceType !== normalizedServiceType;
    const specialtiesChanged = oldSpecialtiesJson !== newSpecialtiesJson;

    if (!serviceChanged && !specialtiesChanged) continue;

    changes.push({
      id: row.id,
      old_service_type: rawServiceType,
      new_service_type: normalizedServiceType,
      old_specialties: rawSpecialties,
      new_specialties: normalizedSpecialties,
      serviceChanged,
      specialtiesChanged,
    });
  }

  console.log(`[Normalize Technician Domains] Scanned ${rows.length} technicians`);
  console.log(`[Normalize Technician Domains] Rows needing update: ${changes.length}`);

  if (changes.length > 0) {
    console.log("[Normalize Technician Domains] Sample changes:");
    changes.slice(0, 20).forEach((c) => {
      console.log(
        `- #${c.id} service_type: "${c.old_service_type}" -> "${c.new_service_type}", specialties: ${JSON.stringify(
          c.old_specialties
        )} -> ${JSON.stringify(c.new_specialties)}`
      );
    });
  }

  if (!apply) {
    console.log("\nDry run complete. Re-run with --apply to persist changes.");
    return;
  }

  let updated = 0;
  for (const c of changes) {
    await pool.execute(
      "UPDATE technicians SET service_type = ?, specialties = ? WHERE id = ?",
      [c.new_service_type, JSON.stringify(c.new_specialties), c.id]
    );
    updated += 1;
  }

  console.log(`[Normalize Technician Domains] Updated rows: ${updated}`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[Normalize Technician Domains] Failed:", err?.message || err);
    process.exit(1);
  });
