import { getPool } from "../db.js";
import {
  findTechnicianPricingEntry,
  mapStoredPricingRowToTechnicianPricing,
  normalizePricingServiceType,
  normalizePricingVehicleType,
  normalizeTechnicianPricingEntries,
  toStoredPricingServiceDomain,
} from "../models/technicianPricing.js";

const TECHNICIAN_PRICING_COLUMNS = `
  id,
  technician_id,
  service_domain,
  vehicle_type,
  visit_charge,
  service_charge,
  extra_km_charge,
  labour_min,
  labour_max,
  delivery_charge,
  price_2w_min,
  price_2w_max,
  price_4w_min,
  price_4w_max,
  base_price,
  free_km,
  per_km_price,
  night_charge,
  night_type,
  metadata
`;

const toTechnicianId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

async function queryTechnicianServiceRow(executor, technicianId, storedServiceDomain, vehicleType) {
  const [rows] = await executor.query(
    `SELECT ${TECHNICIAN_PRICING_COLUMNS}
       FROM technician_services
      WHERE technician_id = ?
        AND service_domain = ?
        AND (vehicle_type = ? OR vehicle_type = '')
      ORDER BY CASE WHEN vehicle_type = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT 1`,
    [technicianId, storedServiceDomain, vehicleType, vehicleType]
  );

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function queryTechnicianProfilePricingEntry(executor, technicianId, serviceType, vehicleType) {
  const [rows] = await executor.query("SELECT service_costs FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!row) {
    return null;
  }

  const entries = normalizeTechnicianPricingEntries(row.service_costs);
  return findTechnicianPricingEntry(entries, { serviceType, vehicleType });
}

export async function fetchTechnicianPricingDefinition({ technicianId, serviceType, vehicleType, connection = null }) {
  const normalizedTechnicianId = toTechnicianId(technicianId);
  const normalizedServiceType = normalizePricingServiceType(serviceType);
  const normalizedVehicleType = normalizePricingVehicleType(vehicleType);

  if (!normalizedTechnicianId) {
    throw new Error("technician_id is invalid.");
  }
  if (!normalizedServiceType) {
    throw new Error("service_type is invalid or unsupported.");
  }
  if (!normalizedVehicleType) {
    throw new Error("vehicle_type is required.");
  }

  const executor = connection || await getPool();
  const storedServiceDomain = toStoredPricingServiceDomain(normalizedServiceType);

  const tableRow = await queryTechnicianServiceRow(
    executor,
    normalizedTechnicianId,
    storedServiceDomain,
    normalizedVehicleType
  );
  if (tableRow) {
    return {
      service_type: normalizedServiceType,
      vehicle_type: normalizedVehicleType,
      technician_pricing: mapStoredPricingRowToTechnicianPricing(tableRow, normalizedServiceType),
    };
  }

  const profileEntry = await queryTechnicianProfilePricingEntry(
    executor,
    normalizedTechnicianId,
    normalizedServiceType,
    normalizedVehicleType
  );
  if (!profileEntry) {
    return null;
  }

  return {
    service_type: normalizedServiceType,
    vehicle_type: normalizedVehicleType,
    technician_pricing: mapStoredPricingRowToTechnicianPricing(profileEntry, normalizedServiceType),
  };
}

export async function replaceTechnicianPricingRows(connectionOrPool, technicianId, entries) {
  const normalizedTechnicianId = toTechnicianId(technicianId);
  if (!normalizedTechnicianId) {
    throw new Error("technician_id is invalid.");
  }

  const normalizedEntries = normalizeTechnicianPricingEntries(entries);
  await connectionOrPool.execute("DELETE FROM technician_services WHERE technician_id = ?", [normalizedTechnicianId]);

  if (normalizedEntries.length === 0) {
    return normalizedEntries;
  }

  const placeholders = normalizedEntries
    .map(
      () => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .join(", ");

  const params = normalizedEntries.flatMap((entry) => [
    normalizedTechnicianId,
    entry.service_domain,
    entry.vehicle_type || "",
    entry.visit_charge,
    entry.service_charge,
    entry.extra_km_charge,
    entry.labour_min,
    entry.labour_max,
    entry.delivery_charge,
    entry.price_2w_min,
    entry.price_2w_max,
    entry.price_4w_min,
    entry.price_4w_max,
    entry.base_price,
    entry.free_km,
    entry.per_km_price,
    entry.night_charge,
    entry.night_type,
    JSON.stringify(entry.metadata || {}),
  ]);

  await connectionOrPool.execute(
    `INSERT INTO technician_services (
      technician_id,
      service_domain,
      vehicle_type,
      visit_charge,
      service_charge,
      extra_km_charge,
      labour_min,
      labour_max,
      delivery_charge,
      price_2w_min,
      price_2w_max,
      price_4w_min,
      price_4w_max,
      base_price,
      free_km,
      per_km_price,
      night_charge,
      night_type,
      metadata
    ) VALUES ${placeholders}`,
    params
  );

  return normalizedEntries;
}

export async function replaceTechnicianFleetVehicles(connectionOrPool, technicianId, entries) {
  const normalizedTechnicianId = toTechnicianId(technicianId);
  if (!normalizedTechnicianId) {
    throw new Error("technician_id is invalid.");
  }

  await connectionOrPool.execute("DELETE FROM technician_fleet_vehicles WHERE technician_id = ?", [normalizedTechnicianId]);

  const fleetsToInsert = new Set();
  
  // Custom simple parser since normalizeTechnicianPricingEntries flattens it out
  const parseJson = (value, fallback) => {
    if (typeof value === "string") {
      try { return JSON.parse(value); } catch { return fallback; }
    }
    return value || fallback;
  };
  
  const parsed = parseJson(entries, []);
  const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? Object.values(parsed) : []);

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.towing_fleet_types)) {
      for (const type of entry.towing_fleet_types) {
        if (type && typeof type === "string") fleetsToInsert.add(type.trim());
      }
    }
  }

  if (fleetsToInsert.size > 0) {
    const placeholders = Array.from(fleetsToInsert).map(() => "(?, ?, ?, ?)").join(", ");
    const params = Array.from(fleetsToInsert).flatMap((type) => [
      normalizedTechnicianId,
      type,
      "TBD",
      "available"
    ]);

    await connectionOrPool.execute(
      `INSERT INTO technician_fleet_vehicles (technician_id, vehicle_type, vehicle_number, status) VALUES ${placeholders}`,
      params
    );
  }
}
