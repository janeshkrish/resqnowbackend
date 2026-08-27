import { canonicalizeServiceDomain, canonicalizeVehicleFamily } from "../services/serviceNormalization.js";

const ENGINE_TO_STORED_SERVICE_TYPE = Object.freeze({
  towing: "towing",
  flat_tire: "flat-tire",
  battery_jumpstart: "battery",
  lockout: "lockout",
  fuel_delivery: "fuel",
  mechanical: "mechanical",
});

const STORED_TO_ENGINE_SERVICE_TYPE = Object.freeze(
  Object.fromEntries(
    Object.entries(ENGINE_TO_STORED_SERVICE_TYPE).map(([engineType, storedType]) => [storedType, engineType])
  )
);

const VALID_NIGHT_TYPES = new Set(["flat", "percentage"]);
const SUPPORTED_VEHICLE_TYPES = new Set(["bike", "car", "commercial", "ev"]);
const RESERVED_NESTED_PRICING_KEYS = new Set([
  "service",
  "service_name",
  "service_domain",
  "serviceType",
  "service_type",
  "domain",
  "vehicle_categories",
  "vehicle_category",
  "vehicle_type",
  "vehicleType",
  "vehicle_type_pricing",
  "vehicle_pricing",
  "towing_vehicle_pricing",
  "flat_tire_vehicle_pricing",
  "towing_fleet_types",
  "default_tow_truck_type",
  "fleet_pricing",
  "metadata",
]);

const firstPresent = (...values) => {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return null;
};

const safeParseJson = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
};

const toNullableNumber = (value) => {
  if (value == null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeNightType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_NIGHT_TYPES.has(normalized) ? normalized : null;
};

const normalizeStoredVehicleType = (value) => {
  const canonical = canonicalizeVehicleFamily(value);
  if (canonical) return canonical;
  return String(value || "").trim().toLowerCase();
};

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const getFlatTirePuncturePrices = (row) => {
  const subcategories = isPlainObject(row?.subcategories) ? row.subcategories : {};
  const selectedSubcategories = Array.isArray(row?.selected_subcategories)
    ? row.selected_subcategories.map((value) => String(value || "").trim()).filter(Boolean)
    : Object.keys(subcategories);

  const prices = [];
  selectedSubcategories.forEach((subcategoryId) => {
    const subcategory = subcategories[subcategoryId];
    if (!isPlainObject(subcategory)) return;

    [subcategory.tube_tyre_price, subcategory.tubeless_price].forEach((value) => {
      const price = toNullableNumber(value);
      if (price != null && price >= 0) prices.push(price);
    });
  });

  return prices;
};

const getDirectVehiclePricingMap = (row) => {
  if (!isPlainObject(row)) return {};

  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) => {
      if (RESERVED_NESTED_PRICING_KEYS.has(key)) return false;
      const vehicleType = normalizeStoredVehicleType(key);
      return SUPPORTED_VEHICLE_TYPES.has(vehicleType) && isPlainObject(value);
    })
  );
};

const getNestedVehiclePricingMap = (row) => {
  if (!isPlainObject(row)) return {};
  if (isPlainObject(row.towing_vehicle_pricing)) return row.towing_vehicle_pricing;
  if (isPlainObject(row.flat_tire_vehicle_pricing)) return row.flat_tire_vehicle_pricing;
  if (isPlainObject(row.vehicle_pricing)) return row.vehicle_pricing;
  return getDirectVehiclePricingMap(row);
};

const expandNestedVehiclePricingRows = (row) => {
  const nestedVehiclePricing = getNestedVehiclePricingMap(row);
  const nestedKeys = Object.keys(nestedVehiclePricing);
  if (nestedKeys.length === 0) return [];

  const rawVehicleCategories = Array.isArray(row?.vehicle_categories)
    ? row.vehicle_categories
    : nestedKeys;

  const vehicleCategories = rawVehicleCategories
    .map((vehicleType) => normalizeStoredVehicleType(vehicleType))
    .filter((vehicleType) => SUPPORTED_VEHICLE_TYPES.has(vehicleType));

  return vehicleCategories
    .map((vehicleType) => {
      const vehiclePricing = nestedVehiclePricing[vehicleType];
      if (!isPlainObject(vehiclePricing)) return null;

      return {
        ...row,
        ...vehiclePricing,
        vehicle_type: vehicleType,
        vehicle_category: vehicleType,
      };
    })
    .filter(Boolean);
};

