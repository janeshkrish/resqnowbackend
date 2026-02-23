import { getPool } from "../db.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "./serviceNormalization.js";

const CACHE_TTL_MS = Math.max(5000, Number(process.env.PRICING_CONFIG_CACHE_TTL_MS || 30000));

const clone = (value) => JSON.parse(JSON.stringify(value));
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const toPositiveNumber = (value, fallback, { allowZero = false } = {}) => {
  const parsed = toNumber(value);
  if (parsed == null) return fallback;
  if (allowZero ? parsed < 0 : parsed <= 0) return fallback;
  return parsed;
};

const toPercent = (value, fallback) => {
  const parsed = toNumber(value);
  if (parsed == null) return fallback;
  if (parsed < 0 || parsed > 1) return fallback;
  return parsed;
};

const parseJson = (value) => {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
};

const toStringList = (value, fallback = []) => {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : String(item || "").trim()))
    .filter(Boolean);
  return items.length ? items : fallback;
};

export const DEFAULT_SERVICE_BASE_PRICES = Object.freeze({
  towing: { car: 599, bike: 399, commercial: 2499, ev: 699 },
  "flat-tire": { car: 349, bike: 99, commercial: 999, ev: 299 },
  battery: { car: 399, bike: 199, commercial: 899, ev: 499 },
  mechanical: { car: 499, bike: 499, commercial: 1499, ev: 399 },
  fuel: { car: 299, bike: 99, commercial: 499, ev: 299 },
  lockout: { car: 399, bike: 199, commercial: 699, ev: 399 },
  winching: { car: 599, bike: 399, commercial: 1999, ev: 699 },
  "ev-charging": { car: 499, bike: 299, commercial: 899, ev: 299 },
  other: { car: 500, bike: 500, commercial: 500, ev: 500 },
});

export const DEFAULT_SUBSCRIPTION_PLANS = Object.freeze([
  {
    id: "free",
    name: "PAY-AS-YOU-GO",
    amount: 0,
    period: "per month",
    description: "Use only when you need it",
    features: [
      "Request roadside assistance anytime",
      "Access to nearby verified technicians",
      "Live technician tracking",
      "Transparent price breakup",
    ],
    notIncluded: [
      "Platform convenience fee per service",
      "Priority response",
      "Service history & invoices",
    ],
    idealFor: ["Occasional users", "First-time customers", "Emergency-only usage"],
    footer: "No commitment. Pay only when you are stuck.",
    color: "green",
    recommended: false,
    active: true,
    display_order: 0,
  },
  {
    id: "basic",
    name: "SMART CARE",
    amount: 99,
    period: "per month",
    description: "Save money. Get priority. Stay worry-free.",
    features: [
      "Everything in Free, plus:",
      "Zero platform fee on all services",
      "Faster technician assignment",
      "Priority support during breakdowns",
      "Service history & invoices",
      "Exclusive offers & discounts",
    ],
    notIncluded: [],
    idealFor: ["Daily commuters", "Students & office-goers", "Two-wheeler & car owners"],
    footer: "One small fee. Big peace of mind.",
    color: "blue",
    recommended: true,
    active: true,
    display_order: 1,
  },
  {
    id: "premium",
    name: "TOTAL CARE",
    amount: 149,
    period: "per month",
    description: "Maximum coverage. Zero stress.",
    features: [
      "Everything in Smart Care, plus:",
      "Highest priority technician matching",
      "Free or discounted emergency services",
      "Extended service coverage (late night / peak hours)",
      "Dedicated customer support",
      "Family vehicle coverage (up to 2 vehicles)",
    ],
    notIncluded: [],
    idealFor: [],
    footer: "Subject to fair usage policy",
    color: "purple",
    recommended: false,
    active: true,
    display_order: 2,
  },
]);

export const DEFAULT_PLATFORM_PRICING_CONFIG = Object.freeze({
  id: null,
  currency: "INR",
  platform_fee_percent: 0.1,
  registration_fee: 500,
  booking_fee: 199,
  pay_now_discount_percent: 0,
  default_service_amount: 500,
  service_base_prices: clone(DEFAULT_SERVICE_BASE_PRICES),
  subscription_plans: clone(DEFAULT_SUBSCRIPTION_PLANS),
});

