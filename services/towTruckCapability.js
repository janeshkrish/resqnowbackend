import { canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { isTowingServiceType } from "./towingServiceType.js";
import { answerValue, readRequestDetails } from "./requestDetails.js";
import { defaultTowTruckType, normalizeTowTruckType, normalizeVehicleSubtype } from "./vehicleClasses.js";

export function normalizeFleetTowTruckType(value) {
  // The fleet editor calls a heavy-duty wrecker "heavy-duty".
  const normalized = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  return normalizeTowTruckType(normalized === "heavy-duty" ? "heavy-duty-wrecker" : normalized);
}

export function requiredTowTruckType(request) {
  if (!isTowingServiceType(request?.service_type)) return null;
  const explicit = request.tow_truck_type ?? request.towTruckType;
  if (explicit != null && String(explicit).trim()) return normalizeTowTruckType(explicit) || "";
  // Older requests use the same conservative defaults as request creation.
  const family = canonicalizeVehicleFamily(request.vehicle_type || String(request.service_type).split("-")[0]);
  const subtype = normalizeVehicleSubtype(family, request.vehicle_subtype);
  const details = readRequestDetails(request.request_details_json);
  return defaultTowTruckType({ family, subtype, canRoll: answerValue(details, "roll") });
}

export function evaluateTowTruckCapability(requiredType, fleetVehicles = []) {
  if (requiredType === null) return { code: null };
  if (!requiredType) return { code: "invalid_tow_truck_type", reason: "The required tow-truck type is invalid." };
  const trucks = (Array.isArray(fleetVehicles) ? fleetVehicles : [])
    .map(vehicle => ({ type: normalizeFleetTowTruckType(vehicle.vehicle_type), status: String(vehicle.status || "").trim().toLowerCase() }))
    .filter(vehicle => vehicle.type);
  if (!trucks.length) return { code: "tow_truck_profile_missing", reason: "Register suitable towing equipment before accepting this job." };
  const matching = trucks.filter(vehicle => vehicle.type === requiredType);
  if (!matching.length) return { code: "tow_truck_mismatch", reason: `This job requires a ${requiredType} tow truck. Your fleet does not have that truck type.` };
  if (!matching.some(vehicle => vehicle.status === "available")) {
    return { code: "tow_truck_unavailable", reason: `Your ${requiredType} tow truck is currently unavailable.` };
  }
  return { code: null };
}

export async function loadTechnicianFleetVehicles(executor, technicians) {
  if (!technicians.length) return technicians;
  const [fleetRows] = await executor.query(
    `SELECT technician_id, vehicle_type, status FROM technician_fleet_vehicles
     WHERE technician_id IN (${technicians.map(() => "?").join(",")})`,
    technicians.map(tech => tech.id)
  );
  const byTechnician = new Map();
  for (const vehicle of fleetRows) {
    const id = String(vehicle.technician_id);
    if (!byTechnician.has(id)) byTechnician.set(id, []);
    byTechnician.get(id).push(vehicle);
  }
  return technicians.map(tech => ({ ...tech, fleet_vehicles: byTechnician.get(String(tech.id)) || [] }));
}
