import axios from "axios";
import { getPool } from "../db.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { calculateFinalPrice } from "./pricing.service.js";
import {
  getPlatformPricingConfig,
  getServiceMatrixAmount,
  normalizeTowingPricingRules,
} from "./platformPricing.js";
import { fetchTechnicianPricingDefinition } from "./technicianPricingStore.js";
import { computeServiceRequestPaymentAmounts } from "./serviceRequestPaymentService.js";
import { roundMoney } from "../utils/money.js";

const GOOGLE_DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const OSRM_ROUTE_URL = "https://router.project-osrm.org/route/v1/driving";
const ROUTE_TIMEOUT_MS = Math.max(2500, Number(process.env.TOWING_ROUTE_TIMEOUT_MS || 6500));
const MAX_DISTANCE_TAMPER_RATIO = 0.15;
const MAX_DISTANCE_TAMPER_KM = 2;
const DEFAULT_TIME_OF_DAY = () => new Date().toTimeString().slice(0, 5);

class TowingQuoteError extends Error {
  constructor(message, statusCode = 400, code = "towing_quote_error") {
    super(message);
    this.name = "TowingQuoteError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const toFiniteNumber = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toPositiveMoney = (value) => {
  const parsed = toFiniteNumber(value);
  return parsed != null && parsed > 0 ? roundMoney(parsed) : null;
};

const clampMultiplier = (value, fallback = 1) => {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.max(0.1, Math.min(5, parsed));
};

const normalizeAddress = (value, label) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 5) {
    throw new TowingQuoteError(`${label} address is required.`);
  }
  if (normalized.length > 512) {
    throw new TowingQuoteError(`${label} address is too long.`);
  }
  return normalized;
};

const normalizeCoordinate = (value, label, min, max) => {
  const parsed = toFiniteNumber(value);
  if (parsed == null || parsed < min || parsed > max) {
    throw new TowingQuoteError(`${label} is invalid.`);
  }
  return Number(parsed.toFixed(8));
};

function normalizeLocation({ address, lat, lng }, label) {
  return {
    address: normalizeAddress(address, label),
    lat: normalizeCoordinate(lat, `${label} latitude`, -90, 90),
    lng: normalizeCoordinate(lng, `${label} longitude`, -180, 180),
  };
}

function haversineKm(a, b) {
  const toRad = (degree) => degree * (Math.PI / 180);
  const radiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function normalizeVehicleCategory({ vehicleType, vehicleModel, vehicleSubtype }) {
  const text = `${vehicleType || ""} ${vehicleModel || ""} ${vehicleSubtype || ""}`.toLowerCase();
  if (/\bscooter\b|scooty/.test(text)) return "scooter";
  if (/\bbike\b|\bmotorcycle\b|\btwo\s*wheeler\b|2w/.test(text)) return "bike";
  if (/\bluxury\b|\bpremium\b|\bbmw\b|\bmercedes\b|\baudi\b|\bjaguar\b|\bvolvo\b|\blexus\b/.test(text)) return "luxury_car";
  if (/\bsuv\b|\bscorpio\b|\bfortuner\b|\bxuv\b|\bthar\b|\bcreta\b|\bseltos\b/.test(text)) return "suv";
  if (/\bsedan\b|\bcity\b|\bverna\b|\bciaz\b|\bslavia\b|\bvirtus\b/.test(text)) return "sedan";
  if (/\bhatch\b|\bhatchback\b|\bswift\b|\balto\b|\bi10\b|\bi20\b|\bbaleno\b/.test(text)) return "hatchback";
  if (/\btruck\b|\blorry\b|\bbus\b|\btempo\b|\bcommercial\b|\bheavy\b/.test(text)) return "truck";
  if (/\bev\b|\belectric\b|\bnexon ev\b|\btata tiago ev\b/.test(text)) return "ev";

  const canonical = canonicalizeVehicleFamily(vehicleType);
  if (canonical === "commercial") return "truck";
  return canonical || "car";
}

export function isTowingServiceType(serviceType) {
  return canonicalizeServiceDomain(String(serviceType || "").replace(/^(car|bike|ev|commercial)-/i, "")) === "towing";
}

async function resolveRouteWithGoogle(pickup, drop) {
  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || process.env.GMAPS_API_KEY || "").trim();
  if (!apiKey) return null;

  const response = await axios.get(GOOGLE_DIRECTIONS_URL, {
    timeout: ROUTE_TIMEOUT_MS,
    params: {
      origin: `${pickup.lat},${pickup.lng}`,
      destination: `${drop.lat},${drop.lng}`,
      mode: "driving",
      departure_time: "now",
      traffic_model: "best_guess",
      key: apiKey,
    },
  });

  const data = response.data || {};
  if (data.status !== "OK" || !Array.isArray(data.routes) || data.routes.length === 0) {
    return null;
  }

  const route = data.routes[0];
  const legs = Array.isArray(route.legs) ? route.legs : [];
  if (legs.length === 0) return null;

  const distanceMeters = legs.reduce((sum, leg) => sum + Number(leg?.distance?.value || 0), 0);
  const durationSeconds = legs.reduce(
    (sum, leg) => sum + Number(leg?.duration_in_traffic?.value || leg?.duration?.value || 0),
    0
  );
  if (distanceMeters <= 0 || durationSeconds <= 0) return null;

  const warnings = Array.isArray(route.warnings) ? route.warnings : [];
  const tollDetected = `${route.summary || ""} ${warnings.join(" ")}`.toLowerCase().includes("toll");

  return {
    distanceKm: roundMoney(distanceMeters / 1000),
    durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
    metadata: {
      source: "google_directions",
      traffic_aware: true,
      toll_detected: tollDetected,
      summary: route.summary || "",
      warnings,
    },
  };
}

