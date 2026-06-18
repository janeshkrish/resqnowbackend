import {
  canonicalizeServiceDomain,
  normalizeSpecialties,
} from "./serviceNormalization.js";

const safeParse = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const normalizeServicesInput = (value) => {
  const parsed = safeParse(value, value);
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "string"
      ? parsed.split(",")
      : [];
  return normalizeSpecialties(list);
};

const toServiceCostRows = (value) => {
  const parsed = safeParse(value, []);
  if (Array.isArray(parsed)) {
    return parsed.filter((entry) => entry && typeof entry === "object");
  }
  if (!parsed || typeof parsed !== "object") return [];

  return Object.entries(parsed).map(([serviceName, config]) => {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      return { service_name: serviceName, ...config };
    }
    return { service_name: serviceName, service_charge: config };
  });
};

export function normalizeTechnicianServiceConfiguration({
  services,
  serviceCosts,
  existingPrimaryService,
}) {
  const normalizedServices = normalizeServicesInput(services);
  const selectedServices = new Set(normalizedServices);
  const normalizedServiceCosts = toServiceCostRows(serviceCosts)
    .map((entry) => {
      const serviceDomain = canonicalizeServiceDomain(
        entry.service_domain || entry.service_name || entry.service
      );
      if (!serviceDomain || !selectedServices.has(serviceDomain)) return null;
      return {
        ...entry,
        service_name: serviceDomain,
        service_domain: serviceDomain,
      };
    })
    .filter(Boolean);

  const currentPrimaryService = canonicalizeServiceDomain(existingPrimaryService);
  const primaryService = selectedServices.has(currentPrimaryService)
    ? currentPrimaryService
    : normalizedServices[0] || "other";

  return {
    services: normalizedServices,
    primaryService,
    serviceCosts: normalizedServiceCosts,
  };
}
