import { getPool } from "../db.js";
import { calculateTechnicianServiceRowPayout, fromTechnicianPricing } from "./pricingEstimator.js";
import { computePaymentAmounts, getPlatformPricingConfig } from "./platformPricing.js";
import { canonicalizeVehicleFamily } from "./serviceNormalization.js";

// "Starts from" price per service for the customer home screen, taken from the rates
// approved technicians entered in the technician app. Each technician's price is computed
// the same way a real request is estimated (pricingEstimator); the cheapest one is then
// run through the checkout fee calculation so the figure matches what a customer pays.

export const HOME_SERVICES = ["towing", "flat-tire", "battery", "mechanical", "fuel", "lockout", "winching", "ev-charging"];
export const PRICE_VEHICLES = ["car", "bike", "commercial", "ev"];
const CACHE_TTL_MS = Math.max(60_000, Number(process.env.SERVICE_PRICE_CACHE_TTL_MS || 10 * 60 * 1000));
// Ignore obviously mistyped technician rates (e.g. ₹1) so they never become the "starts from" price.
const MIN_VALID_PRICE = Math.max(1, Number(process.env.SERVICE_PRICE_MIN_VALID || 30));

export function normalizePriceVehicle(value) {
  const vehicle = canonicalizeVehicleFamily(value || "car");
  return PRICE_VEHICLES.includes(vehicle) ? vehicle : null;
}

function pickServiceRow(rows, domain, vehicle) {
  let fallback = null;
  for (const row of rows) {
    if (row.service_domain !== domain) continue;
    const rowVehicle = String(row.vehicle_type || "");
    if (rowVehicle === vehicle) return row;
    if (!rowVehicle && !fallback) fallback = row;
  }
  return fallback;
}

/**
 * technicians: [{ id, service_costs, pricing }]
 * serviceRows: technician_services rows for those technicians.
 * pricingConfig: platform pricing config used at checkout (fees).
 * Returns one entry per service; startingPrice is null when no technician prices it.
 */
export function computeServicePrices({ technicians, serviceRows, vehicle, pricingConfig, services = HOME_SERVICES }) {
  const rowsByTechnician = new Map();
  for (const row of serviceRows || []) {
    const list = rowsByTechnician.get(Number(row.technician_id)) || [];
    list.push(row);
    rowsByTechnician.set(Number(row.technician_id), list);
  }

  return services.map((service) => {
    const prices = [];
    for (const tech of technicians || []) {
      const row = pickServiceRow(rowsByTechnician.get(Number(tech.id)) || [], service, vehicle);
      const price = row ? calculateTechnicianServiceRowPayout(row, vehicle) : fromTechnicianPricing(tech, service, vehicle);
      if (Number.isFinite(price) && price >= MIN_VALID_PRICE) prices.push(price);
    }
    if (!prices.length) {
      return { service, startingPrice: null, technicianMinimum: null, average: null, technicians: 0 };
    }
    const minimum = Math.min(...prices);
    const total = prices.reduce((sum, value) => sum + value, 0);
    return {
      service,
      startingPrice: Math.ceil(computePaymentAmounts(minimum, pricingConfig).totalAmount),
      technicianMinimum: Math.round(minimum),
      average: Math.round(total / prices.length),
      technicians: prices.length,
    };
  });
}

export function createServicePriceLoader({
  getPoolFn = getPool,
  getPricingConfig = () => getPlatformPricingConfig(),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  return async function getServicePrices({ vehicle: rawVehicle } = {}) {
    const vehicle = normalizePriceVehicle(rawVehicle);
    if (!vehicle) {
      const error = new Error("vehicle must be one of car, bike, commercial or ev.");
      error.statusCode = 400;
      throw error;
    }

    const cached = cache.get(vehicle);
    if (cached && cached.expiresAt > now()) return cached.value;

    const pool = await getPoolFn();
    const [technicians] = await pool.query(
      "SELECT id, service_costs, pricing FROM technicians WHERE LOWER(COALESCE(status, '')) = 'approved'"
    );
    let serviceRows = [];
    if (technicians.length) {
      const [rows] = await pool.query(
        "SELECT * FROM technician_services WHERE technician_id IN (?) AND service_domain IN (?)",
        [technicians.map((tech) => tech.id), HOME_SERVICES]
      );
      serviceRows = rows;
    }
    const pricingConfig = await getPricingConfig();

    const value = {
      vehicle,
      currency: String(pricingConfig?.currency || "INR").toUpperCase(),
      includesFees: true,
      services: computeServicePrices({ technicians, serviceRows, vehicle, pricingConfig }),
      generatedAt: new Date(now()).toISOString(),
    };
    cache.set(vehicle, { value, expiresAt: now() + CACHE_TTL_MS });
    return value;
  };
}

export const getServicePrices = createServicePriceLoader();
