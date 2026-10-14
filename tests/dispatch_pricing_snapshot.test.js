import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";

const pricing = await import("../services/dispatchPricingService.js").catch(() => null);
const requirePricing = () => {
  assert.ok(pricing?.buildDispatchPricingSnapshot, "persisted dispatch pricing contract must exist");
  return pricing;
};
const request = (overrides = {}) => ({ id: 101, service_type: "car-towing", vehicle_type: "car",
  route_distance_km: 12, tow_truck_type: "flatbed", payment_method: "upi", ...overrides });
const earning = (amount = 1040, overrides = {}) => async () => ({ amount, currency: "INR",
  source: "technician_fleet", breakdown: { base_price: 900, distance_charge: 140 }, ...overrides });
const snapshot = (overrides = {}) => ({ version: 1, request_id: 101, technician_id: 7, currency: "INR",
  technician_earning: 1040, customer_base_amount: 1040, customer_total_amount: 1146,
  payment_mode: "upi", platform_fee: 104, payment_fee: 2, discount_amount: 0,
  pricing_breakdown: { tax_percent: 0, tax_amount: 0 }, earnings_source: "technician_fleet",
  calculated_at: "2026-10-14T06:00:00.000Z", ...overrides });

test("expensive technician pricing replaces an unrelated platform estimate and funds the payout", async () => {
  const result = await requirePricing().buildDispatchPricingSnapshot({
    request: request({ amount: 599, estimated_price: 938.54 }), technicianId: 7, estimateEarning: earning(),
  });
  assert.equal(result.technician_earning, 1040);
  assert.equal(result.customer_base_amount, 1040);
  assert.equal(result.customer_total_amount, 1146);
});

test("registered towing tax is recomputed on the agreed technician subtotal", async () => {
  const result = await requirePricing().buildDispatchPricingSnapshot({ request: request({
    pricing_breakdown_json: JSON.stringify({ tax_percent: 0.18, tax_amount: 139.32, vehicle_multiplier: 0.8 }),
  }), technicianId: 7, estimateEarning: earning() });
  assert.equal(result.customer_base_amount, 1227.2);
  assert.equal(result.customer_total_amount, 1351.92);
  assert.equal(result.pricing_breakdown.tax_amount, 187.2);
  assert.equal(result.technician_earning, 1040);
});

test("current fee discounts never reduce funding for the technician", async () => {
  const result = await requirePricing().buildDispatchPricingSnapshot({ request: request({
    payment_method: "cash", applied_discount_percent: 1, applied_discount_amount: 500,
  }), technicianId: 7, estimateEarning: earning() });
  assert.equal(result.customer_total_amount, 1040);
  assert.equal(result.discount_amount, 104);
  assert.equal(result.payment_fee, 0);
});

for (const invalid of [0, -10, NaN, Infinity, null]) {
  test(`a new offer rejects invalid earning ${String(invalid)} instead of using request money`, async () => {
    await assert.rejects(requirePricing().buildDispatchPricingSnapshot({ request: request({ amount: 9999 }),
      technicianId: 7, estimateEarning: earning(invalid) }), /registered|pricing|earning/i);
  });
}

for (const source of ["platform", "request_amount", "stored"]) {
  test(`a new offer cannot freeze ${source} as registered technician pricing`, async () => {
    await assert.rejects(requirePricing().buildDispatchPricingSnapshot({ request: request(),
      technicianId: 7, estimateEarning: earning(1040, { source }) }), /registered|pricing/i);
  });
}

test("offer estimation explicitly requires registered pricing and passes the same transaction", async () => {
  const connection = {};
  let observed;
  await requirePricing().buildDispatchPricingSnapshot({ request: request(), technicianId: 7, connection,
    estimateEarning: async (options) => { observed = options; return await earning()(options); } });
  assert.equal(observed.requireRegisteredPricing, true);
  assert.equal(observed.connection, connection);
});

test("stored snapshot survives JSON round-trip and retains its accepted offer reference", () => {
  const value = snapshot({ offer_id: 30 });
  const parsed = requirePricing().readDispatchPricingSnapshot(JSON.stringify(value), { requestId: 101, technicianId: 7 });
  assert.deepEqual(parsed, value);
});

test("reading an agreed quote does not reapply a future fee policy", () => {
  const value = snapshot({ platform_fee: 125, payment_fee: 3, customer_total_amount: 1168,
    pricing_breakdown: { tax_percent: 0, tax_amount: 0, original_platform_fee: 125 } });
  assert.deepEqual(requirePricing().readDispatchPricingSnapshot(value), value);
});

