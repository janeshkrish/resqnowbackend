const DEFAULT_SCALE = 100;

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toPaise(value, fallback = 0) {
  return Math.round(toFiniteNumber(value, fallback) * DEFAULT_SCALE);
}

export function fromPaise(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return roundMoney(fallback);
  return Number((parsed / DEFAULT_SCALE).toFixed(2));
}

export function roundMoney(value, fallback = 0) {
  return fromPaise(toPaise(value, fallback), fallback);
}

export function ensureNonNegativeMoney(value, fallback = 0) {
  const rounded = roundMoney(value, fallback);
  return rounded < 0 ? roundMoney(fallback) : rounded;
}

export function addMoney(...values) {
  const totalPaise = values.reduce((sum, value) => sum + toPaise(value, 0), 0);
  return fromPaise(totalPaise, 0);
}

export function subtractMoney(left, right) {
  return fromPaise(toPaise(left, 0) - toPaise(right, 0), 0);
}

export function multiplyMoney(value, multiplier) {
  return fromPaise(Math.round(toPaise(value, 0) * toFiniteNumber(multiplier, 0)), 0);
}

export function isPositiveMoney(value) {
  return toPaise(value, 0) > 0;
}

const BIGINT_ZERO = 0n;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

function pow10BigInt(exponent) {
  return 10n ** BigInt(exponent);
}

function normalizeDecimalInput(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Invalid numeric value.");
    }
    return value.toString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("Numeric value is required.");
    }
    return trimmed;
  }

  if (value == null) {
    throw new Error("Numeric value is required.");
  }

  return String(value).trim();
}

export function parseDecimalToScaledInteger(value, scale = 2) {
  const normalized = normalizeDecimalInput(value);
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePartRaw, fractionPartRaw = ""] = unsigned.split(".");
  const wholePart = wholePartRaw || "0";
  const fractionPart = fractionPartRaw || "";
  const scaleFactor = pow10BigInt(scale);

  let scaled = BigInt(wholePart) * scaleFactor;
  if (scale > 0) {
    const paddedFraction = fractionPart.padEnd(scale, "0");
    const relevantFraction = paddedFraction.slice(0, scale) || "0";
    scaled += BigInt(relevantFraction);

    const roundingDigit = fractionPart.length > scale ? fractionPart[scale] : "0";
    if (roundingDigit >= "5") {
      scaled += 1n;
    }
  }

  return negative ? -scaled : scaled;
}

export function parseMoneyToPaise(value) {
  return parseDecimalToScaledInteger(value, 2);
}

export function parseDistanceToHundredths(value) {
  return parseDecimalToScaledInteger(value, 2);
}

export function parseFractionToBasisPoints(value) {
  const scaled = parseDecimalToScaledInteger(value, 6);
  return divideAndRoundHalfUp(scaled * 10000n, 1000000n);
}

export function parsePercentToBasisPoints(value) {
  return parseDecimalToScaledInteger(value, 2);
}

export function divideAndRoundHalfUp(numerator, denominator) {
  const safeNumerator = BigInt(numerator);
  const safeDenominator = BigInt(denominator);
  if (safeDenominator === BIGINT_ZERO) {
    throw new Error("Division by zero.");
  }

  const negative = (safeNumerator < BIGINT_ZERO) !== (safeDenominator < BIGINT_ZERO);
  const absNumerator = safeNumerator < BIGINT_ZERO ? -safeNumerator : safeNumerator;
  const absDenominator = safeDenominator < BIGINT_ZERO ? -safeDenominator : safeDenominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const shouldRoundUp = remainder * 2n >= absDenominator;
  const rounded = quotient + (shouldRoundUp ? 1n : 0n);

  return negative ? -rounded : rounded;
}

export function applyBasisPoints(amount, basisPoints) {
  return divideAndRoundHalfUp(BigInt(amount) * BigInt(basisPoints), 10000n);
}

export function roundPaiseToNearestRupeeIncrement(amountPaise, incrementRupees = 5) {
  const increment = BigInt(incrementRupees);
  if (increment <= BIGINT_ZERO) {
    throw new Error("Rounding increment must be greater than zero.");
  }

  const stepPaise = increment * 100n;
  return divideAndRoundHalfUp(BigInt(amountPaise), stepPaise) * stepPaise;
}

export function paiseToNumber(value) {
  const numeric = Number(BigInt(value));
  return Number((numeric / DEFAULT_SCALE).toFixed(2));
}