async function resolveRouteWithOsrm(pickup, drop) {
  const response = await axios.get(
    `${OSRM_ROUTE_URL}/${pickup.lng},${pickup.lat};${drop.lng},${drop.lat}`,
    {
      timeout: ROUTE_TIMEOUT_MS,
      params: {
        overview: "simplified",
        alternatives: false,
        steps: false,
      },
    }
  );

  const route = response.data?.routes?.[0];
  const distanceMeters = Number(route?.distance || 0);
  const durationSeconds = Number(route?.duration || 0);
  if (distanceMeters <= 0 || durationSeconds <= 0) return null;

  return {
    distanceKm: roundMoney(distanceMeters / 1000),
    durationMinutes: Math.max(1, Math.round(durationSeconds / 60)),
    metadata: {
      source: "osrm",
      traffic_aware: false,
      toll_detected: false,
      summary: "OSRM driving route",
      warnings: [],
    },
  };
}

async function resolveRouteMetrics(pickup, drop) {
  const directKm = haversineKm(pickup, drop);
  if (directKm < 0.05) {
    throw new TowingQuoteError("Drop location must be different from pickup location.");
  }

  try {
    const googleRoute = await resolveRouteWithGoogle(pickup, drop);
    if (googleRoute) return googleRoute;
  } catch (err) {
    console.warn("[Towing quote] Google route lookup failed:", err?.message || err);
  }

  try {
    const osrmRoute = await resolveRouteWithOsrm(pickup, drop);
    if (osrmRoute) return osrmRoute;
  } catch (err) {
    console.warn("[Towing quote] OSRM route lookup failed:", err?.message || err);
  }

  throw new TowingQuoteError(
    "Unable to calculate a road route for these locations. Please adjust the pickup or drop location.",
    502,
    "route_unavailable"
  );
}

function validateClientDistance(clientDistanceKm, serverDistanceKm) {
  const clientDistance = toFiniteNumber(clientDistanceKm);
  if (clientDistance == null || clientDistance <= 0) return;

  const delta = Math.abs(clientDistance - serverDistanceKm);
  const allowedDelta = Math.max(MAX_DISTANCE_TAMPER_KM, serverDistanceKm * MAX_DISTANCE_TAMPER_RATIO);
  if (delta > allowedDelta) {
    throw new TowingQuoteError(
      "Submitted towing distance does not match the verified route.",
      400,
      "distance_mismatch"
    );
  }
}

