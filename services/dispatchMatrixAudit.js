import * as db from "../db.js";
import { jobDispatchService } from "./jobDispatchService.js";
import {
  canonicalizeServiceDomain,
  canonicalizeVehicleFamily,
  parseVehicleTypes,
  serviceDomainsFromCosts,
} from "./serviceNormalization.js";

export const DEFAULT_AUDIT_SERVICE_DOMAINS = [
  "towing",
  "flat-tire",
  "battery",
  "mechanical",
  "fuel",
  "lockout",
  "winching",
  "ev-charging",
];

export const DEFAULT_AUDIT_VEHICLE_TYPES = ["bike", "car", "commercial", "ev"];

const FALLBACK_AUDIT_LOCATION = { lat: 11.0168, lng: 76.9558 }; // Coimbatore

const safeParse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};

const hasValidCoords = (tech) =>
  Number.isFinite(Number(tech?.latitude)) && Number.isFinite(Number(tech?.longitude));

const toBool = (value) => value === true || value === 1 || value === "1";

function normalizeReasons(reasonCounts) {
  return Object.entries(reasonCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

function getTechnicianDomains(tech) {
  const rawSpecialties = safeParse(tech?.specialties);
  const rawServiceCosts = safeParse(tech?.service_costs);
  const specialtyDomains = Array.isArray(rawSpecialties) ? rawSpecialties : [];
  const costDomains = serviceDomainsFromCosts(rawServiceCosts);
  const out = [tech?.service_type, ...specialtyDomains, ...costDomains]
    .map((value) => canonicalizeServiceDomain(value))
    .filter(Boolean);
  return [...new Set(out)];
}

function getTechnicianVehicleFamilies(tech) {
  const out = parseVehicleTypes(tech?.vehicle_types)
    .map((value) => canonicalizeVehicleFamily(value))
    .filter(Boolean);
  return [...new Set(out)];
}

function supportsCombo(tech, serviceDomain, vehicleType) {
  const domains = getTechnicianDomains(tech);
  const vehicles = getTechnicianVehicleFamilies(tech);
  return domains.includes(serviceDomain) && vehicles.includes(vehicleType);
}

function chooseProbeLocation(technicians, comboTechnicians) {
  const comboWithCoords = (comboTechnicians || []).find(hasValidCoords);
  if (comboWithCoords) {
    return {
      lat: Number(comboWithCoords.latitude),
      lng: Number(comboWithCoords.longitude),
      source: "combo_technician",
    };
  }

  const anyWithCoords = (technicians || []).find(hasValidCoords);
  if (anyWithCoords) {
    return {
      lat: Number(anyWithCoords.latitude),
      lng: Number(anyWithCoords.longitude),
      source: "any_technician",
    };
  }

  return { ...FALLBACK_AUDIT_LOCATION, source: "fallback_default" };
}

function buildProbeLocations(technicians, comboTechs, readyTechsWithCoords) {
  const probes = [];
  const seen = new Set();

  (readyTechsWithCoords || []).slice(0, 5).forEach((tech) => {
    const lat = Number(tech.latitude);
    const lng = Number(tech.longitude);
    const key = `${lat.toFixed(6)}|${lng.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    probes.push({ lat, lng, source: `ready_technician_${tech.id}` });
  });

  if (probes.length > 0) return probes;

  const fallbackProbe = chooseProbeLocation(technicians, comboTechs);
  return [fallbackProbe];
}

function buildTechnicianPoolSummary(technicians) {
  const total = technicians.length;
  const approved = technicians.filter((t) => String(t.status || "").toLowerCase() === "approved").length;
  const active = technicians.filter((t) => toBool(t.is_active)).length;
  const available = technicians.filter((t) => toBool(t.is_available)).length;
  const approvedActiveAvailable = technicians.filter(
    (t) =>
      String(t.status || "").toLowerCase() === "approved" &&
      toBool(t.is_active) &&
      toBool(t.is_available)
  ).length;
  const withValidCoords = technicians.filter(hasValidCoords).length;
  const missingVehicleProfile = technicians.filter((t) => getTechnicianVehicleFamilies(t).length === 0).length;
  const missingServiceProfile = technicians.filter((t) => getTechnicianDomains(t).length === 0).length;

  return {
    total,
    approved,
    active,
    available,
    approved_active_available: approvedActiveAvailable,
    with_valid_coords: withValidCoords,
    missing_vehicle_profile: missingVehicleProfile,
    missing_service_profile: missingServiceProfile,
  };
}

function maybeSimulateAvailability(technicians, serviceDomain, vehicleType, location, simulateReady) {
  if (!simulateReady) return technicians;
  return technicians.map((tech) => {
    if (!supportsCombo(tech, serviceDomain, vehicleType)) return tech;
    return {
      ...tech,
      status: "approved",
      is_active: 1,
      is_available: 1,
      latitude: hasValidCoords(tech) ? tech.latitude : location.lat,
      longitude: hasValidCoords(tech) ? tech.longitude : location.lng,
    };
  });
}

export async function runDispatchMatrixAudit(options = {}) {
  const {
    pool: poolOverride,
    serviceDomains = DEFAULT_AUDIT_SERVICE_DOMAINS,
    vehicleTypes = DEFAULT_AUDIT_VEHICLE_TYPES,
    simulateReady = false,
  } = options;

  const normalizedDomains = [...new Set((serviceDomains || []).map((s) => canonicalizeServiceDomain(s)).filter(Boolean))];
  const normalizedVehicleTypes = [
    ...new Set((vehicleTypes || []).map((v) => canonicalizeVehicleFamily(v)).filter(Boolean)),
  ];

  const pool = poolOverride || (await db.getPool());
  const [rows] = await pool.query("SELECT * FROM technicians");
  const technicians = rows || [];

  const matrix = [];
  const statusCounts = {
    PASS: 0,
    NO_CONFIGURED_TECHNICIAN: 0,
    CONFIGURED_BUT_NOT_DISPATCHABLE: 0,
  };

  for (const serviceDomain of normalizedDomains) {
    for (const vehicleType of normalizedVehicleTypes) {
      const configuredTechs = technicians.filter((tech) => supportsCombo(tech, serviceDomain, vehicleType));
      const configuredCount = configuredTechs.length;
      const readyTechsWithCoords = configuredTechs.filter(
        (tech) =>
          String(tech.status || "").toLowerCase() === "approved" &&
          toBool(tech.is_active) &&
          toBool(tech.is_available) &&
          hasValidCoords(tech)
      );
      const readyCount = readyTechsWithCoords.length;

      const probeLocations = buildProbeLocations(technicians, configuredTechs, readyTechsWithCoords);
      let bestEligibleNow = -1;
      let bestCriteria = null;
      let bestReasonCounts = {};
      let bestLocation = probeLocations[0];

      probeLocations.forEach((location, index) => {
        const candidatePool = maybeSimulateAvailability(
          technicians,
          serviceDomain,
          vehicleType,
          location,
          simulateReady
        );

        const probeRequest = {
          id: `matrix-${serviceDomain}-${vehicleType}-${index + 1}`,
          service_type: serviceDomain,
          vehicle_type: vehicleType,
          location_lat: location.lat,
          location_lng: location.lng,
        };

        const { criteria, analysis, reasonCounts } = jobDispatchService.analyzeTechnicians(
          probeRequest,
          candidatePool,
          null
        );

        const eligibleNow = analysis.filter((entry) => entry.eligible).length;
        if (eligibleNow > bestEligibleNow) {
          bestEligibleNow = eligibleNow;
          bestCriteria = criteria;
          bestReasonCounts = reasonCounts;
          bestLocation = location;
        }
      });

      const eligibleNow = Math.max(0, bestEligibleNow);
      const status =
        configuredCount === 0
          ? "NO_CONFIGURED_TECHNICIAN"
          : eligibleNow > 0
          ? "PASS"
          : "CONFIGURED_BUT_NOT_DISPATCHABLE";

      statusCounts[status] += 1;

      matrix.push({
        service_domain: serviceDomain,
        vehicle_type: vehicleType,
        status,
        configured_technicians: configuredCount,
        ready_technicians: readyCount,
        eligible_technicians_now: eligibleNow,
        probe_location: { lat: bestLocation.lat, lng: bestLocation.lng, source: bestLocation.source },
        criteria: bestCriteria,
        rejection_reasons: normalizeReasons(bestReasonCounts),
      });
    }
  }

  const totalCombinations = normalizedDomains.length * normalizedVehicleTypes.length;
  const missingCoverage = matrix.filter((row) => row.status !== "PASS");

  return {
    generated_at: new Date().toISOString(),
    options: { simulate_ready: !!simulateReady },
    dimensions: {
      service_domains: normalizedDomains,
      vehicle_types: normalizedVehicleTypes,
      total_combinations: totalCombinations,
    },
    technician_pool: buildTechnicianPoolSummary(technicians),
    summary: {
      pass_count: statusCounts.PASS,
      missing_count: totalCombinations - statusCounts.PASS,
      no_configured_count: statusCounts.NO_CONFIGURED_TECHNICIAN,
      configured_but_not_dispatchable_count: statusCounts.CONFIGURED_BUT_NOT_DISPATCHABLE,
    },
    matrix,
    missing_coverage: missingCoverage,
  };
}
