import { applyBasisPoints, divideAndRoundHalfUp } from "./money.js";

const NIGHT_START_MINUTES = 21 * 60;
const NIGHT_END_MINUTES = 6 * 60;
const ISO_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[tT ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function extractLocalClockMinutes(timeOfDay) {
  const raw = String(timeOfDay || "").trim();
  if (!raw) {
    throw new Error("time_of_day is required.");
  }

  if (!Number.isFinite(Date.parse(raw))) {
    throw new Error("time_of_day must be a valid ISO timestamp.");
  }

  const match = raw.match(ISO_TIME_PATTERN);
  if (!match) {
    throw new Error("time_of_day must be a valid ISO timestamp.");
  }

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("time_of_day must contain a valid hour.");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("time_of_day must contain a valid minute.");
  }

  return (hour * 60) + minute;
}

export function isNightPricingTime(timeOfDay) {
  const clockMinutes = extractLocalClockMinutes(timeOfDay);
  return clockMinutes >= NIGHT_START_MINUTES || clockMinutes < NIGHT_END_MINUTES;
}

export function calculateTowingCharges({
  basePricePaise,
  freeKmHundredths,
  perKmPricePaise,
  distanceHundredths,
}) {
  if (distanceHundredths <= freeKmHundredths) {
    return {
      basePricePaise,
      extraChargesPaise: 0n,
    };
  }

  const excessDistanceHundredths = distanceHundredths - freeKmHundredths;
  const extraChargesPaise = divideAndRoundHalfUp(
    BigInt(perKmPricePaise) * BigInt(excessDistanceHundredths),
    100n
  );

  return {
    basePricePaise,
    extraChargesPaise,
  };
}

export function calculateStandardServiceCharges({ serviceChargePaise, visitChargePaise }) {
  return {
    basePricePaise: BigInt(serviceChargePaise) + BigInt(visitChargePaise),
    extraChargesPaise: 0n,
  };
}

export function calculateNightChargePaise({
  subtotalPaise,
  isNight,
  nightChargePaise = 0n,
  nightChargeBasisPoints = 0n,
  nightType = null,
}) {
  if (!isNight) {
    return 0n;
  }

  if (nightChargePaise === 0n && nightChargeBasisPoints === 0n) {
    return 0n;
  }

  if (nightType === "flat") {
    return BigInt(nightChargePaise);
  }

  if (nightType === "percentage") {
    return applyBasisPoints(subtotalPaise, nightChargeBasisPoints);
  }

  throw new Error("night_type must be either 'flat' or 'percentage'.");
}
