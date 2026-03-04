export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toPositiveInt(value, fallback = 1, { min = 1, max = 500 } = {}) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function resolveAdminId(req) {
  return String(req.admin?.email || req.adminEmail || "admin");
}

export function buildPagination(query) {
  const page = toPositiveInt(query?.page, 1, { min: 1, max: 100000 });
  const limit = toPositiveInt(query?.limit, 10, { min: 1, max: 100 });
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

export function likeFilter(value) {
  return `%${String(value || "").trim()}%`;
}
