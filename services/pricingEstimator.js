import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "./serviceNormalization.js";
import { getPlatformPricingConfig, getServiceMatrixAmount } from "./platformPricing.js";

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const safeParse = (value) => {
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
};

const normalizeKeyToken = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const VEHICLE_PRICE_KEYS = Object.freeze({
  bike: [
    "price_2w_min", "price_2w", "price_2w_max", "price2wmin", "price2w", "price2wmax",
    "bike_price", "bikeprice", "bike_charge", "bikecharge", "two_wheeler_price", "twowheelerprice"
  ],
  car: [
    "price_4w_min", "price_4w", "price_4w_max", "price4wmin", "price4w", "price4wmax",
    "car_price", "carprice", "car_charge", "carcharge", "four_wheeler_price", "fourwheelerprice"
  ],
  commercial: [
    "price_commercial_min", "price_commercial", "commercial_price", "commercialprice",
    "commercial_charge", "commercialcharge", "price_4w_min", "price_4w"
  ],
  ev: [
    "price_ev_min", "price_ev", "priceevmin", "priceev",
    "ev_price", "evprice", "ev_charge", "evcharge", "price_4w_min", "price_4w"
  ],
});

const VEHICLE_NODE_KEYS = Object.freeze({
  bike: ["bike", "bikes", "2w", "2wheeler", "2wheel", "twowheeler", "motorcycle", "scooter"],
  car: ["car", "cars", "4w", "4wheeler", "4wheel", "fourwheeler", "sedan", "hatchback", "suv", "mpv", "muv"],
  commercial: ["commercial", "truck", "trucks", "bus", "buses", "van", "vans", "heavyvehicle"],
  ev: ["ev", "electric", "electricvehicle", "electriccar", "electricbike", "electricscooter"],
});

const GENERIC_PRICE_KEYS = [
  "base_charge", "basecharge", "baseCharge",
  "service_charge", "servicecharge", "serviceCharge",
  "visit_charge", "visitcharge", "visitCharge",
  "inspection_charge", "inspectioncharge", "inspectionCharge",
  "delivery_charge", "deliverycharge", "deliveryCharge",
  "per_puncture_charge", "perpuncturecharge", "perPunctureCharge",
  "labour_min", "labourmin", "labourMin",
  "minimum_charge", "minimumcharge", "min_charge", "mincharge",
  "min_price", "minprice", "fixed_charge", "fixedcharge",
  "price", "amount", "charge"
];

const METADATA_KEYS = new Set([
  "service", "servicename", "servicedomain", "service_domain", "service_name",
  "workincluded", "description", "notes", "fuelpetrol", "fueldiesel",
  "brand", "brandsupported", "free_distance", "freedistance", "extra_km_charge", "extrakmcharge",
  "night_charge", "nightcharge", "labour_max", "labourmax"
].map(normalizeKeyToken));

const NESTED_PRIORITY_KEYS = [
  "pricing_config",
  "pricing",
  "service_costs",
  "services",
  "subservices",
  "items",
  "charges",
  "rates"
].map(normalizeKeyToken);

const readObjectByKeys = (obj, keys = []) => {
  if (!obj || typeof obj !== "object") return null;
  const normalized = new Map(Object.keys(obj).map((key) => [normalizeKeyToken(key), key]));
  for (const key of keys) {
    const found = normalized.get(normalizeKeyToken(key));
    if (!found) continue;
    const amount = toNum(obj[found]);
    if (amount != null) return amount;
  }
  return null;
};

const matchesVehicleKey = (key, vehicle) => {
  if (!key || !vehicle) return false;
  const canonicalVehicle = canonicalizeVehicleFamily(key);
  if (canonicalVehicle && canonicalVehicle === vehicle) return true;
  const token = normalizeKeyToken(key);
  return VEHICLE_NODE_KEYS[vehicle]?.includes(token) || false;
};

const findVehicleNestedValue = (obj, vehicle) => {
  if (!obj || typeof obj !== "object") return null;
  for (const [key, value] of Object.entries(obj)) {
    if (!matchesVehicleKey(key, vehicle)) continue;
    if (value == null) continue;
    return value;
  }
  return null;
};

const sortedNestedEntries = (obj) => {
  const entries = Object.entries(obj || {});
  return entries.sort(([a], [b]) => {
    const pa = NESTED_PRIORITY_KEYS.includes(normalizeKeyToken(a)) ? 0 : 1;
    const pb = NESTED_PRIORITY_KEYS.includes(normalizeKeyToken(b)) ? 0 : 1;
    return pa - pb;
  });
};