async function countActiveNearbyDemand(pool, pickup, radiusKm, windowMinutes) {
  const [rows] = await pool.query(
    `SELECT location_lat, location_lng
       FROM service_requests
      WHERE service_type LIKE ?
        AND status IN ('pending', 'assigned', 'accepted', 'on-the-way', 'en-route', 'in-progress', 'service_started')
        AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        AND location_lat IS NOT NULL
        AND location_lng IS NOT NULL`,
    ["%towing%", Math.max(1, Math.round(windowMinutes || 30))]
  );

  return rows.filter((row) => {
    const lat = toFiniteNumber(row.location_lat);
    const lng = toFiniteNumber(row.location_lng);
    if (lat == null || lng == null) return false;
    return haversineKm(pickup, { lat, lng }) <= radiusKm;
  }).length;
}

async function countNearbySupply(pool, pickup, radiusKm) {
  const [rows] = await pool.query(
    `SELECT latitude, longitude, service_type, specialties, service_costs
       FROM technicians
      WHERE status = 'approved'
        AND is_active = TRUE
        AND is_available = TRUE
        AND current_job_id IS NULL
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL`
  );

  return rows.filter((row) => {
    const lat = toFiniteNumber(row.latitude);
    const lng = toFiniteNumber(row.longitude);
    if (lat == null || lng == null) return false;
    if (haversineKm(pickup, { lat, lng }) > radiusKm) return false;

    const searchable = `${row.service_type || ""} ${row.specialties || ""} ${row.service_costs || ""}`.toLowerCase();
    return searchable.includes("towing") || searchable.includes("tow");
  }).length;
}

function isPeakHour(date = new Date()) {
  const hour = date.getHours();
  return (hour >= 8 && hour <= 11) || (hour >= 17 && hour <= 21);
}

async function computeMarketFactors({ pool, pickup, route, rules, emergency = false }) {
  const surgeRules = rules.surge || {};
  const radiusKm = Math.max(1, Number(surgeRules.radius_km || 12));
  const demandWindowMinutes = Math.max(1, Number(surgeRules.demand_window_minutes || 30));
  const [activeDemand, availableSupply] = await Promise.all([
    countActiveNearbyDemand(pool, pickup, radiusKm, demandWindowMinutes),
    countNearbySupply(pool, pickup, radiusKm),
  ]);

  let surgeMultiplier = 1;
  const surgeEnabled = surgeRules.enabled !== false;
  if (surgeEnabled) {
    const demandPressure = Math.max(0, activeDemand - availableSupply);
    const pressureMultiplier = 1 + demandPressure * Number(surgeRules.demand_supply_weight || 0.08);
    const peakMultiplier = isPeakHour() ? Number(surgeRules.peak_hour_multiplier || 1.1) : 1;
    const maxMultiplier = Math.max(1, Number(surgeRules.max_multiplier || 1.75));
    surgeMultiplier = Math.min(maxMultiplier, Math.max(1, pressureMultiplier, peakMultiplier));
  }

  const highwayMultiplier =
    route.distanceKm >= Number(rules.highway_min_km || 25)
      ? clampMultiplier(rules.highway_multiplier, 1)
      : 1;

  return {
    surgeMultiplier: roundMoney(surgeMultiplier),
    vehicleSupply: availableSupply,
    activeDemand,
    peakHour: isPeakHour(),
    weatherFactor: clampMultiplier(rules.weather_multiplier, 1),
    highwayFactor: highwayMultiplier,
    emergencyFactor: emergency ? clampMultiplier(rules.emergency_multiplier, 1) : 1,
  };
}

