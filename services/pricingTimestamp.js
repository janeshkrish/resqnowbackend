const DEFAULT_TIME_OF_DAY = () => new Date().toISOString();
const TIME_ONLY_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export function coercePricingTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_TIME_OF_DAY();

  const timeOnlyMatch = raw.match(TIME_ONLY_PATTERN);
  if (timeOnlyMatch) {
    const scheduled = new Date();
    scheduled.setHours(
      Number(timeOnlyMatch[1]),
      Number(timeOnlyMatch[2]),
      Number(timeOnlyMatch[3] || 0),
      0
    );
    return scheduled.toISOString();
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? DEFAULT_TIME_OF_DAY() : parsed.toISOString();
}
