const SERVICE_DOMAIN_ALIASES = {
  towing: ["towing", "tow", "towing services", "towing assistance"],
  "flat-tire": [
    "flat tire repair",
    "flat tire",
    "tyre / puncture repair",
    "tyre puncture repair",
    "tire puncture",
    "tyre puncture",
    "puncture",
    "puncture repair",
    "tyre repair",
    "tire repair",
    "tubeless",
    "tubeless tyre repair",
  ],
  battery: [
    "battery",
    "battery jumpstart",
    "battery jump start",
    "jumpstart",
    "jump start",
    "battery replacement",
    "battery replace",
    "battery change",
  ],
  mechanical: [
    "mechanical",
    "mechanic",
    "mechanical issues",
    "mechanic issues",
    "car repair",
    "bike repair",
    "general servicing",
    "general repair",
    "general repairs",
    "general service",
    "oil change",
    "engine repair",
    "brake service",
    "electrical repair",
    "diagnostics",
    "breakdown",
  ],
  fuel: ["fuel", "fuel delivery", "petrol delivery", "diesel delivery"],
  lockout: ["lockout", "lockout assistance", "lockup", "key lockout", "keys locked"],
  winching: ["winching", "winching services", "recovery", "pull out", "accident repair", "accident recovery"],
  "ev-charging": [
    "ev portable charger",
    "ev charging",
    "ev charger",
    "ev support",
    "ev assistance",
    "ev help",
    "portable charger",
    "charging",
  ],
  other: ["other", "others", "custom", "general", "generic", "misc", "unknown"],
};

const VEHICLE_FAMILY_ALIASES = {
  car: ["car", "cars", "sedan", "hatchback", "suv", "mpv", "muv", "four wheeler", "4 wheeler", "four-wheeler"],
  bike: ["bike", "bikes", "motorcycle", "motorcycles", "scooter", "two wheeler", "2 wheeler", "two-wheeler"],
  commercial: ["commercial", "truck", "trucks", "van", "vans", "bus", "buses", "heavy vehicle", "construction vehicle"],
  ev: ["ev", "electric", "electric vehicle", "electric vehicles", "electric car", "electric bike", "electric scooter"],
};

export const normalizeText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const toTokenSet = (value) => new Set(normalizeText(value).split(" ").filter(Boolean));
const tokenCount = (value) => normalizeText(value).split(" ").filter(Boolean).length;

const tokenOverlapCount = (a, b) => {
  const sa = toTokenSet(a);
  const sb = toTokenSet(b);
  let count = 0;
  for (const token of sa) {
    if (sb.has(token)) count += 1;
  }
  return count;
};

const aliasMatch = (normalizedInput, normalizedAlias) => {
  if (!normalizedInput || !normalizedAlias) return false;
  if (normalizedInput === normalizedAlias) return true;

  // Strong forward match: alias phrase appears inside longer input phrase.
  if (normalizedInput.includes(normalizedAlias) && normalizedAlias.length >= 4) return true;

  // Conservative reverse/overlap matches only for multi-word terms.
  const inTokens = tokenCount(normalizedInput);
  const aliasTokens = tokenCount(normalizedAlias);

  if (inTokens >= 2 && aliasTokens >= 2 && tokenOverlapCount(normalizedInput, normalizedAlias) >= 2) {
    return true;
  }

  if (inTokens >= 2 && aliasTokens >= 2 && normalizedAlias.includes(normalizedInput) && normalizedInput.length >= 8) {
    return true;
  }

  return false;
};

export function canonicalizeServiceDomain(input) {
  const n = normalizeText(input);
  if (!n) return "";
  for (const [canonical, aliases] of Object.entries(SERVICE_DOMAIN_ALIASES)) {
    if (
      aliases.some((alias) => {
        const a = normalizeText(alias);
        return aliasMatch(n, a);
      })
    ) {
      return canonical;
    }
  }
  return n.replace(/\s+/g, "-");
}

export function canonicalizeVehicleFamily(input) {
  const n = normalizeText(input);
  if (!n) return "";
  for (const [family, aliases] of Object.entries(VEHICLE_FAMILY_ALIASES)) {
    if (
      aliases.some((alias) => {
        const a = normalizeText(alias);
        return aliasMatch(n, a);
      })
    ) {
      return family;
    }
  }
  return n;
}

export function normalizeSpecialties(specialties) {
  if (!Array.isArray(specialties)) return [];
  return [...new Set(specialties.map((s) => canonicalizeServiceDomain(s)).filter(Boolean))];
}

export function normalizeVehicleTypes(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    raw.forEach((entry) => {
      const key = canonicalizeVehicleFamily(entry);
      if (key) out[key] = true;
    });
    return out;
  }
  if (raw && typeof raw === "object") {
    Object.entries(raw).forEach(([key, enabled]) => {
      if (!enabled) return;
      const family = canonicalizeVehicleFamily(key);
      if (family) out[family] = true;
    });
  }
  return out;
}

export function parseVehicleTypes(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => canonicalizeVehicleFamily(v)).filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, enabled]) => !!enabled)
      .map(([key]) => canonicalizeVehicleFamily(key))
      .filter(Boolean);
  }
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parseVehicleTypes(parsed);
  } catch {
    const one = canonicalizeVehicleFamily(raw);
    return one ? [one] : [];
  }
}

export function serviceDomainsFromCosts(serviceCosts) {
  const parsed = typeof serviceCosts === "string" ? safeParse(serviceCosts) : serviceCosts;
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return [...new Set(parsed.map((s) => canonicalizeServiceDomain(s?.service_domain || s?.service_name || s?.service)).filter(Boolean))];
  }
  if (typeof parsed === "object") {
    return [...new Set(Object.keys(parsed).map((k) => canonicalizeServiceDomain(k)).filter(Boolean))];
  }
  return [];
}

export function normalizeServiceCosts(serviceCosts) {
  const parsed = typeof serviceCosts === "string" ? safeParse(serviceCosts) : serviceCosts;
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => {
      const domain = canonicalizeServiceDomain(entry?.service_domain || entry?.service_name || entry?.service);
      return {
        ...entry,
        service_domain: domain || entry?.service_domain || "",
      };
    });
  }
  if (parsed && typeof parsed === "object") {
    const out = {};
    Object.entries(parsed).forEach(([key, value]) => {
      out[canonicalizeServiceDomain(key) || key] = value;
    });
    return out;
  }
  return parsed || [];
}

function safeParse(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}