async function resolveTechnicianPricing({ technicianId, serviceType, vehicleType, pricingConfig, rules }) {
  const technicianIdNumber = Number(technicianId);
  if (Number.isInteger(technicianIdNumber) && technicianIdNumber > 0) {
    try {
      const definition = await fetchTechnicianPricingDefinition({
        technicianId: technicianIdNumber,
        serviceType: "towing",
        vehicleType,
      });
      if (definition?.technician_pricing) {
        return {
          source: "technician",
          service_type: definition.service_type,
          vehicle_type: definition.vehicle_type,
          technician_pricing: {
            ...definition.technician_pricing,
            base_price: toPositiveMoney(definition.technician_pricing.base_price),
            free_km: toFiniteNumber(definition.technician_pricing.free_km) ?? rules.base_includes_km,
            per_km_price: toPositiveMoney(definition.technician_pricing.per_km_price) ?? rules.per_km_price,
            night_charge: toFiniteNumber(definition.technician_pricing.night_charge) ?? rules.night_charge,
            night_type: definition.technician_pricing.night_type || rules.night_type || "flat",
          },
        };
      }
    } catch (err) {
      console.warn("[Towing quote] Technician pricing lookup failed:", err?.message || err);
    }
  }

  return {
    source: "platform",
    service_type: "towing",
    vehicle_type: vehicleType,
    technician_pricing: {
      base_price: getServiceMatrixAmount(serviceType || "towing", vehicleType, pricingConfig),
      free_km: rules.base_includes_km,
      per_km_price: rules.per_km_price,
      night_charge: rules.night_charge,
      night_type: rules.night_type || "flat",
    },
  };
}

function buildPricingBreakdown({
  engineResult,
  route,
  rules,
  vehicleCategory,
  marketFactors,
  paymentAmounts,
  pricingSource,
}) {
  const vehicleMultiplier = clampMultiplier(
    rules.vehicle_multipliers?.[vehicleCategory],
    rules.vehicle_multipliers?.car || 1
  );
  const surgeMultiplier = clampMultiplier(marketFactors.surgeMultiplier, 1);
  const weatherFactor = clampMultiplier(marketFactors.weatherFactor, 1);
  const highwayFactor = clampMultiplier(marketFactors.highwayFactor, 1);
  const emergencyFactor = clampMultiplier(marketFactors.emergencyFactor, 1);
  const subtotalBeforeFactors = roundMoney(engineResult.subtotal || engineResult.base_price + engineResult.extra_charges);
  const multiplierProduct = vehicleMultiplier * surgeMultiplier * weatherFactor * highwayFactor * emergencyFactor;
  const adjustedSubtotal = roundMoney(subtotalBeforeFactors * multiplierProduct);
  const taxPercent = Number(rules.tax_percent || 0);
  const taxAmount = roundMoney(adjustedSubtotal * taxPercent);
  const baseAmount = roundMoney(adjustedSubtotal + taxAmount);

  return {
    currency: paymentAmounts.currency || "INR",
    pricing_source: pricingSource,
    distance_km: route.distanceKm,
    estimated_duration_minutes: route.durationMinutes,
    base_towing_charge: roundMoney(engineResult.base_price || 0),
    included_km: Number(rules.base_includes_km || 0),
    per_km_rate: roundMoney(rules.per_km_price || 0),
    distance_charge: roundMoney(engineResult.distance_charge || 0),
    night_charge: roundMoney(engineResult.night_charge || 0),
    subtotal_before_factors: subtotalBeforeFactors,
    vehicle_category: vehicleCategory,
    vehicle_multiplier: roundMoney(vehicleMultiplier),
    surge_multiplier: roundMoney(surgeMultiplier),
    weather_factor: roundMoney(weatherFactor),
    highway_factor: roundMoney(highwayFactor),
    emergency_factor: roundMoney(emergencyFactor),
    tax_percent: taxPercent,
    tax_amount: taxAmount,
    base_amount: baseAmount,
    platform_fee: paymentAmounts.platformFee,
    payment_fee: paymentAmounts.paymentFee,
    final_estimated_price: paymentAmounts.finalAmount,
    active_demand_nearby: marketFactors.activeDemand,
    active_mechanics_nearby: marketFactors.vehicleSupply,
    peak_hour: marketFactors.peakHour,
    engine_snapshot: engineResult,
  };
}

