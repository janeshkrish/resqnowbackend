import { calculateFinalPrice } from "./pricing.service.js";
import { getPlatformPricingConfig, getServiceMatrixAmount, normalizeTowingPricingRules } from "./platformPricing.js";
import { calculateTechnicianServiceRowPayout, estimateTechnicianPayoutAsync } from "./pricingEstimator.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { fetchTechnicianPricingDefinition } from "./technicianPricingStore.js";
import { isTowingServiceType } from "./towingServiceType.js";
import { fleetPricingFor } from "./towingQuoteService.js";
import { answerValue, readRequestDetails } from "./requestDetails.js";
import { roundMoney } from "../utils/money.js";
import { getPool } from "../db.js";
import { mapStoredPricingRowToTechnicianPricing, normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";
import { pricingSubcategoryFor } from "./vehicleClasses.js";
import { normalizeFleetTowTruckType, requiredTowTruckType } from "./towTruckCapability.js";

const toPositiveMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundMoney(parsed) : null;
};

const toPositiveDistance = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const toTechnicianId = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

function toIsoTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function resolveVehicleType(request = {}) {
  return (
    canonicalizeVehicleFamily(request.vehicle_type || request.vehicleType) ||
    canonicalizeVehicleFamily(String(request.service_type || request.serviceType || "").split("-")[0]) ||
    "car"
  );
}

async function resolveTowingPricingDefinition({ request, technicianId, connection, pricingConfig, rules }) {
  try {
    const definition = await fetchTechnicianPricingDefinition({
      technicianId,
      serviceType: "towing",
      vehicleType: resolveVehicleType(request),
      connection,
    });
    if (definition?.technician_pricing) {
      // The technician's price for the truck this job needs, when they set one.
      const fleet = fleetPricingFor(definition.technician_pricing, request?.tow_truck_type ?? request?.towTruckType);
      return {
        source: fleet ? "technician_fleet" : "technician",
        service_type: definition.service_type,
        vehicle_type: definition.vehicle_type,
        technician_pricing: {
          ...definition.technician_pricing,
          base_price: fleet?.base_price ?? toPositiveMoney(definition.technician_pricing.base_price) ?? getServiceMatrixAmount("towing", resolveVehicleType(request), pricingConfig),
          free_km: Number(fleet?.free_km ?? definition.technician_pricing.free_km ?? rules.base_includes_km ?? 0),
          per_km_price: fleet?.per_km_price ?? toPositiveMoney(definition.technician_pricing.per_km_price) ?? rules.per_km_price,
          night_charge: Number(definition.technician_pricing.night_charge ?? rules.night_charge ?? 0),
          night_type: definition.technician_pricing.night_type || rules.night_type || "flat",
        },
      };
    }
  } catch (error) {
    console.warn("[Technician Earnings] towing pricing lookup failed:", error?.message || error);
  }

  const vehicleType = resolveVehicleType(request);
  return {
    source: "platform",
    service_type: "towing",
    vehicle_type: vehicleType,
    technician_pricing: {
      base_price: getServiceMatrixAmount(request.service_type || "towing", vehicleType, pricingConfig),
      free_km: rules.base_includes_km,
      per_km_price: rules.per_km_price,
      night_charge: rules.night_charge,
      night_type: rules.night_type || "flat",
    },
  };
}

async function estimateTowingEarning({ request, technicianId, connection }) {
  const distanceKm = toPositiveDistance(request.route_distance_km ?? request.routeDistanceKm);
  if (!distanceKm) {
    return null;
  }

  const pricingConfig = await getPlatformPricingConfig();
  const rules = normalizeTowingPricingRules(pricingConfig.towing_pricing_rules);
  const pricingDefinition = await resolveTowingPricingDefinition({
    request,
    technicianId,
    connection,
    pricingConfig,
    rules,
  });

  const engineResult = calculateFinalPrice(
    {
      service_type: pricingDefinition.service_type,
      vehicle_type: pricingDefinition.vehicle_type,
      technician_pricing: pricingDefinition.technician_pricing,
      distance_km: distanceKm,
      time_of_day: toIsoTimestamp(request.scheduled_time || request.created_at),
    },
    {
      platform_fee_percent: pricingConfig.platform_fee_percent,
      payment_fee_percent: pricingConfig.payment_fee_percent,
      customer_price_rounding_increment: pricingConfig.customer_price_rounding_increment,
    }
  );

  return {
    amount: roundMoney(engineResult.subtotal),
    currency: pricingConfig.currency || "INR",
    source: pricingDefinition.source,
    breakdown: {
      distance_km: distanceKm,
      base_price: engineResult.base_price,
      distance_charge: engineResult.distance_charge,
      night_charge: engineResult.night_charge,
      subtotal: engineResult.subtotal,
      pricing_source: pricingDefinition.source,
    },
  };
}

