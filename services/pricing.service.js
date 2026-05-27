import {
  applyBasisPoints,
  paiseToNumber,
  parseDistanceToHundredths,
  parseFractionToBasisPoints,
  parseMoneyToPaise,
  parsePercentToBasisPoints,
  roundPaiseToNearestRupeeIncrement,
} from "../utils/money.js";
import {
  calculateNightChargePaise,
  calculateStandardServiceCharges,
  calculateTowingCharges,
  isNightPricingTime,
} from "../utils/pricingRules.js";
import { normalizePricingServiceType, normalizePricingVehicleType } from "../models/technicianPricing.js";

const DEFAULT_PRICING_CONFIG = Object.freeze({
  platform_fee_percent: 0.10,
  payment_fee_percent: 0.02,
  customer_price_rounding_increment: 5,
});

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function parseNonNegativeBigInt(fieldName, value, parser, { required = true } = {}) {
  if (value == null || (typeof value === "string" && !value.trim())) {
    if (!required) {
      return 0n;
    }
    throw new Error(`${fieldName} is required.`);
  }

  let parsed;
  try {
    parsed = parser(value);
  } catch {
    throw new Error(`${fieldName} must be a valid number.`);
  }

  if (parsed < 0n) {
    throw new Error(`${fieldName} cannot be negative.`);
  }

  return parsed;
}

function normalizePricingConfig(config = DEFAULT_PRICING_CONFIG) {
  const platformFeeBasisPoints = parseNonNegativeBigInt(
    "platform_fee_percent",
    config.platform_fee_percent ?? DEFAULT_PRICING_CONFIG.platform_fee_percent,
    parseFractionToBasisPoints
  );
  const paymentFeeBasisPoints = parseNonNegativeBigInt(
    "payment_fee_percent",
    config.payment_fee_percent ?? DEFAULT_PRICING_CONFIG.payment_fee_percent,
    parseFractionToBasisPoints
  );

  const roundingIncrement = Number.parseInt(
    String(
      config.customer_price_rounding_increment ?? DEFAULT_PRICING_CONFIG.customer_price_rounding_increment
    ),
    10
  );

  if (!Number.isInteger(roundingIncrement) || ![5, 10].includes(roundingIncrement)) {
    throw new Error("customer_price_rounding_increment must be either 5 or 10.");
  }

  return {
    platformFeeBasisPoints,
    paymentFeeBasisPoints,
    roundingIncrement,
  };
}

function resolveNightChargePaise(technicianPricing, subtotalPaise, isNight) {
  const nightChargePaise = parseNonNegativeBigInt(
    "night_charge",
    technicianPricing?.night_charge,
    parseMoneyToPaise,
    { required: false }
  );

  if (nightChargePaise === 0n) {
    return 0n;
  }

  const nightType = String(technicianPricing?.night_type || "").trim().toLowerCase();
  if (!nightType) {
    throw new Error("night_type is required when night_charge is greater than zero.");
  }

  if (nightType === "flat") {
    return calculateNightChargePaise({
      subtotalPaise,
      isNight,
      nightChargePaise,
      nightType,
    });
  }

  if (nightType === "percentage") {
    const nightChargeBasisPoints = parseNonNegativeBigInt(
      "night_charge",
      technicianPricing?.night_charge,
      parsePercentToBasisPoints
    );
    return calculateNightChargePaise({
      subtotalPaise,
      isNight,
      nightChargeBasisPoints,
      nightType,
    });
  }

  throw new Error("night_type must be either 'flat' or 'percentage'.");
}

export function calculateFinalPrice(input, pricingConfig = DEFAULT_PRICING_CONFIG) {
  if (!isPlainObject(input)) {
    throw new Error("Pricing input is required.");
  }

  const serviceType = normalizePricingServiceType(input.service_type);
  if (!serviceType) {
    throw new Error("service_type is invalid or unsupported.");
  }

  const vehicleType = normalizePricingVehicleType(input.vehicle_type);
  if (!vehicleType) {
    throw new Error("vehicle_type is required.");
  }

  if (!isPlainObject(input.technician_pricing)) {
    throw new Error("technician_pricing is required.");
  }

  const feeConfig = normalizePricingConfig(pricingConfig);
  const isNight = isNightPricingTime(input.time_of_day);
  const providedDistanceHundredths = input.distance_km == null || input.distance_km === ""
    ? null
    : parseNonNegativeBigInt("distance_km", input.distance_km, parseDistanceToHundredths);

  let basePricePaise;
  let extraChargesPaise;
  let distanceChargePaise = 0n;

  if (serviceType === "towing") {
    const basePrice = parseNonNegativeBigInt("base_price", input.technician_pricing.base_price, parseMoneyToPaise);
    const freeKmHundredths = parseNonNegativeBigInt("free_km", input.technician_pricing.free_km, parseDistanceToHundredths);
    const perKmPricePaise = parseNonNegativeBigInt(
      "per_km_price",
      input.technician_pricing.per_km_price,
      parseMoneyToPaise
    );

    if (providedDistanceHundredths == null) {
      throw new Error("distance_km is required for towing.");
    }

    const towingCharges = calculateTowingCharges({
      basePricePaise: basePrice,
      freeKmHundredths,
      perKmPricePaise,
      distanceHundredths: providedDistanceHundredths,
    });
    basePricePaise = towingCharges.basePricePaise;
    extraChargesPaise = towingCharges.extraChargesPaise;
    distanceChargePaise = towingCharges.extraChargesPaise;
  } else {
    const serviceChargePaise = parseNonNegativeBigInt(
      "service_charge",
      input.technician_pricing.service_charge,
      parseMoneyToPaise
    );
    const visitChargePaise = parseNonNegativeBigInt(
      "visit_charge",
      input.technician_pricing.visit_charge,
      parseMoneyToPaise
    );

    const standardCharges = calculateStandardServiceCharges({
      serviceChargePaise,
      visitChargePaise,
    });
    basePricePaise = standardCharges.basePricePaise;
    extraChargesPaise = standardCharges.extraChargesPaise;
  }

  const subtotalBeforeNightPaise = basePricePaise + extraChargesPaise;
  const nightChargePaise = resolveNightChargePaise(
    input.technician_pricing,
    subtotalBeforeNightPaise,
    isNight
  );

  extraChargesPaise += nightChargePaise;

  const subtotalPaise = basePricePaise + extraChargesPaise;
  const platformFeePaise = applyBasisPoints(subtotalPaise, feeConfig.platformFeeBasisPoints);
  const paymentFeePaise = applyBasisPoints(subtotalPaise, feeConfig.paymentFeeBasisPoints);
  const finalPricePaise = roundPaiseToNearestRupeeIncrement(
    subtotalPaise + platformFeePaise + paymentFeePaise,
    feeConfig.roundingIncrement
  );

  return Object.freeze({
    base_price: paiseToNumber(basePricePaise),
    distance_charge: paiseToNumber(distanceChargePaise),
    night_charge: paiseToNumber(nightChargePaise),
    extra_charges: paiseToNumber(extraChargesPaise),
    subtotal: paiseToNumber(subtotalPaise),
    platform_fee: paiseToNumber(platformFeePaise),
    payment_fee: paiseToNumber(paymentFeePaise),
    final_price: paiseToNumber(finalPricePaise),
  });
}
