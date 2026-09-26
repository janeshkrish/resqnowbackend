import { getPool } from "../db.js";
import { reverseGeocode } from "./locationProviderService.js";
import { PROVIDER_FUELS, fetchLiveCityPrices, getProviderConfig } from "./fuelPriceProvider.js";

// Daily retail fuel prices by location. Prices live in `fuel_prices` (one row per
// state/area/fuel/day) so we keep history for day-on-day changes. Rows come from:
//   - the daily provider sync (Indian API, petrol + diesel for every city; stored with
//     state_key "" because the provider lists cities without their state), and
//   - the admin panel (source "manual"), for CNG, EV charging or corrections.
// Customer requests only read the table, so the provider quota is spent once a day.

export const FUEL_TYPES = ["petrol", "diesel", "cng", "ev"];
export const FUEL_UNITS = { petrol: "litre", diesel: "litre", cng: "kg", ev: "kwh" };
const FUEL_LABELS = { petrol: "Petrol", diesel: "Diesel", cng: "CNG", ev: "EV charging" };
const MAX_PRICE = 1000;
const HISTORY_DAYS = 14;
const CACHE_TTL_MS = Math.max(30_000, Number(process.env.FUEL_PRICE_CACHE_TTL_MS || 15 * 60 * 1000));
// Oil companies revise prices at 06:00 IST; give the provider time to publish.
const SYNC_AFTER_IST_HOUR = Math.min(23, Math.max(0, Number(process.env.FUEL_PRICE_SYNC_AFTER_IST_HOUR || 7)));
const SYNC_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const SYNC_RETRY_MS = 3 * 60 * 60 * 1000;

export class FuelPriceError extends Error {
  constructor(message, statusCode = 400, code = "fuel_price_invalid") {
    super(message);
    this.name = "FuelPriceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function toAreaKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(district|city|corporation|municipal|urban|rural)\b/g, " ")
    .replace(/[^a-z]/g, "");
}

export function istDate(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function istHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)) % 24;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

/** City/district/state from a Nominatim reverse-geocode result. */
export function locationFromAddress(address = {}) {
  const areaName = String(
    address.city || address.town || address.municipality || address.city_district || address.village || ""
  ).trim();
  const districtName = String(address.state_district || address.county || address.district || "").trim();
  const stateName = String(address.state || "").trim();
  return buildLocation({ areaName: areaName || districtName, districtName, stateName });
}

export function buildLocation({ areaName = "", districtName = "", stateName = "" } = {}) {
  const stateKey = toAreaKey(stateName);
  const areaKeys = [...new Set([toAreaKey(areaName), toAreaKey(districtName)].filter(Boolean))];
  return {
    areaName: String(areaName || districtName || "").trim(),
    districtName: String(districtName || "").trim(),
    stateName: String(stateName || "").trim(),
    stateKey,
    areaKeys,
  };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Pick the most specific scope that has data (area keys in order, then the state-wide
 * row with area_key "") and build one entry per fuel with its change from the previous day
 * on record, falling back to the provider's own change figure. Rows must be ordered
 * newest first, state-specific before state-less on the same day.
 */
export function summarizeFuelRows(rows, location, today) {
  const scopes = [...location.areaKeys, ""];
  const scopeKey = scopes.find((key) => rows.some((row) => row.area_key === key));
  if (scopeKey === undefined) return null;

  const scoped = rows.filter((row) => row.area_key === scopeKey);
  const prices = [];
  for (const fuel of FUEL_TYPES) {
    const history = scoped.filter((row) => row.fuel_type === fuel);
    if (!history.length) continue;
    const current = history[0];
    const previous = history.find((row) => row.effective_date < current.effective_date);
    const price = round2(current.price);
    const previousPrice = previous ? round2(previous.price) : null;
    const providerChange = current.change_amount == null ? null : round2(current.change_amount);
    prices.push({
      fuel,
      label: FUEL_LABELS[fuel],
      price,
      unit: current.unit || FUEL_UNITS[fuel],
      previousPrice,
      change: previousPrice == null ? providerChange : round2(price - previousPrice),
      effectiveDate: current.effective_date,
      source: current.source,
    });
  }
  if (!prices.length) return null;

  const asOf = prices.map((p) => p.effectiveDate).sort().at(-1);
  const sample = scoped.find((row) => row.area_name) || scoped[0];
  return {
    available: true,
    location: {
      area: scopeKey ? sample.area_name || location.areaName : "",
      state: location.stateName || sample.state_name || "",
      scope: scopeKey ? "area" : "state",
    },
    asOf,
    stale: asOf < today,
    currency: "INR",
    prices,
  };
}

export function normalizeManualPrices(input = {}) {
  const prices = [];
  for (const fuel of FUEL_TYPES) {
    const raw = input[fuel];
    if (raw == null || raw === "") continue;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) {
      throw new FuelPriceError(`${FUEL_LABELS[fuel]} price must be a positive number up to ${MAX_PRICE}.`);
    }
    prices.push({ fuel, price: round2(price), unit: FUEL_UNITS[fuel] });
  }
  if (!prices.length) throw new FuelPriceError("Add at least one fuel price.");
  return prices;
}

