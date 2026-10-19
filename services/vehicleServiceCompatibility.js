import { recordId, isRecordId } from "../models/identifiers.js";
import { canonicalizeServiceDomain, canonicalizeVehicleFamily, normalizeText, parseVehicleTypes } from './serviceNormalization.js';
import { normalizeVehicleSubtype, pricingSubcategoryFor } from './vehicleClasses.js';
import { answerValue, readRequestDetails } from './requestDetails.js';
import { normalizeTechnicianPricingEntries } from '../models/technicianPricing.js';

const SHARED_SERVICES = new Set(['flat-tire', 'lockout', 'towing']);
const CHASSIS_SYMPTOMS = new Set(['brakes', 'suspension', 'wheel', 'wheels', 'tyre', 'tire', 'steering']);

export function getVehicleServicePolicy(request = {}) {
  const rawService = String(request.service_type ?? request.serviceType ?? '').trim();
  const service = canonicalizeServiceDomain(rawService === 'ev-charging' ? rawService : rawService.replace(/^(car|bike|ev|commercial)-/i, ''));
  const rawVehicle = request.vehicle_type ?? request.vehicleType ?? rawService.split('-')[0];
  const rawSubtype = request.vehicle_subtype ?? request.vehicleSubtype;
  const electricSubtype = /\b(?:electric|ev)\b/.test(normalizeText(rawSubtype));
  const family = electricSubtype ? 'ev' : canonicalizeVehicleFamily(rawVehicle);
  const subtype = normalizeVehicleSubtype(family, rawSubtype) || (family === 'ev' ? normalizeVehicleSubtype('ev', rawVehicle) : null);
  const physical = {
    'electric-scooter': ['bike', 'scooter'], 'electric-bike': ['bike', 'bike'],
    'electric-car': ['car', 'car'], 'electric-suv': ['car', 'suv'],
  }[subtype];
  const details = readRequestDetails(request.request_details_json ?? request.requestDetails ?? request.details);
  const allowedBodies = {
    'electric-scooter': ['scooter'], 'electric-bike': ['commuter-bike', 'sports-bike', 'premium-bike'],
    'electric-car': ['hatchback', 'sedan'], 'electric-suv': ['compact-suv', 'big-suv'],
  }[subtype] ?? [];
  const bodyHint = details.vehicle_base_subtype ?? normalizeVehicleSubtype(physical?.[0], rawSubtype);
  const baseSubtype = allowedBodies.includes(bodyHint) ? bodyHint : null;
  const scope = answerValue(details, 'mechanical_scope');
  const symptoms = [answerValue(details, 'issue'), answerValue(details, 'ev_issue')].flatMap(value => Array.isArray(value) ? value : value ? [value] : []);
  const chassisOnly = scope === 'chassis' && symptoms.every(value => CHASSIS_SYMPTOMS.has(value));
  const canShare = family === 'ev' && (SHARED_SERVICES.has(service) || (service === 'mechanical' && chassisOnly));
  const pricingCandidates = [{ vehicle_type: family, vehicle_subtype: subtype ?? rawSubtype ?? null,
    vehicle_base_subtype: baseSubtype, shared: false }];
  if (canShare && physical) pricingCandidates.push({ vehicle_type: physical[0], vehicle_subtype: baseSubtype || physical[1], shared: true });
  let invalidCode = null;
  if (family === 'ev' && service === 'fuel') invalidCode = 'ev_fuel_not_supported';
  if (service === 'ev-charging' && family !== 'ev') invalidCode = 'ev_vehicle_required';
  return { service, family, subtype, physicalFamily: physical?.[0] ?? null, physicalSubtype: baseSubtype || physical?.[1] || null,
    canShare, allowedFamilies: pricingCandidates.map(value => value.vehicle_type), pricingCandidates, invalidCode,
    details, connector: answerValue(details, 'port'), brand: request.vehicle_brand ?? request.vehicleBrand ?? '' };
}

/** Vehicle compatibility is deliberate per service; the stored EV identity is never changed. */
export function evaluateVehicleServiceSupport(request, technician) {
  const policy = getVehicleServicePolicy(request);
  if (policy.invalidCode) return { eligible: false, code: policy.invalidCode, policy };
  const vehicles = technician?.vehicle_types == null ? [] : parseVehicleTypes(technician.vehicle_types);
  const eligible = vehicles.some(vehicle => policy.allowedFamilies.includes(vehicle));
  if (!eligible) return { eligible: false, code: vehicles.length ? 'vehicle_mismatch' : 'vehicle_profile_missing', policy };
  if (policy.service === 'ev-charging') {
    const charging = chargingCompatibility(request);
    if (!charging.eligible) return { ...charging, policy };
    const rows = technician.service_pricing_rows?.length ? technician.service_pricing_rows : normalizeTechnicianPricingEntries(technician.service_costs);
    const candidate = policy.pricingCandidates[0];
    const compatible = rows.filter(row => canonicalizeServiceDomain(row.service_domain) === 'ev-charging' &&
        canonicalizeVehicleFamily(row.vehicle_type) === 'ev')
      .some(row => {
        const context = pricingSubtypeContext(row, candidate, true);
        return context.eligible && chargingCompatibility(request, { metadata: context.hasSubcategories ? context.subcategory : context.metadata }).eligible;
      });
    if (!compatible) return { eligible: false, code: 'ev_charging_compatibility_missing', policy };
  }
  return { eligible: true, code: null, policy };
}