function readPriceFromValue(value, vehicle, depth = 0, visited = new WeakSet()) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "number" || typeof value === "string") return toNum(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = readPriceFromValue(entry, vehicle, depth + 1, visited);
      if (nested != null) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (visited.has(value)) return null;
  visited.add(value);

  const vehicleNodeValue = findVehicleNestedValue(value, vehicle);
  if (vehicleNodeValue != null) {
    const fromVehicleNode = readPriceFromValue(vehicleNodeValue, vehicle, depth + 1, visited);
    if (fromVehicleNode != null) return fromVehicleNode;
  }

  const vehicleSpecific = readObjectByKeys(value, VEHICLE_PRICE_KEYS[vehicle] || []);
  if (vehicleSpecific != null) return vehicleSpecific;

  const generic = readObjectByKeys(value, GENERIC_PRICE_KEYS);
  if (generic != null) return generic;

  for (const [key, nestedValue] of sortedNestedEntries(value)) {
    if (METADATA_KEYS.has(normalizeKeyToken(key))) continue;
    const nested = readPriceFromValue(nestedValue, vehicle, depth + 1, visited);
    if (nested != null) return nested;
  }

  return null;
}

const getObjectDomain = (obj) => {
  if (!obj || typeof obj !== "object") return "";
  return canonicalizeServiceDomain(obj.service_domain || obj.service_name || obj.service);
};

const normalizeVehicleHint = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const canonical = canonicalizeVehicleFamily(raw);
  if (["bike", "car", "commercial", "ev"].includes(canonical)) return canonical;
  const token = normalizeKeyToken(raw);
  if (token.includes("2w")) return "bike";
  if (token.includes("4w")) return "car";
  return "";
};

const getEntryVehicleMatchState = (entry, vehicle) => {
  if (!entry || typeof entry !== "object" || !vehicle) return null;
  const hints = [
    entry.vehicle_type_pricing,
    entry.vehicle_type,
    entry.vehicle,
    entry.vehicle_category
  ];
  for (const hint of hints) {
    const normalized = normalizeVehicleHint(hint);
    if (!normalized) continue;
    return normalized === vehicle;
  }
  return null;
};

function readDomainScopedAmount(source, domain, vehicle, depth = 0, visited = new WeakSet()) {
  if (depth > 8 || source == null) return null;
  if (typeof source === "number" || typeof source === "string") return toNum(source);

  if (Array.isArray(source)) {
    const scoped = source.filter((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const entryDomain = getObjectDomain(entry);
      return !!entryDomain && entryDomain === domain;
    });

    const vehicleScoped = scoped.filter((entry) => getEntryVehicleMatchState(entry, vehicle) === true);
    for (const entry of vehicleScoped) {
      const amount = readPriceFromValue(entry, vehicle, depth + 1, visited);
      if (amount != null) return amount;
    }

    const compatibleScoped = scoped.filter((entry) => getEntryVehicleMatchState(entry, vehicle) !== false);
    for (const entry of compatibleScoped) {
      const amount = readPriceFromValue(entry, vehicle, depth + 1, visited);
      if (amount != null) return amount;
    }

    for (const entry of source) {
      const amount = readDomainScopedAmount(entry, domain, vehicle, depth + 1, visited);
      if (amount != null) return amount;
    }
    return null;
  }

  if (typeof source !== "object") return null;
  if (visited.has(source)) return null;
  visited.add(source);

  const scopedDomain = getObjectDomain(source);
  if (scopedDomain && scopedDomain !== domain) return null;

  for (const [key, value] of Object.entries(source)) {
    if (canonicalizeServiceDomain(key) !== domain) continue;
    const amount = readDomainScopedAmount(value, domain, vehicle, depth + 1, visited);
    if (amount != null) return amount;
  }

  const direct = readPriceFromValue(source, vehicle, depth + 1, new WeakSet());
  if (direct != null) return direct;

  for (const [key, value] of sortedNestedEntries(source)) {
    if (METADATA_KEYS.has(normalizeKeyToken(key))) continue;
    const amount = readDomainScopedAmount(value, domain, vehicle, depth + 1, visited);
    if (amount != null) return amount;
  }

  return null;
}

function fromTechnicianPricing(tech, domain, vehicle) {
  const serviceCosts = safeParse(tech?.service_costs);
  const pricing = safeParse(tech?.pricing);

  for (const source of [serviceCosts, pricing]) {
    const amount = readDomainScopedAmount(source, domain, vehicle);
    if (amount != null) return amount;
  }

  return null;
}

export function estimateRequestAmount({ service_type, vehicle_type }, tech = null) {
  const domain = canonicalizeServiceDomain(String(service_type || "").replace(/^(car|bike|ev|commercial)-/i, ""));
  const vehicle = canonicalizeVehicleFamily(vehicle_type || String(service_type || "").split("-")[0]);
  if (!domain || !vehicle) return null;

  const techAmount = tech ? fromTechnicianPricing(tech, domain, vehicle) : null;
  if (techAmount != null) return techAmount;
  return null;
}

export async function estimateRequestAmountAsync(
  { service_type, vehicle_type },
  tech = null,
  pricingConfig = null
) {
  const techAmount = estimateRequestAmount({ service_type, vehicle_type }, tech);
  if (techAmount != null) return techAmount;

  const config = pricingConfig || await getPlatformPricingConfig();
  return getServiceMatrixAmount(service_type, vehicle_type, config);
}
