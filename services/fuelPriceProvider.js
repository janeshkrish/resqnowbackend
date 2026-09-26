import axios from "axios";

// Indian API "Fuel Price API" (https://indianapi.in/fuel-price-api).
//   GET https://fuel.indianapi.in/live_fuel_price?fuel_type=petrol|diesel&location_type=city
//   header x-api-key
//   -> [{ "city": "Coimbatore", "price": "100.90", "change": "+0.14" }, ...]
// One call returns every city for one fuel, so a daily sync costs two requests.

export const PROVIDER_FUELS = ["petrol", "diesel"];
const DEFAULT_BASE_URL = "https://fuel.indianapi.in";
const PLAUSIBLE_RANGE = { petrol: [50, 250], diesel: [50, 250] };

export function parsePriceNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "").replace(/\/.*$/, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function parseSignedNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[₹,\s]/g, "").replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Turn a live_fuel_price response into [{ areaName, price, change }], dropping bad rows. */
export function normalizeLivePriceRows(payload, fuel) {
  const range = PLAUSIBLE_RANGE[fuel];
  if (!Array.isArray(payload) || !range) return [];
  const rows = [];
  for (const entry of payload) {
    const areaName = String(entry?.city ?? entry?.name ?? entry?.state ?? "").trim();
    const price = parsePriceNumber(entry?.price);
    if (!areaName || price == null || price < range[0] || price > range[1]) continue;
    const change = parseSignedNumber(entry?.change);
    rows.push({
      areaName,
      price: Math.round(price * 100) / 100,
      change: change == null || Math.abs(change) > 50 ? null : Math.round(change * 100) / 100,
    });
  }
  return rows;
}

export function getProviderConfig(env = process.env) {
  const kind = String(env.FUEL_PRICE_PROVIDER || "indianapi").trim().toLowerCase();
  const apiKey = String(env.FUEL_PRICE_API_KEY || "").trim();
  if (kind !== "indianapi" || !apiKey) return null;
  return {
    name: "indianapi",
    baseUrl: String(env.FUEL_PRICE_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey,
    timeoutMs: Math.max(3000, Number(env.FUEL_PRICE_API_TIMEOUT_MS || 15000)),
  };
}

/** Today's city prices for one fuel. Throws on HTTP or network failure. */
export async function fetchLiveCityPrices(fuel, { config = getProviderConfig(), http = axios } = {}) {
  if (!config) throw new Error("Fuel price provider is not configured.");
  const response = await http.get(`${config.baseUrl}/live_fuel_price`, {
    timeout: config.timeoutMs,
    params: { fuel_type: fuel, location_type: "city" },
    headers: { Accept: "application/json", "x-api-key": config.apiKey },
  });
  return normalizeLivePriceRows(response?.data, fuel);
}