function normalizeServiceBasePrices(rawPrices) {
  const parsed = parseJson(rawPrices);
  const matrix = clone(DEFAULT_SERVICE_BASE_PRICES);
  if (!parsed || typeof parsed !== "object") return matrix;

  Object.entries(parsed).forEach(([domainKey, vehiclePrices]) => {
    const domain = canonicalizeServiceDomain(String(domainKey || ""));
    if (!domain) return;
    if (!matrix[domain]) matrix[domain] = {};
    if (!vehiclePrices || typeof vehiclePrices !== "object") return;

    Object.entries(vehiclePrices).forEach(([vehicleKey, amount]) => {
      const vehicle = canonicalizeVehicleFamily(String(vehicleKey || ""));
      if (!vehicle) return;
      const parsedAmount = toPositiveNumber(amount, null);
      if (parsedAmount == null) return;
      matrix[domain][vehicle] = roundMoney(parsedAmount);
    });
  });

  return matrix;
}

function normalizeSubscriptionPlan(plan, index, defaultPlan = null) {
  const idRaw = typeof plan?.id === "string" ? plan.id : defaultPlan?.id;
  const id = String(idRaw || `plan_${index + 1}`).trim().toLowerCase();
  const amount = toPositiveNumber(plan?.amount, defaultPlan?.amount ?? 0, { allowZero: true });
  const displayOrder = Number.isFinite(Number(plan?.display_order))
    ? Number(plan.display_order)
    : (defaultPlan?.display_order ?? index);

  return {
    id,
    name: String(plan?.name || defaultPlan?.name || id).trim(),
    amount: roundMoney(amount),
    period: String(plan?.period || defaultPlan?.period || "per month").trim(),
    description: String(plan?.description || defaultPlan?.description || "").trim(),
    features: toStringList(plan?.features, defaultPlan?.features || []),
    notIncluded: toStringList(plan?.notIncluded, defaultPlan?.notIncluded || []),
    idealFor: toStringList(plan?.idealFor, defaultPlan?.idealFor || []),
    footer: String(plan?.footer || defaultPlan?.footer || "").trim(),
    color: String(plan?.color || defaultPlan?.color || "gray").trim(),
    recommended: typeof plan?.recommended === "boolean" ? plan.recommended : !!defaultPlan?.recommended,
    active: typeof plan?.active === "boolean" ? plan.active : defaultPlan?.active !== false,
    display_order: displayOrder,
  };
}

function normalizeSubscriptionPlans(rawPlans) {
  const parsed = parseJson(rawPlans);
  const inputPlans = Array.isArray(parsed) ? parsed : [];
  const fallbackById = new Map(DEFAULT_SUBSCRIPTION_PLANS.map((plan) => [plan.id, plan]));
  const byId = new Map();

  inputPlans.forEach((plan, index) => {
    const fallback = fallbackById.get(String(plan?.id || "").trim().toLowerCase()) || null;
    const normalized = normalizeSubscriptionPlan(plan || {}, index, fallback);
    byId.set(normalized.id, normalized);
  });

  DEFAULT_SUBSCRIPTION_PLANS.forEach((plan, index) => {
    if (byId.has(plan.id)) return;
    byId.set(plan.id, normalizeSubscriptionPlan(plan, index, plan));
  });

  return Array.from(byId.values()).sort((a, b) => {
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return String(a.id).localeCompare(String(b.id));
  });
}

function normalizeConfigRow(row) {
  const fallback = DEFAULT_PLATFORM_PRICING_CONFIG;
  return {
    id: row?.id ? Number(row.id) : null,
    currency: String(row?.currency || fallback.currency).trim().toUpperCase() || fallback.currency,
    platform_fee_percent: toPercent(row?.platform_fee_percent, fallback.platform_fee_percent),
    registration_fee: roundMoney(toPositiveNumber(row?.registration_fee, fallback.registration_fee)),
    booking_fee: roundMoney(toPositiveNumber(row?.booking_fee, fallback.booking_fee)),
    pay_now_discount_percent: toPercent(row?.pay_now_discount_percent, fallback.pay_now_discount_percent),
    default_service_amount: roundMoney(toPositiveNumber(row?.default_service_amount, fallback.default_service_amount)),
    service_base_prices: normalizeServiceBasePrices(row?.service_base_prices),
    subscription_plans: normalizeSubscriptionPlans(row?.subscription_plans),
  };
}

let cachedConfig = null;
let cacheTimestamp = 0;
let inflightFetch = null;