const normalizeRawEntries = (value) => {
  const parsed = safeParseJson(value, value);
  const rows = [];

  if (Array.isArray(parsed)) {
    parsed.forEach((entry) => {
      const expandedRows = expandNestedVehiclePricingRows(entry);
      if (expandedRows.length > 0) {
        rows.push(...expandedRows);
      } else {
        rows.push(entry);
      }
    });
  } else if (parsed && typeof parsed === "object") {
    Object.entries(parsed).forEach(([serviceName, config]) => {
      if (config && typeof config === "object") {
        const baseRow = { service_name: serviceName, service_domain: serviceName, ...config };
        const expandedRows = expandNestedVehiclePricingRows(baseRow);
        if (expandedRows.length > 0) {
          rows.push(...expandedRows);
        } else {
          rows.push(baseRow);
        }
      } else {
        rows.push({ service_name: serviceName, service_charge: config });
      }
    });
  }

  return rows;
};

const hasPricingValue = (entry) => [
  entry.visit_charge,
  entry.service_charge,
  entry.extra_km_charge,
  entry.labour_min,
  entry.labour_max,
  entry.delivery_charge,
  entry.price_2w_min,
  entry.price_2w_max,
  entry.price_4w_min,
  entry.price_4w_max,
  entry.base_price,
  entry.free_km,
  entry.per_km_price,
  entry.night_charge,
].some((value) => value != null);

const normalizeTechnicianPricingEntry = (input) => {
  const row = input && typeof input === "object" ? input : {};
  const storedServiceDomain = toStoredPricingServiceDomain(
    row.service_domain ||
      row.service_name ||
      row.serviceType ||
      row.service_type ||
      row.service ||
      row.domain
  );

  if (!storedServiceDomain) {
    return null;
  }

  const vehicleType = normalizeStoredVehicleType(
    row.vehicle_type_pricing ||
      row.vehicle_type ||
      row.vehicleType ||
      row.vehicle ||
      row.vehicle_category
  );

  const basePrice = toNullableNumber(
    firstPresent(
      row.base_price,
      row.basePrice,
      row.base_charge,
      row.baseCharge,
      row.service_charge,
      row.serviceCharge,
      row.amount,
      row.price
    )
  );
  const perKmPrice = toNullableNumber(
    firstPresent(row.per_km_price, row.perKmPrice, row.extra_km_charge, row.extraKmCharge)
  );
  const visitCharge = toNullableNumber(
    firstPresent(
      row.visit_charge,
      row.visitCharge,
      storedServiceDomain === "towing" ? null : row.base_charge,
      storedServiceDomain === "towing" ? null : row.baseCharge
    )
  );
  const flatTirePuncturePrices = storedServiceDomain === "flat-tire"
    ? getFlatTirePuncturePrices(row)
    : [];
  const flatTireMinimumPrice = flatTirePuncturePrices.length > 0
    ? Math.min(...flatTirePuncturePrices)
    : null;
  const serviceCharge = toNullableNumber(
    firstPresent(row.service_charge, row.serviceCharge, row.amount, row.price, flatTireMinimumPrice)
  );
  const nightCharge = toNullableNumber(firstPresent(row.night_charge, row.nightCharge));
  const nightType = normalizeNightType(
    firstPresent(row.night_type, row.nightType, row.night_charge_type, row.nightChargeType)
  );

  const normalizedEntry = {
    service_domain: storedServiceDomain,
    vehicle_type: vehicleType,
    visit_charge: visitCharge,
    service_charge: storedServiceDomain === "towing" ? (serviceCharge ?? basePrice) : serviceCharge,
    extra_km_charge: perKmPrice,
    labour_min: toNullableNumber(firstPresent(row.labour_min, row.labourMin)),
    labour_max: toNullableNumber(firstPresent(row.labour_max, row.labourMax)),
    delivery_charge: toNullableNumber(firstPresent(row.delivery_charge, row.deliveryCharge)),
    price_2w_min: toNullableNumber(firstPresent(row.price_2w_min, row.price2wmin, row.price_2w)),
    price_2w_max: toNullableNumber(firstPresent(row.price_2w_max, row.price2wmax)),
    price_4w_min: toNullableNumber(firstPresent(row.price_4w_min, row.price4wmin, row.price_4w)),
    price_4w_max: toNullableNumber(firstPresent(row.price_4w_max, row.price4wmax)),
    base_price: basePrice,
    free_km: toNullableNumber(firstPresent(row.free_km, row.freeKm, row.free_distance, row.freeDistance)),
    per_km_price: perKmPrice,
    night_charge: nightCharge,
    night_type: nightType,
    metadata: row,
  };

  return hasPricingValue(normalizedEntry) ? normalizedEntry : null;
};

export const SUPPORTED_PRICING_SERVICE_TYPES = Object.freeze(Object.keys(ENGINE_TO_STORED_SERVICE_TYPE));

