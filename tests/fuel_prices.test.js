import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchLiveCityPrices,
  getProviderConfig,
  normalizeLivePriceRows,
  parsePriceNumber,
  parseSignedNumber,
} from "../services/fuelPriceProvider.js";
import {
  FuelPriceError,
  buildLocation,
  createFuelPriceService,
  istDate,
  istHour,
  locationFromAddress,
  normalizeManualPrices,
  summarizeFuelRows,
  toAreaKey,
} from "../services/fuelPriceService.js";

const NOW = new Date("2026-09-26T03:30:00Z"); // 09:00 IST
const CONFIG = { name: "indianapi", baseUrl: "https://fuel.indianapi.in", apiKey: "test-key", timeoutMs: 5000 };

function memoryStore(initialRows = []) {
  const rows = [...initialRows];
  return {
    rows,
    async findRecent({ stateKey, areaKeys, today }) {
      const keys = [...areaKeys, ""];
      return rows
        .filter((r) => (r.state_key === stateKey || r.state_key === "") && keys.includes(r.area_key) && r.effective_date <= today)
        .filter((r) => r.area_key !== "" || r.state_key === stateKey)
        .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || b.state_key.localeCompare(a.state_key));
    },
    async upsertRows(newRows) {
      for (const r of newRows) {
        const row = {
          state_key: r.stateKey, state_name: r.stateName, area_key: r.areaKey, area_name: r.areaName, fuel_type: r.fuel,
          price: r.price, change_amount: r.change ?? null, unit: r.unit, effective_date: r.effectiveDate, source: r.source,
        };
        const existing = rows.find((x) => x.state_key === row.state_key && x.area_key === row.area_key && x.fuel_type === row.fuel_type && x.effective_date === row.effective_date);
        if (existing) Object.assign(existing, row); else rows.push(row);
      }
    },
    async hasSourceRows({ source, date }) {
      return rows.some((r) => r.source === source && r.effective_date === date);
    },
    async list() { return rows; },
  };
}

const row = (fuel, price, date, extra = {}) => ({
  state_key: "", state_name: "", area_key: "coimbatore", area_name: "Coimbatore", fuel_type: fuel, price,
  change_amount: null, unit: fuel === "cng" ? "kg" : "litre", effective_date: date, source: "indianapi", ...extra,
});

test("area keys ignore case, spacing and 'district'; IST date and hour", () => {
  assert.equal(toAreaKey("Coimbatore District"), "coimbatore");
  assert.equal(toAreaKey("Tamil Nadu"), "tamilnadu");
  assert.equal(istDate(NOW), "2026-09-26");
  assert.equal(istDate(new Date("2026-09-25T19:00:00Z")), "2026-09-26", "00:30 IST is already the next day");
  assert.equal(istHour(NOW), 9);
});

test("reverse-geocode address resolves to city, district and state", () => {
  const location = locationFromAddress({ suburb: "Peelamedu", city: "Coimbatore", state_district: "Coimbatore District", state: "Tamil Nadu" });
  assert.equal(location.areaName, "Coimbatore");
  assert.equal(location.stateKey, "tamilnadu");
  assert.deepEqual(location.areaKeys, ["coimbatore"]);

  const village = locationFromAddress({ village: "Karamadai", state_district: "Coimbatore", state: "Tamil Nadu" });
  assert.deepEqual(village.areaKeys, ["karamadai", "coimbatore"], "falls back to the district after the village");
});

test("Indian API live rows are parsed and bad rows dropped", () => {
  const rows = normalizeLivePriceRows([
    { city: "Coimbatore", price: "100.90", change: "+0.14" },
    { city: "Chennai", price: "₹100.80", change: "-0.06" },
    { city: "Madurai", price: "N/A", change: "0" },
    { city: "", price: "101.00" },
    { city: "Typo", price: "10090" },
  ], "petrol");
  assert.deepEqual(rows, [
    { areaName: "Coimbatore", price: 100.9, change: 0.14 },
    { areaName: "Chennai", price: 100.8, change: -0.06 },
  ]);
  assert.deepEqual(normalizeLivePriceRows({ detail: "No live data found" }, "petrol"), []);
  assert.equal(parsePriceNumber("Rs.102.10"), 102.1);
  assert.equal(parseSignedNumber("-0.06"), -0.06);
  assert.equal(parseSignedNumber("abc"), null);
});

test("provider is enabled only with an API key and calls live_fuel_price with x-api-key", async () => {
  assert.equal(getProviderConfig({}), null);
  assert.equal(getProviderConfig({ FUEL_PRICE_API_KEY: "k", FUEL_PRICE_PROVIDER: "manual" }), null);
  const config = getProviderConfig({ FUEL_PRICE_API_KEY: "k" });
  assert.equal(config.baseUrl, "https://fuel.indianapi.in");

  let requested = null;
  const http = { get: async (url, options) => { requested = { url, options }; return { data: [{ city: "Coimbatore", price: "92.48", change: "-0.06" }] }; } };
  const rows = await fetchLiveCityPrices("diesel", { config, http });
  assert.equal(requested.url, "https://fuel.indianapi.in/live_fuel_price");
  assert.deepEqual(requested.options.params, { fuel_type: "diesel", location_type: "city" });
  assert.equal(requested.options.headers["x-api-key"], "k");
  assert.deepEqual(rows, [{ areaName: "Coimbatore", price: 92.48, change: -0.06 }]);
});