export async function buildTowingQuote(input = {}) {
  const pickup = normalizeLocation(
    {
      address: input.pickupAddress ?? input.pickupLocation ?? input.address,
      lat: input.pickupLat ?? input.location_lat ?? input.locationLat,
      lng: input.pickupLng ?? input.location_lng ?? input.locationLng,
    },
    "Pickup"
  );
  const drop = normalizeLocation(
    {
      address: input.dropAddress ?? input.dropLocation ?? input.drop_address,
      lat: input.dropLat ?? input.drop_latitude ?? input.dropLatitude,
      lng: input.dropLng ?? input.drop_longitude ?? input.dropLongitude,
    },
    "Drop"
  );

  const serviceDomain = canonicalizeServiceDomain(
    String(input.serviceType || input.service_type || "towing").replace(/^(car|bike|ev|commercial)-/i, "")
  );
  if (serviceDomain !== "towing") {
    throw new TowingQuoteError("Towing quote can only be calculated for towing services.");
  }

  const rawVehicle = input.vehicleType || input.vehicle_type || String(input.serviceType || "").split("-")[0];
  const broadVehicle = canonicalizeVehicleFamily(rawVehicle) || "car";
  const canonicalServiceType = `${broadVehicle}-towing`;
  const vehicleCategory = normalizeVehicleCategory({
    vehicleType: rawVehicle,
    vehicleModel: input.vehicleModel ?? input.vehicle_model,
    vehicleSubtype: input.vehicleSubtype ?? input.vehicle_subtype,
  });

  const pool = input.pool || await getPool();
  const [pricingConfig, route] = await Promise.all([
    getPlatformPricingConfig(),
    resolveRouteMetrics(pickup, drop),
  ]);
  validateClientDistance(
    input.clientDistanceKm ?? input.distanceKm ?? input.route_distance_km ?? input.distance_km,
    route.distanceKm
  );

  const rules = normalizeTowingPricingRules(pricingConfig.towing_pricing_rules);
  const pricingDefinition = await resolveTechnicianPricing({
    technicianId: input.technicianId ?? input.technician_id,
    serviceType: canonicalServiceType,
    vehicleType: broadVehicle,
    pricingConfig,
    rules,
  });

  const engineResult = calculateFinalPrice(
    {
      service_type: pricingDefinition.service_type,
      vehicle_type: pricingDefinition.vehicle_type,
      technician_pricing: pricingDefinition.technician_pricing,
      distance_km: route.distanceKm,
      time_of_day: input.timeOfDay ?? input.time_of_day ?? DEFAULT_TIME_OF_DAY(),
    },
    {
      platform_fee_percent: pricingConfig.platform_fee_percent,
      payment_fee_percent: pricingConfig.payment_fee_percent,
      customer_price_rounding_increment: pricingConfig.customer_price_rounding_increment,
    }
  );

  const marketFactors = await computeMarketFactors({
    pool,
    pickup,
    route,
    rules,
    emergency: Boolean(input.emergency || input.isEmergency || input.priority === "emergency"),
  });

  const provisionalBreakdown = buildPricingBreakdown({
    engineResult,
    route,
    rules,
    vehicleCategory,
    marketFactors,
    paymentAmounts: { currency: pricingConfig.currency || "INR", platformFee: 0, paymentFee: 0, finalAmount: 0 },
    pricingSource: pricingDefinition.source,
  });
  const paymentAmounts = computeServiceRequestPaymentAmounts(provisionalBreakdown.base_amount, {
    currency: pricingConfig.currency || "INR",
    paymentMode: input.paymentMode || input.payment_mode || "upi",
  });
  const pricingBreakdown = buildPricingBreakdown({
    engineResult,
    route,
    rules,
    vehicleCategory,
    marketFactors,
    paymentAmounts,
    pricingSource: pricingDefinition.source,
  });

  return {
    service_type: canonicalServiceType,
    vehicle_type: broadVehicle,
    vehicle_category: vehicleCategory,
    pickup,
    drop,
    distance_km: route.distanceKm,
    estimated_duration: route.durationMinutes,
    route_metadata: {
      ...route.metadata,
      pickup,
      drop,
      calculated_at: new Date().toISOString(),
    },
    pricing_breakdown: pricingBreakdown,
    base_amount: pricingBreakdown.base_amount,
    final_estimated_price: pricingBreakdown.final_estimated_price,
  };
}

export function normalizeTowingQuoteError(err) {
  if (err instanceof TowingQuoteError) {
    return {
      statusCode: err.statusCode,
      payload: { error: err.message, code: err.code },
    };
  }
  return {
    statusCode: 500,
    payload: { error: "Failed to calculate towing estimate.", code: "towing_quote_failed" },
  };
}