for (const changes of [{ version: 2 }, { currency: "USD" }, { technician_earning: 1200 },
  { customer_total_amount: 1000 }, { platform_fee: -1 }, { customer_base_amount: null },
  { calculated_at: "bad-date" }, { request_id: 0 }, { payment_mode: "unknown" }, { pricing_breakdown: [] }]) {
  test(`malformed or unfunded snapshot is rejected: ${JSON.stringify(changes)}`, () => {
    assert.equal(requirePricing().readDispatchPricingSnapshot(snapshot(changes)), null);
  });
}

test("an offer snapshot belonging to a different job or technician cannot be accepted", () => {
  const { readDispatchPricingSnapshot } = requirePricing();
  assert.equal(readDispatchPricingSnapshot(snapshot(), { requestId: 102 }), null);
  assert.equal(readDispatchPricingSnapshot(snapshot(), { technicianId: 8 }), null);
});

for (const status of ["pending", "assigned"]) {
  test(`${status} customer responses hide every monetary alias and preserve verified route data`, () => {
    const input = request({ status, technician_id: 7, amount: 999, price: 999, final_price: 999,
      estimated_price: 999, priceAmount: 999, technicianEstimatedEarning: 700, service_charge: 999,
      baseAmount: 999, total_amount: 1000, applied_discount_amount: 5, pricing_snapshot: snapshot(),
      pricing_breakdown_json: { final_estimated_price: 999 }, payment: { amount: 999 },
      paymentDetails: { finalAmount: 999 }, route_metadata_json: { distance: 12 }, drop_address: "Workshop" });
    const output = requirePricing().customerPricingView(input);
    assert.equal(output.pricing_status, "pending");
    assert.equal(output.pricing_finalized, false);
    for (const key of ["amount", "price", "final_price", "estimated_price", "priceAmount", "technicianEstimatedEarning",
      "service_charge", "baseAmount", "total_amount", "applied_discount_amount", "pricing_snapshot", "pricing_breakdown_json",
      "payment", "paymentDetails"]) assert.equal(output[key], undefined, `${key} must not expose a waiting price`);
    assert.deepEqual(output.route_metadata_json, { distance: 12 });
    assert.equal(output.drop_address, "Workshop");
    assert.equal(input.amount, 999, "display sanitizing must not mutate the database row");
  });
}

test("merely assigning a technician cannot finalize a customer price", () => {
  assert.equal(requirePricing().acceptedPricingSnapshot(request({ technician_id: 7,
    status: "assigned", accepted_time: "2026-10-14", pricing_snapshot: snapshot() })), null);
});

test("accepted price is taken from the saved offer and remains available in completed history", () => {
  for (const status of ["accepted", "en_route_pickup", "payment_pending", "completed", "closed"]) {
    const output = requirePricing().customerPricingView(request({ status, technician_id: 7,
      amount: 599, technician_estimated_earning: 1, pricing_snapshot: snapshot() }));
    assert.equal(output.pricing_finalized, true);
    assert.equal(output.amount, 1040);
    assert.equal(output.technician_estimated_earning, 1040);
    assert.equal(output.final_price, 1146);
  }
});

test("customer receipt retains the checkout payment-mode and coupon total without changing service earnings", () => {
  for (const receipt of [{ finalAmount: 1094, final_price: 1146 }, { final_amount: 1094, final_price: 1146 },
    { final_price: 1094 }]) {
    const output = requirePricing().customerPricingView(request({ status: "completed", technician_id: 7,
      pricing_snapshot: snapshot(), payment_status: "paid", payment_method: "cash", ...receipt }));
    assert.equal(output.final_price, 1094);
    assert.equal(output.amount, 1040);
    assert.equal(output.technician_estimated_earning, 1040);
    assert.equal(output.pricing_snapshot.customer_total_amount, 1146, "the original offered contract remains intact");
  }
});

test("cancellation retains an accepted quote only when acceptance occurred", () => {
  const { acceptedPricingSnapshot, customerPricingView } = requirePricing();
  const row = request({ status: "cancelled", technician_id: 7, pricing_snapshot: snapshot() });
  assert.equal(acceptedPricingSnapshot(row), null);
  assert.equal(customerPricingView(row).pricing_finalized, false);
  assert.equal(acceptedPricingSnapshot({ ...row, accepted_time: "2026-10-14T06:10:00Z" }).technician_earning, 1040);
});

