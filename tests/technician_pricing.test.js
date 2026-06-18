import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";

const flatTireDocument = [
  {
    service_domain: "flat-tire",
    vehicle_categories: ["bike", "car"],
    flat_tire_vehicle_pricing: {
      bike: {
        visit_charge: 120,
        free_distance: 3,
        extra_km_charge: 20,
        selected_subcategories: ["scooter"],
        subcategories: {
          scooter: {
            label: "Scooter",
            tube_tyre_price: 180,
            tubeless_price: 220,
          },
        },
      },
      car: {
        visit_charge: 150,
        selected_subcategories: ["hatchback"],
        subcategories: {
          hatchback: {
            label: "Hatchback",
            tube_tyre_price: 300,
            tubeless_price: 350,
          },
        },
      },
    },
  },
];

test("normalizes nested flat-tire pricing without dropping subcategories", () => {
  const rows = normalizeTechnicianPricingEntries(flatTireDocument);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].service_domain, "flat-tire");
  assert.equal(rows[0].service_charge, 180);
  assert.equal(rows[0].metadata.subcategories.scooter.tubeless_price, 220);
});

test("flat-tire display price is visit charge plus the lowest puncture price", async () => {
  const pricingModule = await import("../services/technicianPriceDisplay.js").catch(() => null);
  assert.ok(pricingModule?.resolveTechnicianDisplayPrice, "display price resolver must exist");

  const rows = normalizeTechnicianPricingEntries(flatTireDocument);
  const result = pricingModule.resolveTechnicianDisplayPrice(rows, {
    serviceType: "flat-tire",
    vehicleType: "bike",
  });

  assert.deepEqual(result, {
    price: 300,
    service_domain: "flat-tire",
    vehicle_type: "bike",
    breakdown: {
      visit_charge: 120,
      puncture_price: 180,
    },
  });
});

test("display pricing never falls back to a different vehicle category", async () => {
  const { resolveTechnicianDisplayPrice } = await import("../services/technicianPriceDisplay.js");
  const rows = normalizeTechnicianPricingEntries(flatTireDocument);

  assert.equal(
    resolveTechnicianDisplayPrice(rows, {
      serviceType: "flat-tire",
      vehicleType: "commercial",
    }),
    null
  );
});

test("standard service display price adds service and visit charges", async () => {
  const { resolveTechnicianDisplayPrice } = await import("../services/technicianPriceDisplay.js");
  const result = resolveTechnicianDisplayPrice(
    [
      {
        service_domain: "battery",
        vehicle_type: "car",
        service_charge: 350,
        visit_charge: 120,
        metadata: {},
      },
    ],
    { serviceType: "battery", vehicleType: "car" }
  );

  assert.equal(result.price, 470);
  assert.deepEqual(result.breakdown, {
    service_charge: 350,
    visit_charge: 120,
  });
});

test("indexes normalized rows by technician id", async () => {
  const { indexTechnicianPricingRows } = await import("../services/technicianPriceDisplay.js");
  const index = indexTechnicianPricingRows([
    { technician_id: 930001, service_domain: "flat-tire", vehicle_type: "bike" },
    { technician_id: 930001, service_domain: "flat-tire", vehicle_type: "car" },
    { technician_id: 930002, service_domain: "battery", vehicle_type: "car" },
  ]);

  assert.equal(index.get(930001).length, 2);
  assert.equal(index.get(930002).length, 1);
});

test("preserves nested pricing while canonicalizing selected services", async () => {
  const configurationModule = await import(
    "../services/adminTechnicianServiceConfiguration.js"
  ).catch(() => null);
  assert.ok(
    configurationModule?.normalizeTechnicianServiceConfiguration,
    "service configuration normalizer must exist"
  );

  const result = configurationModule.normalizeTechnicianServiceConfiguration({
    services: ["Flat Tire Repair", "battery", "battery"],
    serviceCosts: flatTireDocument,
    existingPrimaryService: "flat-tire",
  });

  assert.deepEqual(result.services, ["flat-tire", "battery"]);
  assert.equal(result.primaryService, "flat-tire");
  assert.equal(
    result.serviceCosts[0].flat_tire_vehicle_pricing.bike.subcategories.scooter
      .tube_tyre_price,
    180
  );
});

test("drops pricing entries for services removed by the admin", async () => {
  const { normalizeTechnicianServiceConfiguration } = await import(
    "../services/adminTechnicianServiceConfiguration.js"
  );
  const result = normalizeTechnicianServiceConfiguration({
    services: ["battery"],
    serviceCosts: [
      ...flatTireDocument,
      {
        service_domain: "battery",
        vehicle_categories: ["car"],
        vehicle_pricing: {
          car: { service_charge: 350, visit_charge: 120 },
        },
      },
    ],
    existingPrimaryService: "flat-tire",
  });

  assert.deepEqual(result.services, ["battery"]);
  assert.equal(result.primaryService, "battery");
  assert.deepEqual(
    result.serviceCosts.map((entry) => entry.service_domain),
    ["battery"]
  );
});
