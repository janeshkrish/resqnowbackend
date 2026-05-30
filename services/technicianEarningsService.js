import { calculateFinalPrice } from "./pricing.service.js";
import { getPlatformPricingConfig, getServiceMatrixAmount, normalizeTowingPricingRules } from "./platformPricing.js";
import { estimateTechnicianPayoutAsync } from "./pricingEstimator.js";
import { canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { fetchTechnicianPricingDefinition } from "./technicianPricingStore.js";
import { isTowingServiceType } from "./towingServiceType.js";
import { roundMoney } from "../utils/money.js";

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
      return {
        source: "technician",
        service_type: definition.service_type,
        vehicle_type: definition.vehicle_type,
        technician_pricing: {
          ...definition.technician_pricing,
          base_price: toPositiveMoney(definition.technician_pricing.base_price) ?? getServiceMatrixAmount("towing", resolveVehicleType(request), pricingConfig),
          free_km: Number(definition.technician_pricing.free_km ?? rules.base_includes_km ?? 0),
          per_km_price: toPositiveMoney(definition.technician_pricing.per_km_price) ?? rules.per_km_price,
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

export async function estimateTechnicianEarningForRequest({
  request,
  technician = null,
  technicianId = null,
  connection = null,
}) {
  const normalizedTechnicianId = toTechnicianId(technicianId ?? technician?.id ?? technician?.technician_id ?? request?.technician_id);
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

  const payout = await estimateTechnicianPayoutAsync(
    { service_type: request?.service_type, vehicle_type: request?.vehicle_type },
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