test("summary reports today's price and change, falling back to the provider's change", () => {
  const location = buildLocation({ areaName: "Coimbatore", stateName: "Tamil Nadu" });
  const rows = [
    row("petrol", "100.90", "2026-09-26"), row("diesel", "92.48", "2026-09-26", { change_amount: "-0.06" }),
    row("petrol", "100.76", "2026-09-25"),
    row("cng", "89.50", "2026-09-20", { state_key: "tamilnadu", source: "manual" }),
  ];
  const summary = summarizeFuelRows(rows, location, "2026-09-26");
  assert.equal(summary.location.scope, "area");
  assert.equal(summary.location.state, "Tamil Nadu");
  assert.equal(summary.stale, false);
  const byFuel = Object.fromEntries(summary.prices.map((p) => [p.fuel, p]));
  assert.equal(byFuel.petrol.change, 0.14, "computed from our own history");
  assert.equal(byFuel.diesel.change, -0.06, "provider change used when we have no earlier day");
  assert.equal(byFuel.cng.change, null);
});

test("falls back to a state-wide manual price when the area has none", () => {
  const location = buildLocation({ areaName: "Tiruppur", stateName: "Tamil Nadu" });
  const summary = summarizeFuelRows([row("cng", "91.00", "2026-09-26", { state_key: "tamilnadu", area_key: "", area_name: "", source: "manual" })], location, "2026-09-26");
  assert.equal(summary.location.scope, "state");
  assert.equal(summary.prices[0].price, 91);
  assert.equal(summarizeFuelRows([], location, "2026-09-26"), null);
});

test("daily sync stores petrol and diesel for every city once per day", async () => {
  const store = memoryStore();
  const calls = [];
  const service = createFuelPriceService({
    store,
    providerConfig: () => CONFIG,
    fetchCityPrices: async (fuel) => {
      calls.push(fuel);
      return fuel === "petrol"
        ? [{ areaName: "Coimbatore", price: 100.9, change: 0.14 }, { areaName: "Chennai", price: 100.8, change: 0 }]
        : [{ areaName: "Coimbatore", price: 92.48, change: -0.06 }];
    },
    geocode: async () => ({ address: { city: "Coimbatore", state: "Tamil Nadu" } }),
    now: () => NOW,
  });

  const first = await service.syncProviderPrices();
  assert.deepEqual(first, { synced: true, date: "2026-09-26", counts: { petrol: 2, diesel: 1 } });
  assert.equal(store.rows.length, 3);
  assert.deepEqual(await service.syncProviderPrices(), { synced: false, reason: "already_synced", date: "2026-09-26" });
  assert.deepEqual(calls, ["petrol", "diesel"], "second sync spends no requests");

  const prices = await service.getPrices({ lat: 11.02, lng: 76.99 });
  assert.equal(prices.available, true);
  assert.deepEqual(prices.prices.map((p) => [p.fuel, p.price, p.change]), [["petrol", 100.9, 0.14], ["diesel", 92.48, -0.06]]);
});

test("customer requests never call the provider", async () => {
  let calls = 0;
  const service = createFuelPriceService({
    store: memoryStore([row("petrol", "100.76", "2026-09-25")]),
    providerConfig: () => CONFIG,
    fetchCityPrices: async () => { calls += 1; return []; },
    geocode: async () => ({ address: { city: "Coimbatore", state: "Tamil Nadu" } }),
    now: () => NOW,
  });
  const result = await service.getPrices({ lat: 11.02, lng: 76.99 });
  assert.equal(result.stale, true);
  assert.equal(result.asOf, "2026-09-25");
  assert.equal(calls, 0);
});

test("scheduled sync waits for the morning revision and does nothing without a key", async () => {
  let calls = 0;
  const make = (now, config = CONFIG) => createFuelPriceService({
    store: memoryStore(),
    providerConfig: () => config,
    fetchCityPrices: async () => { calls += 1; return [{ areaName: "Coimbatore", price: 100.9, change: null }]; },
    now: () => now,
  });
  assert.equal(await make(new Date("2026-09-26T00:30:00Z")).runScheduledSync(), null, "06:00 IST is too early");
  assert.equal(await make(NOW, null).runScheduledSync(), null);
  assert.equal(calls, 0);
  const result = await make(NOW).runScheduledSync();
  assert.equal(result.synced, true);
  assert.equal(calls, 2);
});

test("unknown locations and empty data return available:false", async () => {
  const service = createFuelPriceService({
    store: memoryStore(),
    geocode: async () => ({ address: {} }),
    providerConfig: () => null,
    now: () => NOW,
  });
  assert.deepEqual(await service.getPrices({ lat: 0, lng: 0 }), { available: false, reason: "location_unknown" });
  const none = await service.getPrices({ city: "Coimbatore", state: "Tamil Nadu" });
  assert.equal(none.available, false);
  assert.equal(none.reason, "no_prices");
});

test("admin price entry is validated and saved as manual", async () => {
  const store = memoryStore();
  const service = createFuelPriceService({ store, providerConfig: () => null, now: () => NOW });
  const saved = await service.saveManualPrices({ state: "Tamil Nadu", area: "Coimbatore", prices: { cng: "89.5", ev: 18 } });
  assert.equal(saved.effectiveDate, "2026-09-26");
  assert.deepEqual(store.rows.map((r) => [r.state_key, r.fuel_type, r.price, r.unit, r.source]), [
    ["tamilnadu", "cng", 89.5, "kg", "manual"],
    ["tamilnadu", "ev", 18, "kwh", "manual"],
  ]);

  assert.throws(() => normalizeManualPrices({ petrol: -1 }), FuelPriceError);
  assert.throws(() => normalizeManualPrices({}), /at least one/);
  await assert.rejects(service.saveManualPrices({ area: "Coimbatore", prices: { petrol: 100 } }), /State is required/);
  await assert.rejects(service.saveManualPrices({ state: "Tamil Nadu", effectiveDate: "26/09/2026", prices: { petrol: 100 } }), /YYYY-MM-DD/);
});
