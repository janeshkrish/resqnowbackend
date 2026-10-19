import { recordId } from "../models/identifiers.js";
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
import { normalizeFleetTowTruckType, requiredTowTruckType } from "./towTruckCapability.js";
import { getVehicleServicePolicy, pricingSubtypeContext, chargingCompatibility, hasSubtypeTariff, applyStandardPricingSubtype } from "./vehicleServiceCompatibility.js";

const toPositiveMoney = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundMoney(parsed) : null;
};

const toPositiveDistance = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const toTechnicianId = (value) => {
  return recordId(value);
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
    getVehicleServicePolicy(request).family ||
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

async function loadRegisteredServicePricingRow({ technicianId, domain, vehicle, technician = null, connection, request = null }) {
  const executor = connection || await getPool();
  const policy = request ? getVehicleServicePolicy(request) : null;
  if (policy?.invalidCode) return null;
  const candidates = policy?.pricingCandidates ?? [{ vehicle_type: vehicle, vehicle_subtype: request?.vehicle_subtype }];
  let entries = null;
  const profileEntries = async () => {
    if (entries) return entries;
    let profile = technician;
    if (!profile?.service_costs) {
      const [profiles] = await executor.query("SELECT service_costs FROM technicians WHERE id = ? LIMIT 1", [technicianId]);
      profile = profiles?.[0];
    }
    entries = normalizeTechnicianPricingEntries(profile?.service_costs, { preserveInvalid: true });
    return entries;
  };
  for (const candidate of candidates) {
    const [rows] = await executor.query(`SELECT * FROM technician_services
    WHERE technician_id = ? AND service_domain = ? AND (vehicle_type = ? OR vehicle_type = '')
    ORDER BY CASE WHEN vehicle_type = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`,
      [technicianId, domain, candidate.vehicle_type, candidate.vehicle_type]);
    const stored = Array.isArray(rows) ? rows[0] : null;
    if (stored && !(policy?.family === 'ev' && candidate.vehicle_type === 'ev' && !stored.vehicle_type) &&
        pricingSubtypeContext(stored, candidate, policy?.family === 'ev').eligible) {
      return { ...stored, _pricing_vehicle_type: candidate.vehicle_type,
        _pricing_vehicle_subtype: candidate.vehicle_subtype, _pricing_base_subtype: candidate.vehicle_base_subtype,
        _shared_ev_service: Boolean(candidate.shared) };
    }
    const legacy = await profileEntries();
    const entry = legacy.find(item => item.service_domain === domain && item.vehicle_type === candidate.vehicle_type &&
        pricingSubtypeContext(item, candidate, policy?.family === 'ev').eligible)
      ?? (!(policy?.family === 'ev' && candidate.vehicle_type === 'ev')
        ? legacy.find(item => item.service_domain === domain && !item.vehicle_type &&
          pricingSubtypeContext(item, candidate, policy?.family === 'ev').eligible) : null);
    if (entry) return { ...entry, _pricing_vehicle_type: candidate.vehicle_type,
      _pricing_vehicle_subtype: candidate.vehicle_subtype, _pricing_base_subtype: candidate.vehicle_base_subtype,
      _shared_ev_service: Boolean(candidate.shared) };
  }
  return null;
}

async function estimateRegisteredTowingEarning({ request, technicianId, connection }) {
  const distance = toPositiveDistance(request.route_distance_km ?? request.routeDistanceKm);
  if (!distance || !technicianId) return null;
  const vehicleType = resolveVehicleType(request);
  const row = await loadRegisteredServicePricingRow({ technicianId, domain: "towing", vehicle: vehicleType, connection, request });
  if (!row || row._invalid_pricing) return null;
  const context = pricingSubtypeContext(row, { vehicle_subtype: row._pricing_vehicle_subtype,
    vehicle_base_subtype: row._pricing_base_subtype }, getVehicleServicePolicy(request).family === 'ev');
  const tier = context.subcategory;
  const selectedRow = tier ? { ...row, ...tier,
    base_price: tier.base_price ?? tier.base_charge,
    free_km: tier.free_km ?? tier.free_distance,
    per_km_price: tier.per_km_price ?? tier.per_km_charge,
    extra_km_charge: tier.per_km_price ?? tier.per_km_charge,
    service_charge: tier.base_price ?? tier.base_charge,
    metadata: { ...context.metadata, ...tier } } : row;
  const registered = mapStoredPricingRowToTechnicianPricing(selectedRow, "towing");
  if (tier) {
    // Legacy metadata can contain parent minimums as well as SQL columns.
    // Missing fields on an explicitly selected tier must remain missing.
    registered.base_price = tier.base_price ?? tier.base_charge ?? null;
    registered.free_km = tier.free_km ?? tier.free_distance ?? null;
    registered.per_km_price = tier.per_km_price ?? tier.per_km_charge ?? null;
  }
  let metadata = parseObject(selectedRow.metadata);
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
    breakdown: { pricing_vehicle_type: row._pricing_vehicle_type, pricing_vehicle_subtype: context.key || row._pricing_vehicle_subtype,
      shared_ev_service: row._shared_ev_service,
      distance_km: distance, base_price: engine.base_price, included_km: price.free_km,
      per_km_rate: price.per_km_price, distance_charge: engine.distance_charge, night_charge: engine.night_charge,
      subtotal: engine.subtotal, tow_truck_type: requiredType } };
}

