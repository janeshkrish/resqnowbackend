import { resolveTechnicianSignupCredentials } from "../services/serviceNormalization.js";
import { replaceTechnicianServicePricing } from "../controllers/technicianPricingController.js";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTechnicianPricingEntries } from "../models/technicianPricing.js";
import { estimateTechnicianPayoutAsync } from "../services/pricingEstimator.js";
import { calculateTechnicianServiceRowPayout } from "../services/pricingEstimator.js";

test("uses the selected subtype's visit fee as well as its repair price", () => {
  const row = { service_domain: "flat-tire", visit_charge: 100, service_charge: 100,
    metadata: { subcategories: { "electric-car": { visit_charge: 150, tube_tyre_price: 400, tubeless_price: 500 } } } };
  assert.equal(calculateTechnicianServiceRowPayout(row, "ev", { vehicleSubtype: "electric-car", tyreType: "tubeless" }), 650);
});

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

test("non-towing payout remains technician-specific at offer and accept time", async () => {
  const request = { service_type: "car-battery", vehicle_type: "car" };
  const lowerPricedTechnician = {
    service_costs: [
      {
        service_domain: "battery",
        vehicle_type: "car",
        service_charge: 320,
      },
    ],
  };
  const higherPricedTechnician = {
    service_costs: [
      {
        service_domain: "battery",
        vehicle_type: "car",
        service_charge: 475,
      },
    ],
  };

  assert.equal(
    await estimateTechnicianPayoutAsync(request, lowerPricedTechnician),
    320
  );
  assert.equal(
    await estimateTechnicianPayoutAsync(request, higherPricedTechnician),
    475
  );
});


const base = { name: 'Roadside Garage', phone: '9876543210' };
test('accepts applications without email or password using unique internal identifiers', () => {
  const first = resolveTechnicianSignupCredentials(base);
  const second = resolveTechnicianSignupCredentials(base);
  assert.equal(first.error, undefined);
  assert.equal(first.email, '');
  assert.equal(first.password, '');
  assert.match(first.storageEmail, /@resqnow\.invalid$/);
  assert.notEqual(first.storageEmail, second.storageEmail);
});
test('requires a password only when an email is supplied', () => {
  assert.match(resolveTechnicianSignupCredentials({ ...base, email: 'owner@example.com' }).error, /password is required/i);
  assert.match(resolveTechnicianSignupCredentials({ ...base, email: 'owner@example.com', password: 'short' }).error, /8 characters/);
  const result = resolveTechnicianSignupCredentials({ ...base, email: ' Owner@Example.com ', password: 'safe-password' });
  assert.equal(result.email, 'owner@example.com');
  assert.equal(result.storageEmail, 'owner@example.com');
});
test('rejects invalid contact details and validates an optional supplied password', () => {
  assert.ok(resolveTechnicianSignupCredentials({ ...base, email: 'wrong' }).error);
  assert.ok(resolveTechnicianSignupCredentials({ ...base, phone: '' }).error);
  assert.ok(resolveTechnicianSignupCredentials({ ...base, password: 'short' }).error);
  assert.equal(resolveTechnicianSignupCredentials({ ...base, password: 'safe-password' }).error, undefined);
});

test('saves EV bus and commercial subtypes in the existing pricing JSON column', async () => {
  const calls = [];
  const connection = { execute: async (sql, values) => { calls.push({ sql, values }); return [{}]; } };
  const rows = ['bus', 'scv'].map((subtype, index) => ({ service_id: 1, vehicle_category_id: index + 3, vehicle_subcategory_id: null, pricing_json: { vehicle_subtype: subtype, vehicle_subtype_label: subtype.toUpperCase(), visit_charge: 0 } }));
  await replaceTechnicianServicePricing(connection, 42, rows);
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /DELETE FROM technician_service_pricing/);
  assert.equal(calls[1].values[3], null);
  assert.deepEqual(JSON.parse(calls[1].values[5]), rows[0].pricing_json);
  assert.deepEqual(JSON.parse(calls[2].values[5]), rows[1].pricing_json);
});
test('rejects invalid identifiers and negative prices', async () => {
  const connection = { execute: async () => [{}] };
  await assert.rejects(replaceTechnicianServicePricing(connection, 42, [{ service_id: 0, vehicle_category_id: 1, pricing_json: {} }]), /Invalid/);
  await assert.rejects(replaceTechnicianServicePricing(connection, 42, [{ service_id: 1, vehicle_category_id: 1, pricing_json: { visit_charge: -1 } }]), /non-negative/);
});
