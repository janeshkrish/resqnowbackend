import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  defaultTowTruckType,
  normalizeTowTruckType,
  normalizeVehicleSubtype,
  pricingSubcategoryFor,
  towingCategoryForSubtype,
} from "../services/vehicleClasses.js";
import { answerValue, describeRequestDetails, sanitizeRequestDetails, summarizeRequestDetails } from "../services/requestDetails.js";
import { buildTechnicianJobDetails } from "../services/technicianJobDetails.js";
import { fleetPricingFor, normalizeVehicleCategory } from "../services/towingQuoteService.js";
import { calculateTechnicianServiceRowPayout } from "../services/pricingEstimator.js";

test("vehicle subclasses use the technician onboarding ids and still read old body types", () => {
  assert.equal(normalizeVehicleSubtype("car", "compact-suv"), "compact-suv");
  assert.equal(normalizeVehicleSubtype("car", "Compact SUV"), "compact-suv");
  assert.equal(normalizeVehicleSubtype("car", "SUV"), "big-suv");
  assert.equal(normalizeVehicleSubtype("car", "MPV"), "big-suv");
  assert.equal(normalizeVehicleSubtype("bike", "Cruiser"), "premium-bike");
  assert.equal(normalizeVehicleSubtype("bike", "Sport Bike"), "sports-bike");
  assert.equal(normalizeVehicleSubtype("commercial", "Bus"), "heavy-truck");
  assert.equal(normalizeVehicleSubtype("ev", "Electric Scooters"), "electric-scooter");
  assert.equal(normalizeVehicleSubtype("ev", "hatchback"), "electric-car");
  // Wrong family or unknown: no subclass rather than a guess.
  assert.equal(normalizeVehicleSubtype("bike", "sedan"), null);
  assert.equal(normalizeVehicleSubtype("car", "Other Cars"), null);
  assert.equal(normalizeVehicleSubtype("car", ""), null);
});

test("each subclass maps to a towing size and a tyre price tier", () => {
  assert.equal(towingCategoryForSubtype("hatchback"), "hatchback");
  assert.equal(towingCategoryForSubtype("compact-suv"), "suv");
  assert.equal(towingCategoryForSubtype("luxury"), "luxury_car");
  assert.equal(towingCategoryForSubtype("scooter"), "scooter");
  assert.equal(towingCategoryForSubtype("commuter-bike"), "bike");
  assert.equal(towingCategoryForSubtype("heavy-truck"), "truck");
  assert.equal(pricingSubcategoryFor("luxury"), "big-suv");
  assert.equal(pricingSubcategoryFor("sedan"), "sedan");
  assert.equal(pricingSubcategoryFor("nope"), null);
});

test("the truck type follows the vehicle and whether it rolls", () => {
  assert.equal(defaultTowTruckType({ family: "car", subtype: "hatchback", canRoll: "yes" }), "wheel-lift");
  assert.equal(defaultTowTruckType({ family: "car", subtype: "hatchback", canRoll: "no" }), "flatbed");
  assert.equal(defaultTowTruckType({ family: "car", subtype: "hatchback", canRoll: "dk" }), "flatbed");
  assert.equal(defaultTowTruckType({ family: "car", subtype: "luxury", canRoll: "yes" }), "flatbed");
  assert.equal(defaultTowTruckType({ family: "ev", subtype: "electric-car", canRoll: "yes" }), "flatbed");
  assert.equal(defaultTowTruckType({ family: "bike", subtype: "scooter", canRoll: "yes" }), "flatbed");
  assert.equal(defaultTowTruckType({ family: "commercial", subtype: "heavy-truck", canRoll: "yes" }), "heavy-duty-wrecker");
  assert.equal(normalizeTowTruckType("Wheel Lift"), "wheel-lift");
  assert.equal(normalizeTowTruckType("crane"), null);
});

test("towing size comes from the chosen subclass, with text matching for older requests", () => {
  assert.equal(normalizeVehicleCategory({ vehicleType: "car", vehicleModel: "Creta", vehicleSubtype: "hatchback" }), "hatchback");
  assert.equal(normalizeVehicleCategory({ vehicleType: "car", vehicleBrand: "BMW", vehicleModel: "3 Series", vehicleSubtype: "sedan" }), "luxury_car");
  assert.equal(normalizeVehicleCategory({ vehicleType: "car", vehicleModel: "SUV - Creta" }), "suv");
  assert.equal(normalizeVehicleCategory({ vehicleType: "bike", vehicleModel: "Activa", vehicleSubtype: "scooter" }), "scooter");
});

test("a technician's truck-type price is used when they set one", () => {
  const pricing = { fleet_pricing: { flatbed: { base_charge: "900", free_distance: "8", per_km_charge: "30" }, "wheel-lift": { base_charge: "" } } };
  assert.deepEqual(fleetPricingFor(pricing, "flatbed"), { base_price: 900, free_km: 8, per_km_price: 30 });
  assert.equal(fleetPricingFor(pricing, "wheel-lift"), null);
  assert.equal(fleetPricingFor(pricing, null), null);
  assert.equal(fleetPricingFor({}, "flatbed"), null);
});