test("cancelling after acceptance preserves quote history when the technician reservation is released", () => {
  const row = request({ status: "cancelled", technician_id: null, accepted_time: "2026-10-14T06:10:00Z",
    pricing_snapshot: snapshot(), amount: 599 });
  assert.equal(requirePricing().acceptedPricingSnapshot(row)?.technician_earning, 1040);
  assert.equal(requirePricing().customerPricingView(row).amount, 1040);
});

test("database pricing failure becomes a pricing-unavailable result, never a platform fallback", async () => {
  await assert.rejects(requirePricing().buildDispatchPricingSnapshot({ request: request(), technicianId: 7,
    estimateEarning: async () => { throw new Error("Database unavailable"); } }),
  (error) => error.code === "pricing_unavailable");
});

test("accepted historical rows without new snapshots retain their recorded price", () => {
  const row = request({ status: "completed", technician_id: 7, amount: 800, final_price: 882,
    technician_estimated_earning: 750, pricing_snapshot: { legacy: true } });
  const output = requirePricing().customerPricingView(row);
  assert.equal(output.amount, 800);
  assert.equal(output.final_price, 882);
  assert.equal(output.technician_estimated_earning, 750);
  assert.equal(output.pricing_finalized, true);
});

test("pending nested towing quote keeps route information while stripping quoted money", () => {
  const output = requirePricing().customerPricingView(request({ status: "pending", towingQuote: {
    final_estimated_price: 888, base_amount: 700, pickup: { address: "Pickup", lat: 11 },
    route_metadata: { source: "cached", geometry: [1, 2] },
  } }));
  assert.deepEqual(output.towingQuote, { pickup: { address: "Pickup", lat: 11 }, route_metadata: {
    source: "cached", geometry: [1, 2] } });
});

const pricingConnection = (row) => ({ query: async (sql) => {
  if (/FROM technician_services/.test(sql)) return [[...(row ? [row] : [])]];
  if (/FROM technicians/.test(sql)) return [[{ service_costs: [] }]];
  throw new Error(`Unexpected database operation: ${sql}`);
} });

test("registered zero per-km towing is honored rather than replaced with a platform rate", async () => {
  const { buildDispatchPricingSnapshot } = requirePricing();
  const result = await buildDispatchPricingSnapshot({ request: request(), technicianId: 7,
    connection: pricingConnection({ service_domain: "towing", vehicle_type: "car", base_price: 900,
      free_km: 5, per_km_price: 80, night_charge: 0, metadata: { fleet_pricing: {
        flatbed: { base_charge: 1000, free_distance: 0, per_km_charge: 0 },
      } } }) });
  assert.equal(result.technician_earning, 1000);
  assert.equal(result.pricing_breakdown.distance_charge, 0);
});

test("strict new towing offers reject missing registered prices without querying platform rates", async () => {
  await assert.rejects(requirePricing().buildDispatchPricingSnapshot({ request: request({ amount: 888 }), technicianId: 7,
    connection: pricingConnection(null) }), /registered|pricing/i);
});

test("strict puncture pricing uses the exact registered vehicle subtype and tyre", async () => {
  const result = await requirePricing().buildDispatchPricingSnapshot({ request: request({ service_type: "ev-flat-tire",
    vehicle_type: "ev", vehicle_subtype: "electric-car", request_details_json: { tyretype: "tubeless" } }),
    technicianId: 7, connection: pricingConnection({ service_domain: "flat-tire", vehicle_type: "ev",
      visit_charge: 100, service_charge: 100, metadata: { subcategories: {
        "electric-car": { visit_charge: 150, tube_tyre_price: 400, tubeless_price: 500 },
      } } }) });
  assert.equal(result.technician_earning, 650);
});

test("re-saved registered truck prices remain truck-specific through metadata wrapping", async () => {
  const entries = normalizeTechnicianPricingEntries([{ service_domain: "towing", vehicle_categories: ["car"],
    towing_vehicle_pricing: { car: { base_charge: 900, free_distance: 5, extra_km_charge: 30 } },
    towing_fleet_types: ["flatbed"], fleet_pricing: { flatbed: {
      base_charge: 1500, free_distance: 5, per_km_charge: 200,
    } } }]);
  const stored = normalizeTechnicianPricingEntries(entries)[0];
  const result = await requirePricing().buildDispatchPricingSnapshot({ request: request(), technicianId: 7,
    connection: pricingConnection(stored) });
  assert.equal(result.technician_earning, 2900);
  assert.equal(result.earnings_source, "technician_fleet");
});
