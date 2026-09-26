import assert from "node:assert/strict";
import test from "node:test";

import { computeServicePrices, createServicePriceLoader, normalizePriceVehicle } from "../services/servicePrices.js";

// 10% platform fee + 2% payment fee, as in the default platform pricing config.
const FEES = { currency: "INR", platform_fee_percent: 0.1, payment_fee_percent: 0.02 };

test("vehicle names normalize to the four pricing families", () => {
  assert.equal(normalizePriceVehicle(undefined), "car");
  assert.equal(normalizePriceVehicle("Bike"), "bike");
  assert.equal(normalizePriceVehicle("commercial"), "commercial");
  assert.equal(normalizePriceVehicle("spaceship"), null);
});

test("starting price is the cheapest technician's rate plus checkout fees", () => {
  const technicians = [{ id: 1 }, { id: 2 }, { id: 3, service_costs: JSON.stringify([{ service_domain: "towing", price_4w: 1500 }]) }, { id: 4 }];
  const serviceRows = [
    { technician_id: 1, service_domain: "towing", vehicle_type: "car", visit_charge: 200, price_4w_min: 800 },
    { technician_id: 1, service_domain: "towing", vehicle_type: "bike", visit_charge: 100, price_2w_min: 300 },
    { technician_id: 2, service_domain: "towing", vehicle_type: "", service_charge: 1200 },
    { technician_id: 2, service_domain: "battery", vehicle_type: "car", visit_charge: 150, service_charge: 250 },
    // a mistyped ₹1 rate must not become the headline price
    { technician_id: 4, service_domain: "battery", vehicle_type: "car", service_charge: 1 },
  ];

  const car = computeServicePrices({ technicians, serviceRows, vehicle: "car", pricingConfig: FEES, services: ["towing", "battery", "fuel"] });
  assert.deepEqual(car[0], { service: "towing", startingPrice: 1120, technicianMinimum: 1000, average: 1233, technicians: 3 });
  assert.deepEqual(car[1], { service: "battery", startingPrice: 448, technicianMinimum: 400, average: 400, technicians: 1 });
  assert.deepEqual(car[2], { service: "fuel", startingPrice: null, technicianMinimum: null, average: null, technicians: 0 });

  const bike = computeServicePrices({ technicians, serviceRows, vehicle: "bike", pricingConfig: FEES, services: ["towing"] });
  assert.equal(bike[0].technicianMinimum, 400, "bike row: 100 visit + 300 two-wheeler price");
  assert.equal(bike[0].startingPrice, 448);
});

test("loader reads approved technicians once and caches per vehicle", async () => {
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes("FROM technicians")) return [[{ id: 7 }]];
      return [[{ technician_id: 7, service_domain: "flat-tire", vehicle_type: "car", visit_charge: 100, price_4w_min: 250 }]];
    },
  };
  const load = createServicePriceLoader({ getPoolFn: async () => pool, getPricingConfig: async () => FEES, now: () => 1_000_000 });
  const first = await load({ vehicle: "car" });
  assert.equal(first.includesFees, true);
  const flatTyre = first.services.find((s) => s.service === "flat-tire");
  assert.equal(flatTyre.technicianMinimum, 350);
  assert.equal(flatTyre.startingPrice, 392);
  await load({ vehicle: "car" });
  assert.equal(queries.length, 2, "second call served from cache");
  await assert.rejects(load({ vehicle: "boat" }), /vehicle must be/);
});
