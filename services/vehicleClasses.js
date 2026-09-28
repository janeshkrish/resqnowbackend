// Vehicle subclasses shared by the customer request form and technician pricing.
//
// The ids are the ones technicians already price against in onboarding (flat tyre
// subcategories), so a customer's "Compact SUV" meets the technician's "Compact SUV"
// price. "luxury" is the one addition: it has no onboarding price of its own, so it
// borrows the big-SUV tier for tyre prices and keeps the luxury towing multiplier.

export const VEHICLE_CLASSES = Object.freeze({
  car: [
    { id: "hatchback", label: "Hatchback", towCategory: "hatchback" },
    { id: "sedan", label: "Sedan", towCategory: "sedan" },
    { id: "compact-suv", label: "Compact SUV", towCategory: "suv" },
    { id: "big-suv", label: "SUV / MUV", towCategory: "suv" },
    { id: "luxury", label: "Luxury", towCategory: "luxury_car", priceAs: "big-suv" },
  ],
  bike: [
    { id: "scooter", label: "Scooter", towCategory: "scooter" },
    { id: "commuter-bike", label: "Commuter", towCategory: "bike" },
    { id: "sports-bike", label: "Sports", towCategory: "bike" },
    { id: "premium-bike", label: "Cruiser / premium", towCategory: "bike" },
  ],
  commercial: [
    { id: "pickup-mini-truck", label: "Pickup / mini truck", towCategory: "truck" },
    { id: "tempo-van", label: "Tempo / van", towCategory: "truck" },
    { id: "light-commercial", label: "Light commercial", towCategory: "truck" },
    { id: "heavy-truck", label: "Heavy truck / bus", towCategory: "truck" },
  ],
  ev: [
    { id: "electric-scooter", label: "E-scooter", towCategory: "ev" },
    { id: "electric-bike", label: "E-bike", towCategory: "ev" },
    { id: "electric-car", label: "E-car", towCategory: "ev" },
    { id: "electric-suv", label: "E-SUV", towCategory: "ev" },
  ],
});

// Body types from the earlier request form, so old drafts and apps still map.
const LEGACY_SUBTYPES = Object.freeze({
  suv: "big-suv", hatchback: "hatchback", sedan: "sedan", mpv: "big-suv", muv: "big-suv", "compact suv": "compact-suv",
  "sport bike": "sports-bike", "sports bike": "sports-bike", cruiser: "premium-bike", commuter: "commuter-bike",
  scooter: "scooter", "premium bike": "premium-bike",
  truck: "heavy-truck", van: "tempo-van", bus: "heavy-truck", "construction vehicle": "heavy-truck",
  "electric cars": "electric-car", "electric car": "electric-car", "electric bikes": "electric-bike",
  "electric bike": "electric-bike", "electric scooters": "electric-scooter", "electric scooter": "electric-scooter",
});

export const TOW_TRUCK_TYPES = Object.freeze(["flatbed", "wheel-lift", "heavy-duty-wrecker"]);

const ALL_CLASSES = Object.values(VEHICLE_CLASSES).flat();

const clean = (value) => String(value || "").trim().toLowerCase().replace(/[_\s]+/g, " ");

/** The subclass id for this family, from a current id or an old body-type label; null when unknown. */
export function normalizeVehicleSubtype(family, value) {
  const raw = clean(value);
  if (!raw) return null;
  const dashed = raw.replace(/\s+/g, "-");
  const familyClasses = VEHICLE_CLASSES[family] || ALL_CLASSES;
  const direct = familyClasses.find((entry) => entry.id === dashed);
  if (direct) return direct.id;
  const legacy = LEGACY_SUBTYPES[raw];
  if (legacy && familyClasses.some((entry) => entry.id === legacy)) return legacy;
  // An EV family request can still carry a car or bike label.
  if (family === "ev") {
    if (["hatchback", "sedan"].includes(dashed) || legacy === "hatchback" || legacy === "sedan") return "electric-car";
    if (["compact-suv", "big-suv"].includes(dashed) || legacy === "big-suv") return "electric-suv";
    if (dashed === "scooter" || legacy === "scooter") return "electric-scooter";
  }
  return null;
}

export function vehicleClassInfo(subtype) {
  return ALL_CLASSES.find((entry) => entry.id === subtype) || null;
}

/** Towing size category (a key of the towing vehicle_multipliers), or null to fall back to text matching. */
export function towingCategoryForSubtype(subtype) {
  return vehicleClassInfo(subtype)?.towCategory || null;
}

/** The subcategory a technician's tyre price is stored under. */
export function pricingSubcategoryFor(subtype) {
  const info = vehicleClassInfo(subtype);
  return info ? info.priceAs || info.id : null;
}

/**
 * Which truck to send: commercial vehicles need a wrecker; anything that won't roll,
 * might not roll, is electric, luxury or a two-wheeler goes on a flatbed; the rest can
 * use a wheel-lift.
 */
export function defaultTowTruckType({ family, subtype, canRoll }) {
  if (family === "commercial") return "heavy-duty-wrecker";
  if (canRoll !== "yes") return "flatbed";
  if (family === "ev" || family === "bike" || subtype === "luxury") return "flatbed";
  return "wheel-lift";
}

export function normalizeTowTruckType(value) {
  const raw = clean(value).replace(/\s+/g, "-");
  return TOW_TRUCK_TYPES.includes(raw) ? raw : null;
}