async function estimateRegisteredStandardEarning({ request, technician, technicianId, connection }) {
  if (!technicianId) return null;
  const vehicle = resolveVehicleType(request);
  const domain = canonicalizeServiceDomain(String(request.service_type ?? request.serviceType ?? "").replace(/^(car|bike|ev|commercial)-/i, ""));
  if (!domain || !vehicle) return null;
  const policy = getVehicleServicePolicy(request);
  if (policy.invalidCode) return null;
  const row = await loadRegisteredServicePricingRow({ technicianId, domain, vehicle, technician, connection, request });
  if (!row || row._invalid_pricing) return null;
  const subtype = row._pricing_vehicle_subtype ?? request.vehicle_subtype ?? request.vehicleSubtype;
  const context = pricingSubtypeContext(row, { vehicle_subtype: subtype, vehicle_base_subtype: row._pricing_base_subtype }, policy.family === 'ev');
  const { metadata, key: selectedSubtype, subcategory, hasSubcategories } = context;
  if ((subtype || policy.family === 'ev') && hasSubcategories && !subcategory) return null;
  if (!hasSubtypeTariff(context)) return null;
  if (!chargingCompatibility(request, { metadata: hasSubcategories ? subcategory : metadata }).eligible) return null;
  const selected = applyStandardPricingSubtype(row, context);
  for (const field of ["visit_charge", "service_charge", "delivery_charge", "labour_min", "price_2w_min", "price_2w_max",
    "price_4w_min", "price_4w_max", "tube_tyre_price", "tubeless_price"]) {
    if (selected[field] != null && nonNegativeNumber(selected[field]) == null) return null;
  }
  const details = readRequestDetails(request.request_details_json ?? request.requestDetails);
  const pricingVehicle = row._pricing_vehicle_type || vehicle;
  const amount = calculateTechnicianServiceRowPayout(selected, pricingVehicle, { vehicleSubtype: selectedSubtype || subtype,
    tyreType: answerValue(details, "tyretype") });
  if (amount == null || amount <= 0) return null;
  return { amount, currency: "INR", source: "technician_pricing", breakdown: {
    service_type: domain, vehicle_type: vehicle, vehicle_subtype: request.vehicle_subtype ?? request.vehicleSubtype ?? null,
    pricing_vehicle_type: pricingVehicle, pricing_vehicle_subtype: selectedSubtype || subtype || null,
    shared_ev_service: row._shared_ev_service,
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