/** One bounded read before ranking chargers prevents incompatible providers filling the shortlist. */
export async function loadChargingServiceProfiles(executor, request, technicians) {
  if (getVehicleServicePolicy(request).service !== 'ev-charging' || !technicians.length) return technicians;
  const ids = technicians.map(tech => recordId(tech.id)).filter(id => isRecordId(id));
  if (!ids.length) return technicians;
  const [rows] = await executor.query(`SELECT * FROM technician_services WHERE service_domain = 'ev-charging' AND technician_id IN (${ids.map(() => '?').join(',')})`, ids);
  return technicians.map(tech => ({ ...tech, service_pricing_rows: (rows || []).filter(row => recordId(row.technician_id) === recordId(tech.id)) }));
}

export function readPricingMetadata(value) {
  const seen = new Set();
  let result = {};
  while (value && !seen.has(value)) {
    seen.add(value);
    try { if (typeof value === 'string') value = JSON.parse(value); } catch { break; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) break;
    result = { ...value, ...result };
    value = value.metadata;
  }
  return result;
}

export function pricingSubtypeContext(row, candidate, requireKnownSubtype = false) {
  const metadata = readPricingMetadata(row.metadata);
  const subtype = candidate.vehicle_subtype;
  const aliases = [candidate.vehicle_base_subtype, ...({
    'electric-scooter': ['electric-scooter', 'scooter'], 'electric-bike': ['electric-bike', 'bike'],
    'electric-car': ['electric-car', 'car'], 'electric-suv': ['electric-suv', 'suv', 'car'],
  }[subtype] ?? [subtype, pricingSubcategoryFor(subtype)])];
  const key = aliases.find(value => value && metadata.subcategories?.[value]);
  const hasSubcategories = Boolean(metadata.subcategories && Object.keys(metadata.subcategories).length);
  return { metadata, key, subcategory: metadata.subcategories?.[key], hasSubcategories,
    eligible: !hasSubcategories || (!(subtype || requireKnownSubtype)) || Boolean(key) };
}

// Parent monetary columns can summarize several subtypes; only the common visit fee
// may be inherited when a specific subtype supplies its own tariff.
const SUBTYPE_PRICE_FIELDS = ['service_charge', 'labour_min', 'labour_max', 'delivery_charge',
  'price_2w_min', 'price_2w_max', 'price_4w_min', 'price_4w_max', 'tube_tyre_price', 'tubeless_price'];
export function hasSubtypeTariff(context) {
  if (!context.hasSubcategories || !context.key) return true;
  return [...SUBTYPE_PRICE_FIELDS, 'visit_charge'].some(field => context.subcategory?.[field] != null &&
    String(context.subcategory[field]).trim() !== '');
}
export function applyStandardPricingSubtype(row, context) {
  if (!context.hasSubcategories || !context.key) return row;
  return { ...row, ...Object.fromEntries(SUBTYPE_PRICE_FIELDS.map(field => [field, undefined])),
    ...context.subcategory, metadata: context.metadata };
}

const tokens = value => (Array.isArray(value) ? value : String(value || '').split(/[,;|]/)).map(normalizeText).filter(Boolean);
const brandKey = value => normalizeText(value).replace(/\b(?:motors?|electric|energy)\b/g, '').replace(/\s+/g, ' ').trim();

/** A generic EV registration cannot imply that every charging connector is supported. */
export function chargingCompatibility(request, pricing = null) {
  const policy = getVehicleServicePolicy(request);
  if (policy.service !== 'ev-charging') return { eligible: true, code: null };
  if (policy.invalidCode) return { eligible: false, code: policy.invalidCode };
  if (!['ccs2', 'type2', 'home', 'brand'].includes(policy.connector)) return { eligible: false, code: 'ev_connector_required' };
  if (policy.connector === 'brand' && !brandKey(policy.brand)) return { eligible: false, code: 'ev_brand_required' };
  if (!pricing) return { eligible: true, code: null };
  const metadata = readPricingMetadata(pricing.metadata ?? pricing);
  const capabilities = { ...metadata, ...pricing };
  if (!tokens(capabilities.supported_connectors).includes(policy.connector)) return { eligible: false, code: 'ev_connector_mismatch' };
  if (policy.connector === 'brand' && (!brandKey(policy.brand) ||
      !tokens(capabilities.supported_ev_brands).some(brand => brandKey(brand) === brandKey(policy.brand)))) {
    return { eligible: false, code: 'ev_brand_mismatch' };
  }
  return { eligible: true, code: null };
}