export function normalizePricingServiceType(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (ENGINE_TO_STORED_SERVICE_TYPE[raw]) {
    return raw;
  }

  const storedDomain = canonicalizeServiceDomain(raw);
  return STORED_TO_ENGINE_SERVICE_TYPE[storedDomain] || "";
}

export function toStoredPricingServiceDomain(value) {
  const normalized = normalizePricingServiceType(value);
  if (normalized) {
    return ENGINE_TO_STORED_SERVICE_TYPE[normalized];
  }

  return canonicalizeServiceDomain(value);
}

export function normalizePricingVehicleType(value) {
  return normalizeStoredVehicleType(value);
}

export function normalizeTechnicianPricingEntries(value) {
  return normalizeRawEntries(value).map(normalizeTechnicianPricingEntry).filter(Boolean);
}

export function findTechnicianPricingEntry(entries, { serviceType, vehicleType }) {
  const storedServiceDomain = toStoredPricingServiceDomain(serviceType);
  const normalizedVehicleType = normalizePricingVehicleType(vehicleType);
  if (!storedServiceDomain || !normalizedVehicleType) {
    return null;
  }

  const list = Array.isArray(entries) ? entries : normalizeTechnicianPricingEntries(entries);
  const matches = list.filter(
    (entry) =>
      entry.service_domain === storedServiceDomain &&
      (entry.vehicle_type === normalizedVehicleType || entry.vehicle_type === "")
  );

  matches.sort((left, right) => {
    const leftScore = left.vehicle_type === normalizedVehicleType ? 0 : 1;
    const rightScore = right.vehicle_type === normalizedVehicleType ? 0 : 1;
    return leftScore - rightScore;
  });

  return matches[0] || null;
}

export function mapStoredPricingRowToTechnicianPricing(row, requestedServiceType = row?.service_domain) {
  const serviceType = normalizePricingServiceType(requestedServiceType || row?.service_domain);
  if (!serviceType) {
    return null;
  }

  const metadata = safeParseJson(row?.metadata, {}) || {};
  const nightCharge = toNullableNumber(
    firstPresent(row?.night_charge, metadata?.night_charge, metadata?.nightCharge)
  );
  const nightType = normalizeNightType(
    firstPresent(
      row?.night_type,
      metadata?.night_type,
      metadata?.nightType,
      metadata?.night_charge_type,
      metadata?.nightChargeType
    )
  );

  if (serviceType === "towing") {
    return {
      base_price: toNullableNumber(
        firstPresent(row?.base_price, metadata?.base_price, metadata?.basePrice, row?.service_charge)
      ),
      free_km: toNullableNumber(
        firstPresent(row?.free_km, metadata?.free_km, metadata?.freeKm, metadata?.free_distance, metadata?.freeDistance)
      ),
      per_km_price: toNullableNumber(
        firstPresent(
          row?.per_km_price,
          metadata?.per_km_price,
          metadata?.perKmPrice,
          row?.extra_km_charge,
          metadata?.extra_km_charge,
          metadata?.extraKmCharge
        )
      ),
      night_charge: nightCharge ?? 0,
      night_type: nightType,
      tow_truck_types: Array.isArray(metadata?.tow_truck_types) ? metadata.tow_truck_types : [],
      default_tow_truck_type: firstPresent(
        metadata?.default_tow_truck_type,
        metadata?.defaultTowTruckType
      ),
      fleet_pricing:
        metadata?.fleet_pricing && typeof metadata.fleet_pricing === "object"
          ? metadata.fleet_pricing
          : null,
      vehicle_type: normalizePricingVehicleType(
        firstPresent(row?.vehicle_type, metadata?.vehicle_type, metadata?.vehicleType, metadata?.vehicle)
      ),
    };
  }

  return {
    service_charge: toNullableNumber(
      firstPresent(row?.service_charge, metadata?.service_charge, metadata?.serviceCharge, metadata?.amount, metadata?.price)
    ),
    visit_charge: toNullableNumber(
      firstPresent(row?.visit_charge, metadata?.visit_charge, metadata?.visitCharge, metadata?.base_charge, metadata?.baseCharge)
    ),
    free_distance: toNullableNumber(
      firstPresent(row?.free_km, metadata?.free_km, metadata?.freeKm, metadata?.free_distance, metadata?.freeDistance)
    ),
    extra_km_charge: toNullableNumber(
      firstPresent(
        row?.extra_km_charge,
        metadata?.extra_km_charge,
        metadata?.extraKmCharge,
        row?.per_km_price,
        metadata?.per_km_price,
        metadata?.perKmPrice
      )
    ),
    night_charge: nightCharge ?? 0,
    night_type: nightType,
  };
}