test("puncture pay follows the vehicle subcategory and tyre type", () => {
  const row = {
    service_domain: "flat-tire", visit_charge: "100", service_charge: "150",
    metadata: JSON.stringify({ subcategories: { hatchback: { tube_tyre_price: 150, tubeless_price: 200 }, "big-suv": { tube_tyre_price: 250, tubeless_price: 320 } } }),
  };
  assert.equal(calculateTechnicianServiceRowPayout(row, "car", { vehicleSubtype: "hatchback", tyreType: "tubeless" }), 300);
  assert.equal(calculateTechnicianServiceRowPayout(row, "car", { vehicleSubtype: "hatchback", tyreType: "tube" }), 250);
  // Not sure which tyre: the higher price, so the technician isn't short-changed.
  assert.equal(calculateTechnicianServiceRowPayout(row, "car", { vehicleSubtype: "luxury", tyreType: "dk" }), 420);
  // Nothing to match on: the old single price.
  assert.equal(calculateTechnicianServiceRowPayout(row, "car"), 250);
  assert.equal(calculateTechnicianServiceRowPayout({ ...row, service_domain: "battery" }, "car", { vehicleSubtype: "hatchback", tyreType: "tube" }), 250);
});

test("request details keep only clean answers and our own uploads", () => {
  const details = sanitizeRequestDetails({
    answers: [
      { id: "tyretype", question: "Tyre type", value: "tubeless", label: "Tubeless" },
      { id: "tyre", question: "Which tyre is flat?", value: ["rl", "fr"], label: "Back left, Front right" },
      { id: "bad id!", question: "x", value: "y", label: "z" },
      { id: "tyretype", question: "dupe", value: "tube", label: "Tube" },
      { id: "empty", question: "x", value: "", label: "" },
    ],
    landmark: "  near the   bus stop ",
    plate: "ka 01 ab 1234",
    attachments: [
      { type: "photo", url: "/api/upload/files/123-tyre.jpg" },
      { type: "photo", url: "https://evil.example/x.jpg" },
      { type: "voice", url: "/api/upload/files/../../etc" },
    ],
  });
  assert.deepEqual(details.answers.map((a) => a.id), ["tyretype", "tyre"]);
  assert.deepEqual(details.answers[1].value, ["rl", "fr"]);
  assert.equal(details.landmark, "near the bus stop");
  assert.equal(details.plate, "KA 01 AB 1234");
  assert.deepEqual(details.attachments, [{ type: "photo", url: "/api/upload/files/123-tyre.jpg" }]);
  assert.equal(details.urgent, false);
  assert.equal(answerValue(details, "tyretype"), "tubeless");
  assert.deepEqual(summarizeRequestDetails(details), ["Tubeless", "Back left, Front right"]);
  assert.match(describeRequestDetails(details), /Tyre type: Tubeless\nWhich tyre is flat\?: Back left, Front right\nLandmark: near the bus stop\nNumber plate: KA 01 AB 1234/);
  assert.equal(sanitizeRequestDetails({ answers: [] }), null);
  assert.equal(sanitizeRequestDetails("not json"), null);
});

test("someone inside or hurt marks the request urgent", () => {
  assert.equal(sanitizeRequestDetails({ answers: [{ id: "inside", value: "yes", label: "Someone inside" }] }).urgent, true);
  assert.equal(sanitizeRequestDetails({ answers: [{ id: "hurt", value: "yes", label: "Someone hurt" }] }).urgent, true);
  assert.equal(sanitizeRequestDetails({ answers: [{ id: "hurt", value: "no", label: "No one hurt" }] }).urgent, false);
});

test("technicians get one vehicle line, the problem chips and the truck", () => {
  const job = buildTechnicianJobDetails({
    vehicle_brand: "Maruti Suzuki", vehicle_model: "Swift", vehicle_subtype: "hatchback", tow_truck_type: "wheel-lift",
    request_details_json: JSON.stringify({ answers: [{ id: "why", question: "What happened?", value: "breakdown", label: "Breakdown" }], landmark: "Gate 2" }),
  });
  assert.equal(job.vehicleLine, "Maruti Suzuki Swift · Hatchback");
  assert.equal(job.towTruckLabel, "Wheel-lift");
  assert.deepEqual(job.problem, ["Breakdown"]);
  assert.equal(job.landmark, "Gate 2");
  assert.equal(job.urgent, false);
  // Older requests: brand already in the model, no subclass, no details.
  const old = buildTechnicianJobDetails({ vehicle_model: "SUV - Creta", vehicle_brand: null });
  assert.equal(old.vehicleLine, "SUV - Creta");
  assert.deepEqual(old.problem, []);
});

test("the create route stores the new fields and hands them to dispatch", async () => {
  const source = await readFile(new URL("../routes/service_requests.js", import.meta.url), "utf8");
  assert.match(source, /vehicle_brand, vehicle_subtype, tow_truck_type, request_details_json\)/);
  assert.match(source, /sanitizeRequestDetails\(details/);
  assert.match(source, /towTruckType,\s*\n\s*pickupAddress: address/);
  const queue = await readFile(new URL("../services/dispatchQueueService.js", import.meta.url), "utf8");
  assert.match(queue, /sr\.request_details_json/);
  assert.match(queue, /\.\.\.buildTechnicianJobDetails\(requestRow\)/);
});
