import { recordId, isRecordId } from "../models/identifiers.js";
import {
  normalizeTechnicianPricingEntries,
} from "../models/technicianPricing.js";
import {
  canonicalizeServiceDomain,
  canonicalizeVehicleFamily,
} from "./serviceNormalization.js";
import { getVehicleServicePolicy, pricingSubtypeContext, chargingCompatibility, hasSubtypeTariff, applyStandardPricingSubtype } from './vehicleServiceCompatibility.js';
import { answerValue } from './requestDetails.js';

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
  ], { preserveInvalid: true });
  return normalized || null;
};

export function indexTechnicianPricingRows(rows) {
  const index = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const technicianId = recordId(row?.technician_id);
    if (!isRecordId(technicianId)) return;
    const currentRows = index.get(technicianId) || [];
    currentRows.push(row);
    index.set(technicianId, currentRows);
  });
  return index;
}

export function resolveTechnicianDisplayPrice(rows, { serviceType, vehicleType, vehicleSubtype, requestDetails, vehicleBrand }) {
  const serviceDomain = canonicalizeServiceDomain(serviceType);
  const vehicleFamily = canonicalizeVehicleFamily(vehicleType);
  if (!serviceDomain || !vehicleFamily) return null;

  const request = { service_type: serviceType, vehicle_type: vehicleType, vehicle_subtype: vehicleSubtype,
    request_details_json: requestDetails, vehicle_brand: vehicleBrand };
  const policy = getVehicleServicePolicy(request);
  if (policy.invalidCode) return null;
  const normalizedRows = (Array.isArray(rows) ? rows : []).map(normalizeDisplayRow).filter(Boolean);
  let normalizedRow = null;
  let selectedSubcategory = null;
  for (const candidate of policy.pricingCandidates) {
    const row = normalizedRows.find(row => row.service_domain === serviceDomain && canonicalizeVehicleFamily(row.vehicle_type) === candidate.vehicle_type &&
      pricingSubtypeContext(row, candidate, policy.family === 'ev').eligible);
    if (!row) continue;
    if (row._invalid_pricing) return null;
    const context = pricingSubtypeContext(row, candidate, policy.family === 'ev');
    if (!chargingCompatibility(request, { metadata: context.hasSubcategories ? context.subcategory : context.metadata }).eligible) return null;
    if (serviceDomain !== 'towing' && !hasSubtypeTariff(context)) return null;
    normalizedRow = serviceDomain === 'towing' ? { ...row, ...context.subcategory } : applyStandardPricingSubtype(row, context);
    selectedSubcategory = context.subcategory;
    break;
  }

  if (!normalizedRow) return null;

  const baseResult = {
    service_domain: serviceDomain,
    vehicle_type: vehicleFamily,
  };

  if (serviceDomain === "flat-tire") {
    const visitCharge = toNonNegativeNumber(normalizedRow.visit_charge);
    const tyreRow = selectedSubcategory || normalizedRow;
    const tyreType = answerValue(policy.details, 'tyretype');
    const tube = toNonNegativeNumber(tyreRow.tube_tyre_price);
    const tubeless = toNonNegativeNumber(tyreRow.tubeless_price);
    if ((tyreRow.tube_tyre_price != null && tube == null) || (tyreRow.tubeless_price != null && tubeless == null)) return null;
    const rates = [tube, tubeless].filter(value => value != null);
    const puncturePrice = tyreType === 'tube' ? tube ?? tubeless ?? toNonNegativeNumber(normalizedRow.service_charge)
      : tyreType === 'tubeless' ? tubeless ?? tube ?? toNonNegativeNumber(normalizedRow.service_charge)
      : rates.length ? Math.min(...rates) : toNonNegativeNumber(normalizedRow.service_charge);
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
      selectedSubcategory ? selectedSubcategory.base_price ?? selectedSubcategory.base_charge : normalizedRow.base_price ?? normalizedRow.service_charge
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
  const coreCharge = serviceCharge ?? toNonNegativeNumber(normalizedRow.labour_min);
  if (coreCharge == null) return null;
  return {
    price: roundMoney(coreCharge + visitCharge),
    ...baseResult,
    breakdown: {
      service_charge: coreCharge,
      visit_charge: visitCharge,
    },
  };
}
