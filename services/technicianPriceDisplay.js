import {
  normalizeTechnicianPricingEntries,
} from "../models/technicianPricing.js";
import {
  canonicalizeServiceDomain,
  canonicalizeVehicleFamily,
} from "./serviceNormalization.js";

const toNonNegativeNumber = (value) => {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const roundMoney = (value) => Number(Number(value).toFixed(2));

const safeParseObject = (value) => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeDisplayRow = (row) => {
  if (!row || typeof row !== "object") return null;
  const metadata = safeParseObject(row.metadata);
  const [normalized] = normalizeTechnicianPricingEntries([
    {
      ...metadata,
      ...row,
      metadata,
    },
  ]);
  return normalized || null;
};

export function indexTechnicianPricingRows(rows) {
  const index = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const technicianId = Number(row?.technician_id);
    if (!Number.isInteger(technicianId) || technicianId <= 0) return;
    const currentRows = index.get(technicianId) || [];
    currentRows.push(row);
    index.set(technicianId, currentRows);
  });
  return index;
}

export function resolveTechnicianDisplayPrice(rows, { serviceType, vehicleType }) {
  const serviceDomain = canonicalizeServiceDomain(serviceType);
  const vehicleFamily = canonicalizeVehicleFamily(vehicleType);
  if (!serviceDomain || !vehicleFamily) return null;

  const normalizedRow = (Array.isArray(rows) ? rows : [])
    .map(normalizeDisplayRow)
    .find(
      (row) =>
        row?.service_domain === serviceDomain &&
        canonicalizeVehicleFamily(row?.vehicle_type) === vehicleFamily
    );

  if (!normalizedRow) return null;

  const baseResult = {
    service_domain: serviceDomain,
    vehicle_type: vehicleFamily,
  };

  if (serviceDomain === "flat-tire") {
    const visitCharge = toNonNegativeNumber(normalizedRow.visit_charge);
    const puncturePrice = toNonNegativeNumber(normalizedRow.service_charge);
    if (visitCharge == null || puncturePrice == null) return null;
    return {
      price: roundMoney(visitCharge + puncturePrice),
      ...baseResult,
      breakdown: {
        visit_charge: visitCharge,
        puncture_price: puncturePrice,
      },
    };
  }

  if (serviceDomain === "fuel") {
    const deliveryCharge = toNonNegativeNumber(normalizedRow.delivery_charge);
    if (deliveryCharge == null) return null;
    return {
      price: roundMoney(deliveryCharge),
      ...baseResult,
      breakdown: { delivery_charge: deliveryCharge },
    };
  }

  if (serviceDomain === "towing") {
    const basePrice = toNonNegativeNumber(
      normalizedRow.base_price ?? normalizedRow.service_charge
    );
    if (basePrice == null) return null;
    return {
      price: roundMoney(basePrice),
      ...baseResult,
      breakdown: { base_price: basePrice },
    };
  }

  const serviceCharge = toNonNegativeNumber(normalizedRow.service_charge);
  const visitCharge = toNonNegativeNumber(normalizedRow.visit_charge) ?? 0;
  if (serviceCharge == null) return null;
  return {
    price: roundMoney(serviceCharge + visitCharge),
    ...baseResult,
    breakdown: {
      service_charge: serviceCharge,
      visit_charge: visitCharge,
    },
  };
}