const FUEL_PRICES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS fuel_prices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  state_key VARCHAR(80) NOT NULL DEFAULT '',
  state_name VARCHAR(120) NOT NULL DEFAULT '',
  area_key VARCHAR(80) NOT NULL DEFAULT '',
  area_name VARCHAR(120) NOT NULL DEFAULT '',
  fuel_type VARCHAR(16) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  change_amount DECIMAL(10,2) NULL,
  unit VARCHAR(8) NOT NULL,
  effective_date DATE NOT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fuel_price_day (state_key, area_key, fuel_type, effective_date),
  KEY idx_fuel_price_area (area_key, effective_date)
)`;

const UPSERT_CHUNK = 200;

/** MySQL-backed store. Kept behind a small interface so the service can be tested without a DB. */
export function createFuelPriceStore(getPoolFn = getPool) {
  let ready = null;
  const pool = async () => {
    const p = await getPoolFn();
    if (!ready) ready = p.query(FUEL_PRICES_TABLE_SQL).catch((error) => { ready = null; throw error; });
    await ready;
    return p;
  };

  return {
    async findRecent({ stateKey, areaKeys, today }) {
      const p = await pool();
      const [rows] = await p.query(
        `SELECT state_key, state_name, area_key, area_name, fuel_type, price, change_amount, unit, source,
                DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date
         FROM fuel_prices
         WHERE state_key IN (?, '') AND area_key IN (?)
           AND effective_date BETWEEN DATE_SUB(?, INTERVAL ${HISTORY_DAYS} DAY) AND ?
         ORDER BY effective_date DESC, state_key DESC`,
        [stateKey, [...areaKeys, ""], today, today]
      );
      // A state-wide row needs the customer's state; state-less rows are city rows from the provider.
      return rows.filter((row) => row.area_key !== "" || row.state_key === stateKey);
    },

    async upsertRows(rows) {
      const p = await pool();
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK);
        await p.query(
          `INSERT INTO fuel_prices
             (state_key, state_name, area_key, area_name, fuel_type, price, change_amount, unit, effective_date, source)
           VALUES ?
           ON DUPLICATE KEY UPDATE price = VALUES(price), change_amount = VALUES(change_amount), unit = VALUES(unit),
             source = VALUES(source), area_name = VALUES(area_name), state_name = VALUES(state_name)`,
          [chunk.map((r) => [r.stateKey, r.stateName, r.areaKey, r.areaName, r.fuel, r.price, r.change ?? null, r.unit, r.effectiveDate, r.source])]
        );
      }
    },

    async hasSourceRows({ source, date }) {
      const p = await pool();
      const [rows] = await p.query(
        "SELECT COUNT(*) AS count FROM fuel_prices WHERE source = ? AND effective_date = ?",
        [source, date]
      );
      return Number(rows[0]?.count || 0) > 0;
    },

    async list({ stateKey, areaKey, days }) {
      const p = await pool();
      const params = [days];
      let where = "effective_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)";
      if (stateKey) { where += " AND state_key IN (?, '')"; params.push(stateKey); }
      if (areaKey != null) { where += " AND area_key = ?"; params.push(areaKey); }
      const [rows] = await p.query(
        `SELECT id, state_name, area_name, area_key, fuel_type, price, change_amount, unit, source,
                DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, updated_at
         FROM fuel_prices WHERE ${where}
         ORDER BY effective_date DESC, area_name, fuel_type
         LIMIT 500`,
        params
      );
      return rows;
    },
  };
}

export function createFuelPriceService({
  store = createFuelPriceStore(),
  geocode = reverseGeocode,
  fetchCityPrices = fetchLiveCityPrices,
  providerConfig = () => getProviderConfig(),
  now = () => new Date(),
} = {}) {
  const cache = new Map();
  let lastSyncAttempt = 0;
  let syncing = null;

  async function resolveLocation(input) {
    if (input.lat != null && input.lng != null) {
      const result = await geocode({ lat: input.lat, lng: input.lng });
      return locationFromAddress(result?.address || {});
    }
    return buildLocation({ areaName: input.city, districtName: input.district, stateName: input.state });
  }

  async function getPrices(input = {}) {
    const location = await resolveLocation(input);
    if (!location.stateKey && !location.areaKeys.length) {
      return { available: false, reason: "location_unknown" };
    }

    const today = istDate(now());
    const cacheKey = `${location.stateKey}|${location.areaKeys.join(",")}|${today}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now().getTime()) return cached.value;

    const rows = await store.findRecent({ stateKey: location.stateKey, areaKeys: location.areaKeys, today });
    const value = summarizeFuelRows(rows, location, today) || {
      available: false,
      reason: "no_prices",
      location: { area: location.areaName, state: location.stateName, scope: "none" },
    };
    cache.set(cacheKey, { value, expiresAt: now().getTime() + CACHE_TTL_MS });
    if (cache.size > 500) cache.clear();
    return value;
  }

  /**
   * Pull today's petrol and diesel prices for every city from the provider (2 requests).
   * Skips when already synced today unless `force` is set.
   */
  async function syncProviderPrices({ force = false } = {}) {
    const config = providerConfig();
    if (!config) return { synced: false, reason: "provider_not_configured" };
    if (syncing) return syncing;

    syncing = (async () => {
      const today = istDate(now());
      if (!force && (await store.hasSourceRows({ source: config.name, date: today }))) {
        return { synced: false, reason: "already_synced", date: today };
      }
      lastSyncAttempt = now().getTime();
      const rows = [];
      const counts = {};
      for (const fuel of PROVIDER_FUELS) {
        const cityRows = await fetchCityPrices(fuel, { config });
        counts[fuel] = cityRows.length;
        for (const entry of cityRows) {
          const areaKey = toAreaKey(entry.areaName);
          if (!areaKey) continue;
          rows.push({
            stateKey: "",
            stateName: "",
            areaKey,
            areaName: entry.areaName,
            fuel,
            price: entry.price,
            change: entry.change,
            unit: FUEL_UNITS[fuel],
            effectiveDate: today,
            source: config.name,
          });
        }
      }
      if (!rows.length) return { synced: false, reason: "provider_returned_no_prices", date: today };
      await store.upsertRows(rows);
      cache.clear();
      return { synced: true, date: today, counts };
    })();

    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }

  /** Called hourly: sync once a day after the morning price revision. */
  async function runScheduledSync() {
    if (!providerConfig()) return null;
    const current = now();
    if (istHour(current) < SYNC_AFTER_IST_HOUR) return null;
    if (lastSyncAttempt && current.getTime() - lastSyncAttempt < SYNC_RETRY_MS && istDate(new Date(lastSyncAttempt)) === istDate(current)) {
      return null;
    }
    try {
      return await syncProviderPrices();
    } catch (error) {
      console.warn("[Fuel Prices] daily sync failed:", error?.response?.status || "", error?.message || error);
      return { synced: false, reason: "provider_error" };
    }
  }

  async function saveManualPrices(input = {}) {
    const location = buildLocation({ areaName: input.area || input.city, stateName: input.state });
    if (!location.stateKey) throw new FuelPriceError("State is required.");
    const effectiveDate = input.effectiveDate ? String(input.effectiveDate) : istDate(now());
    if (!isIsoDate(effectiveDate)) throw new FuelPriceError("effectiveDate must be YYYY-MM-DD.");
    const prices = normalizeManualPrices(input.prices);
    const areaKey = location.areaKeys[0] || "";
    const areaName = areaKey ? location.areaName : "";
    await store.upsertRows(prices.map((entry) => ({
      stateKey: location.stateKey,
      stateName: location.stateName,
      areaKey,
      areaName,
      fuel: entry.fuel,
      price: entry.price,
      change: null,
      unit: entry.unit,
      effectiveDate,
      source: "manual",
    })));
    cache.clear();
    return { state: location.stateName, area: areaName, effectiveDate, prices };
  }

  async function listPrices(input = {}) {
    const days = Math.min(90, Math.max(1, Number(input.days) || 14));
    return store.list({
      stateKey: input.state ? toAreaKey(input.state) : "",
      areaKey: input.area != null ? toAreaKey(input.area) : null,
      days,
    });
  }

  return { getPrices, saveManualPrices, listPrices, syncProviderPrices, runScheduledSync };
}

let defaultService = null;
export function getFuelPriceService() {
  if (!defaultService) defaultService = createFuelPriceService();
  return defaultService;
}

let syncTimer = null;
/** Start the hourly check that runs the once-a-day provider sync. No-op without an API key. */
export function startFuelPriceSync() {
  if (syncTimer || !getProviderConfig()) return;
  const tick = () => getFuelPriceService().runScheduledSync().catch(() => {});
  setTimeout(tick, 15_000);
  syncTimer = setInterval(tick, SYNC_CHECK_INTERVAL_MS);
  syncTimer.unref?.();
}

export function stopFuelPriceSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