async function seedDefaultConfig(pool) {
  await pool.execute(
    `INSERT INTO platform_pricing_config
      (currency, platform_fee_percent, registration_fee, booking_fee, pay_now_discount_percent, default_service_amount, service_base_prices, subscription_plans, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
    [
      DEFAULT_PLATFORM_PRICING_CONFIG.currency,
      DEFAULT_PLATFORM_PRICING_CONFIG.platform_fee_percent,
      DEFAULT_PLATFORM_PRICING_CONFIG.registration_fee,
      DEFAULT_PLATFORM_PRICING_CONFIG.booking_fee,
      DEFAULT_PLATFORM_PRICING_CONFIG.pay_now_discount_percent,
      DEFAULT_PLATFORM_PRICING_CONFIG.default_service_amount,
      JSON.stringify(DEFAULT_PLATFORM_PRICING_CONFIG.service_base_prices),
      JSON.stringify(DEFAULT_PLATFORM_PRICING_CONFIG.subscription_plans),
    ]
  );
}

async function fetchConfigFromDb() {
  const pool = await getPool();
  let [rows] = await pool.query(
    "SELECT * FROM platform_pricing_config WHERE is_active = TRUE ORDER BY updated_at DESC, id DESC LIMIT 1"
  );

  if (!rows || rows.length === 0) {
    await seedDefaultConfig(pool);
    [rows] = await pool.query(
      "SELECT * FROM platform_pricing_config WHERE is_active = TRUE ORDER BY updated_at DESC, id DESC LIMIT 1"
    );
  }

  return normalizeConfigRow(rows?.[0] || null);
}

export function invalidatePlatformPricingCache() {
  cachedConfig = null;
  cacheTimestamp = 0;
}

export async function getPlatformPricingConfig({ forceRefresh = false } = {}) {
  const isFresh = cachedConfig && (Date.now() - cacheTimestamp < CACHE_TTL_MS);
  if (!forceRefresh && isFresh) {
    return clone(cachedConfig);
  }

  if (!forceRefresh && inflightFetch) {
    return inflightFetch;
  }

  inflightFetch = (async () => {
    try {
      const config = await fetchConfigFromDb();
      cachedConfig = config;
      cacheTimestamp = Date.now();
      return clone(config);
    } catch (err) {
      console.error("[platformPricing] Falling back to defaults:", err?.message || err);
      const fallback = normalizeConfigRow(null);
      cachedConfig = fallback;
      cacheTimestamp = Date.now();
      return clone(fallback);
    } finally {
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

export function getServiceMatrixAmount(serviceType, vehicleType, pricingConfig = null) {
  const config = pricingConfig || DEFAULT_PLATFORM_PRICING_CONFIG;
  const rawService = String(serviceType || "");
  const domain = canonicalizeServiceDomain(rawService.replace(/^(car|bike|ev|commercial)-/i, ""));
  const vehicle = canonicalizeVehicleFamily(vehicleType || rawService.split("-")[0]);

  const fallbackAmount = roundMoney(
    toPositiveNumber(config?.default_service_amount, DEFAULT_PLATFORM_PRICING_CONFIG.default_service_amount)
  );

  if (!domain || !vehicle) return fallbackAmount;

  const matrix = config?.service_base_prices || DEFAULT_PLATFORM_PRICING_CONFIG.service_base_prices;
  const domainEntry = matrix?.[domain] || matrix?.other || {};

  const amount =
    toPositiveNumber(domainEntry?.[vehicle], null) ??
    toPositiveNumber(matrix?.other?.[vehicle], null) ??
    fallbackAmount;

  return roundMoney(amount);
}

export function computePaymentAmounts(baseAmount, pricingConfig = null) {
  const config = pricingConfig || DEFAULT_PLATFORM_PRICING_CONFIG;
  const safeBase = roundMoney(
    toPositiveNumber(baseAmount, toPositiveNumber(config.default_service_amount, DEFAULT_PLATFORM_PRICING_CONFIG.default_service_amount))
  );
  const feePercent = toPercent(config.platform_fee_percent, DEFAULT_PLATFORM_PRICING_CONFIG.platform_fee_percent);
  const platformFee = roundMoney(safeBase * feePercent);
  const totalAmount = roundMoney(safeBase + platformFee);

  return {
    currency: String(config.currency || "INR").toUpperCase(),
    baseAmount: safeBase,
    platformFeePercent: feePercent,
    platformFee,
    totalAmount,
  };
}

export function listSubscriptionPlans(pricingConfig = null, { includeInactive = false } = {}) {
  const config = pricingConfig || DEFAULT_PLATFORM_PRICING_CONFIG;
  const plans = Array.isArray(config.subscription_plans)
    ? config.subscription_plans
    : DEFAULT_PLATFORM_PRICING_CONFIG.subscription_plans;

  return plans.filter((plan) => includeInactive || plan.active !== false);
}

export function getSubscriptionPlanById(planId, pricingConfig = null) {
  const id = String(planId || "").trim().toLowerCase();
  if (!id) return null;
  const plans = listSubscriptionPlans(pricingConfig, { includeInactive: true });
  return plans.find((plan) => String(plan.id).toLowerCase() === id) || null;
}
