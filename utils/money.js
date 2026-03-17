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