const parseObject = (value) => {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
};
const nonNegativeNumber = (value) => {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

async function loadRegisteredServicePricingRow({ technicianId, domain, vehicle, technician = null, connection }) {
  const executor = connection || await getPool();
  const [rows] = await executor.query(`SELECT * FROM technician_services
    WHERE technician_id = ? AND service_domain = ? AND (vehicle_type = ? OR vehicle_type = '')
    ORDER BY CASE WHEN vehicle_type = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
  [technicianId, domain, vehicle, vehicle]);
  const stored = Array.isArray(rows) ? rows[0] : null;
  if (stored) return stored;
  let profile = technician;
  if (!profile?.service_costs) {
    const [profiles] = await executor.query("SELECT service_costs FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
    profile = profiles?.[0];
  }
  return normalizeTechnicianPricingEntries(profile?.service_costs)
    .find((entry) => entry.service_domain === domain && (!entry.vehicle_type || entry.vehicle_type === vehicle)) ?? null;
}

async function estimateRegisteredTowingEarning({ request, technicianId, connection }) {
  const distance = toPositiveDistance(request.route_distance_km ?? request.routeDistanceKm);
  if (!distance || !technicianId) return null;
  const vehicleType = resolveVehicleType(request);
  const row = await loadRegisteredServicePricingRow({ technicianId, domain: "towing", vehicle: vehicleType, connection });
  if (!row) return null;
  const registered = mapStoredPricingRowToTechnicianPricing(row, "towing");
  let metadata = parseObject(row.metadata);
  const seen = new Set();
  while (metadata && typeof metadata === "object" && !seen.has(metadata)) {
    seen.add(metadata);
    if (metadata.fleet_pricing && typeof metadata.fleet_pricing === "object") {
      registered.fleet_pricing = metadata.fleet_pricing;
      break;
    }
    metadata = parseObject(metadata.metadata);
  }
  const requiredType = requiredTowTruckType({ ...request, service_type: request.service_type ?? request.serviceType });
  if (!requiredType) return null;
  const fleet = registered.fleet_pricing;
  const entry = fleet && typeof fleet === "object"
    ? Object.entries(fleet).find(([type]) => normalizeFleetTowTruckType(type) === requiredType)?.[1] : null;
  const price = entry ? {
    base_price: nonNegativeNumber(entry.base_charge ?? entry.base_price),
    free_km: nonNegativeNumber(entry.free_distance ?? entry.free_km),
    per_km_price: nonNegativeNumber(entry.per_km_charge ?? entry.per_km_price),
  } : { base_price: nonNegativeNumber(registered.base_price), free_km: nonNegativeNumber(registered.free_km),
    per_km_price: nonNegativeNumber(registered.per_km_price) };
  if (price.base_price == null || price.base_price <= 0 || price.free_km == null || price.per_km_price == null) return null;
  const nightCharge = nonNegativeNumber(registered.night_charge ?? 0);
  if (nightCharge == null) return null;
  const engine = calculateFinalPrice({ service_type: "towing", vehicle_type: vehicleType,
    technician_pricing: { ...price, night_charge: nightCharge, night_type: registered.night_type || "flat" },
    distance_km: distance, time_of_day: toIsoTimestamp(request.scheduled_time || request.created_at),
  });
  return { amount: roundMoney(engine.subtotal), currency: "INR", source: entry ? "technician_fleet" : "technician",
    breakdown: { distance_km: distance, base_price: engine.base_price, included_km: price.free_km,
      per_km_rate: price.per_km_price, distance_charge: engine.distance_charge, night_charge: engine.night_charge,
      subtotal: engine.subtotal, tow_truck_type: requiredType } };
}

async function estimateRegisteredStandardEarning({ request, technician, technicianId, connection }) {
  if (!technicianId) return null;
  const vehicle = resolveVehicleType(request);
  const domain = canonicalizeServiceDomain(String(request.service_type ?? request.serviceType ?? "").replace(/^(car|bike|ev|commercial)-/i, ""));
  if (!domain || !vehicle) return null;
  const row = await loadRegisteredServicePricingRow({ technicianId, domain, vehicle, technician, connection });
  if (!row) return null;
  let metadata = parseObject(row.metadata) || {};
  const seen = new Set();
  while (metadata && typeof metadata === "object" && !seen.has(metadata) && !metadata.subcategories && metadata.metadata) {
    seen.add(metadata); metadata = parseObject(metadata.metadata) || metadata;
  }
  const subtype = request.vehicle_subtype ?? request.vehicleSubtype;
  const subcategory = metadata.subcategories?.[subtype] ?? metadata.subcategories?.[pricingSubcategoryFor(subtype)];
  if (subtype && metadata.subcategories && Object.keys(metadata.subcategories).length && !subcategory) return null;
  const selected = { ...row, ...(subcategory || {}), metadata };
  for (const field of ["visit_charge", "service_charge", "delivery_charge", "labour_min", "price_2w_min", "price_2w_max",
    "price_4w_min", "price_4w_max", "tube_tyre_price", "tubeless_price"]) {
    if (selected[field] != null && nonNegativeNumber(selected[field]) == null) return null;
  }
  const details = readRequestDetails(request.request_details_json ?? request.requestDetails);
  const amount = calculateTechnicianServiceRowPayout(selected, vehicle, { vehicleSubtype: subtype,
    tyreType: answerValue(details, "tyretype") });
  if (amount == null || amount <= 0) return null;
  return { amount, currency: "INR", source: "technician_pricing", breakdown: {
    service_type: domain, vehicle_type: vehicle, vehicle_subtype: subtype ?? null,
    visit_charge: nonNegativeNumber(selected.visit_charge) ?? 0,
    delivery_charge: nonNegativeNumber(selected.delivery_charge) ?? 0,
    subtotal: amount,
  } };
}

export async function estimateTechnicianEarningForRequest({
  request,
  technician = null,
  technicianId = null,
  connection = null,
  requireRegisteredPricing = false,
}) {
  const normalizedTechnicianId = toTechnicianId(technicianId ?? technician?.id ?? technician?.technician_id ?? request?.technician_id);
  if (requireRegisteredPricing) {
    return isTowingServiceType(request?.service_type ?? request?.serviceType)
      ? estimateRegisteredTowingEarning({ request, technicianId: normalizedTechnicianId, connection })
      : estimateRegisteredStandardEarning({ request, technician, technicianId: normalizedTechnicianId, connection });
  }
  const assignedTechnicianId = toTechnicianId(request?.technician_id ?? request?.technicianId);
  const stored = toPositiveMoney(request?.technician_estimated_earning ?? request?.technicianEstimatedEarning);
  const storedBelongsToRequestedTechnician =
    stored != null &&
    (!normalizedTechnicianId || (assignedTechnicianId != null && normalizedTechnicianId === assignedTechnicianId));
  if (storedBelongsToRequestedTechnician) {
    return {
      amount: stored,
      currency: "INR",
      source: "stored",
      breakdown: null,
    };
  }

  if (isTowingServiceType(request?.service_type || request?.serviceType)) {
    if (normalizedTechnicianId) {
      const towing = await estimateTowingEarning({
        request,
        technicianId: normalizedTechnicianId,
        connection,
      });
      if (towing?.amount != null) return towing;
    }

    const amount = toPositiveMoney(request?.amount ?? request?.service_charge);
    return amount == null
      ? null
      : {
          amount,
          currency: "INR",
          source: "request_amount",
          breakdown: null,
        };
  }

  const details = readRequestDetails(request?.request_details_json ?? request?.requestDetails);
  const payout = await estimateTechnicianPayoutAsync(
    {
      service_type: request?.service_type,
      vehicle_type: request?.vehicle_type,
      vehicle_subtype: request?.vehicle_subtype ?? request?.vehicleSubtype ?? null,
      tyre_type: answerValue(details, "tyretype"),
    },
    technician,
    { technicianId: normalizedTechnicianId }
  );
  const amount = toPositiveMoney(payout ?? request?.amount ?? request?.service_charge);
  return amount == null
    ? null
    : {
        amount,
        currency: "INR",
        source: payout != null ? "technician_pricing" : "request_amount",
        breakdown: null,
      };
}
