import axios from 'axios';
import { distanceMeters } from './liveTrackingContract.js';

// Nearby EV charging stations and fuel pumps for the customer radar, from Mappls.
// Mappls is called only from here with the server-side key; the browser gets
// normalized places. Fields Mappls does not return stay undefined: nothing
// about a place (plugs, power, hours, availability) is inferred.

const DEFAULT_NEARBY_URL = 'https://search.mappls.com/search/places/nearby/json';
const DEFAULT_PLACE_DETAILS_URL = 'https://place.mappls.com/O2O/entity/place-details';

// Mappls POI categories (Transportation): "Electric Charging Station",
// "Petrol Pump" and "CNG Station".
export const EV_CATEGORY_CODE = 'TRNECS';
export const PETROL_PUMP_CATEGORY_CODE = 'TRNPMP';
export const CNG_STATION_CATEGORY_CODE = 'TRNCNG';

// Brands we can show a logo for, matched on the place name Mappls returns.
const BRANDS = {
  fuel: [
    ['indianoil', /indian\s*oil|\biocl?\b/i],
    ['bpcl', /bharat\s*petroleum|\bbpcl\b/i],
    ['hpcl', /hindustan\s*petroleum|\bhpcl\b|\bhp\s+(petrol|pump|fuel|filling)/i],
    ['nayara', /nayara|\bessar\b/i],
    ['shell', /\bshell\b/i],
    ['jiobp', /jio[\s-]*bp|reliance\s*(bp|petrol|fuel)/i],
  ],
  ev: [
    ['tatapower', /tata\s*power|ez\s*charge/i],
    ['statiq', /statiq/i],
    ['jiobp', /jio[\s-]*bp|bp\s*pulse/i],
    ['bpcl', /bharat\s*petroleum|\bbpcl\b/i],
    ['indianoil', /indian\s*oil|\biocl?\b/i],
    ['hpcl', /hindustan\s*petroleum|\bhpcl\b/i],
    ['chargezone', /charge\s*zone/i],
    ['zeon', /\bzeon\b/i],
    ['ather', /\bather\b/i],
  ],
};

export function detectBrand(name, kind = 'ev') {
  const value = String(name || '');
  const match = (BRANDS[kind] || []).find(([, pattern]) => pattern.test(value));
  return match ? match[0] : undefined;
}

const KINDS = {
  ev: { keywords: EV_CATEGORY_CODE, fallbackName: 'EV charging station', label: 'EV charging stations', envPrefix: 'EV_SEARCH' },
  fuel: { keywords: `${PETROL_PUMP_CATEGORY_CODE};${CNG_STATION_CATEGORY_CODE}`, fallbackName: 'Fuel station', label: 'Fuel stations', envPrefix: 'FUEL_SEARCH' },
};

// Mappls Nearby accepts a radius of 500 m to 10 km.
const MIN_RADIUS_METERS = 500;
const MAX_RADIUS_METERS = 10_000;
const MAX_CACHE_ENTRIES = 500;
const ENTITLEMENT_BACKOFF_MS = 10 * 60_000;
const FAILED_DETAILS_TTL_MS = 5 * 60_000;

const boundedNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function getEvChargingConfig(env = process.env, kind = 'ev') {
  const prefix = KINDS[kind].envPrefix;
  return {
    kind,
    apiKey: String(env.MAPPLS_REST_API_KEY || '').trim(),
    nearbyUrl: String(env.MAPPLS_NEARBY_URL || DEFAULT_NEARBY_URL).trim(),
    placeDetailsUrl: String(env.MAPPLS_PLACE_DETAILS_URL || DEFAULT_PLACE_DETAILS_URL).trim().replace(/\/+$/, ''),
    defaultRadiusMeters: boundedNumber(env[`${prefix}_RADIUS_METERS`], 5_000, MIN_RADIUS_METERS, MAX_RADIUS_METERS),
    detailsLimit: boundedNumber(env[`${prefix}_DETAILS_LIMIT`], 10, 0, 20),
    timeoutMs: boundedNumber(env[`${prefix}_TIMEOUT_MS`], 5_000, 1_000, 15_000),
    searchCacheTtlMs: boundedNumber(env[`${prefix}_CACHE_TTL_MS`], 15 * 60_000, 60_000, 24 * 60 * 60_000),
    detailsCacheTtlMs: 24 * 60 * 60_000,
  };
}

export const getFuelStationConfig = (env = process.env) => getEvChargingConfig(env, 'fuel');

export class EvChargingError extends Error {
  constructor(message, statusCode, code, { providerStatus = null } = {}) {
    super(message);
    this.name = 'EvChargingError';
    this.statusCode = statusCode;
    this.code = code;
    this.providerStatus = providerStatus;
  }
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const coordinate = (value, limit) => {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 && Math.abs(parsed) <= limit ? parsed : undefined;
};

const unique = (values) => [...new Set(values.filter(Boolean))];

const PLUG_NAMES = [
  [/^ccs\s*-?\s*2$|combo\s*2/i, 'CCS2'],
  [/^ccs\s*-?\s*1$|combo\s*1/i, 'CCS1'],
  [/chademo/i, 'CHAdeMO'],
  [/^type\s*-?\s*2$|iec\s*62196.*type\s*2|mennekes/i, 'Type 2'],
  [/^type\s*-?\s*1$|j1772/i, 'Type 1'],
  [/gb\s*\/?\s*t/i, 'GB/T'],
  [/bharat\s*ac/i, 'Bharat AC-001'],
  [/bharat\s*dc/i, 'Bharat DC-001'],
];

function plugName(value) {
  const raw = text(value);
  if (!raw) return undefined;
  const match = PLUG_NAMES.find(([pattern]) => pattern.test(raw));
  return match ? match[1] : raw;
}

/** EV details from a Mappls `richInfo.evInformation` block, when the account receives it. */
export function parseEvInformation(richInfo) {
  const evses = Array.isArray(richInfo?.evInformation?.evses) ? richInfo.evInformation.evses : [];
  const connectors = evses.flatMap((evse) => (Array.isArray(evse?.connectors) ? evse.connectors : []));
  const powers = connectors
    .map((connector) => Number.parseFloat(String(connector?.power ?? '')))
    .filter((power) => Number.isFinite(power) && power > 0);
  const chargingTypes = unique(evses.map((evse) => text(evse?.powerType)?.toUpperCase()))
    .filter((type) => type === 'AC' || type === 'DC')
    .sort();
  const connectorTypes = unique(connectors.map((connector) => plugName(connector?.plugTyp ?? connector?.plugType)));
  return {
    chargingTypes: chargingTypes.length ? chargingTypes : undefined,
    connectorTypes: connectorTypes.length ? connectorTypes : undefined,
    chargingPower: powers.length ? Math.max(...powers) : undefined,
    chargingSlots: evses.length || undefined,
  };
}

const istMinutesNow = (nowMs) => {
  const ist = new Date(nowMs + 5.5 * 60 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};

/**
 * Open/closed only when the hours are unambiguous: round-the-clock, or one
 * daily HH:MM-HH:MM window. Anything else stays unknown, with the raw hours shown.
 */
export function openStatusFromHours(hours, nowMs = Date.now()) {
  const value = text(hours);
  if (!value) return undefined;
  const namesDays = /\b(mon|tue|wed|thu|fri|sat|sun)/i.test(value);
  const everyDay = !namesDays || /mon\w*\s*(-|to)\s*sun|daily|all\s*days|every\s*day/i.test(value);
  if (!everyDay) return undefined;
  if (/24\s*(x|\*)\s*7|24\s*hours?|open\s*24|00:00\s*-\s*(23:59|24:00)/i.test(value)) return true;
  const windows = [...value.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
  if (windows.length !== 1) return undefined;
  const [, openH, openM, closeH, closeM] = windows[0].map(Number);
  const open = openH * 60 + openM;
  const close = closeH * 60 + closeM;
  const now = istMinutesNow(nowMs);
  return close > open ? now >= open && now < close : now >= open || now < close;
}

/** One Mappls Nearby entry as a place; coordinates only if Mappls sent them. */
export function normalizeNearbyEntry(entry, kind = 'ev') {
  const eLoc = text(entry?.eLoc);
  if (!eLoc) return null;
  const openingHours = text(entry.hourOfOperation);
  const name = text(entry.placeName) ?? KINDS[kind].fallbackName;
  const codes = Array.isArray(entry.keywords) ? entry.keywords.map((code) => String(code).toUpperCase()) : [];
  return {
    id: eLoc,
    mapplsPlaceId: eLoc,
    name,
    brand: detectBrand(name, kind),
    stationTypes: kind === 'fuel'
      ? unique([codes.includes(PETROL_PUMP_CATEGORY_CODE) ? 'petrol' : null, codes.includes(CNG_STATION_CATEGORY_CODE) ? 'cng' : null])
      : undefined,
    address: text(entry.placeAddress),
    latitude: coordinate(entry.latitude ?? entry.lat ?? entry.entryLatitude, 90),
    longitude: coordinate(entry.longitude ?? entry.lng ?? entry.entryLongitude, 180),
    providerDistanceMeters: Number.isFinite(Number(entry.distance)) ? Number(entry.distance) : undefined,
    phone: text(entry.mobileNo) ?? text(entry.landlineNo),
    openingHours: openingHours ? [openingHours] : undefined,
    ...(kind === 'ev' ? parseEvInformation(entry.richInfo) : {}),
  };
}

function normalizePlaceDetails(details, kind = 'ev') {
  if (!details || typeof details !== 'object') return null;
  const openingHours = text(details.hourOfOperation ?? details.openingHours);
  return {
    latitude: coordinate(details.latitude ?? details.entry_lat, 90),
    longitude: coordinate(details.longitude ?? details.entry_lon, 180),
    address: text(details.address),
    phone: text(details.mobile) ?? text(details.telephone),
    openingHours: openingHours ? [openingHours] : undefined,
    ...(kind === 'ev' ? parseEvInformation(details.richInfo) : {}),
  };
}

const withoutUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

export function createEvChargingService({
  config = getEvChargingConfig(),
  http = axios,
  now = () => Date.now(),
  warn = console.warn,
} = {}) {
  const searchCache = new Map();
  const detailsCache = new Map();
  const inFlight = new Map();
  let detailsBlockedUntil = 0;

  // Statuses are handled here so no library error (which carries the request
  // URL and key) ever leaves this module.
  async function get(url, params) {
    try {
      return await http.get(url, {
        timeout: config.timeoutMs,
        params: { ...params, access_token: config.apiKey },
        headers: { Accept: 'application/json' },
        validateStatus: () => true,
      });
    } catch (error) {
      return { status: error?.code === 'ECONNABORTED' ? 'timeout' : 'network', data: null };
    }
  }

  const kind = config.kind || 'ev';
  const unavailable = `${KINDS[kind].label} are temporarily unavailable.`;

  async function searchNearby(center, radiusMeters) {
    const response = await get(config.nearbyUrl, {
      keywords: KINDS[kind].keywords,
      refLocation: `${center.lat},${center.lng}`,
      radius: radiusMeters,
      sortBy: 'dist:asc',
      region: 'IND',
    });
    if (response.status === 204) return [];
    if (response.status !== 200) {
      warn(`[Radar] Mappls ${kind} search failed (${response.status}).`);
      throw new EvChargingError(unavailable, 502, `${kind}_search_failed`, {
        providerStatus: response.status,
      });
    }
    const entries = Array.isArray(response.data?.suggestedLocations) ? response.data.suggestedLocations : [];
    return entries.map((entry) => normalizeNearbyEntry(entry, kind)).filter(Boolean);
  }

  async function placeDetails(eLoc) {
    const cached = detailsCache.get(eLoc);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (now() < detailsBlockedUntil) return null;

    const response = await get(`${config.placeDetailsUrl}/${encodeURIComponent(eLoc)}`, {});
    if (response.status === 401 || response.status === 403) {
      // The key lacks Place Details (or hit its limit); stop asking for a while.
      detailsBlockedUntil = now() + ENTITLEMENT_BACKOFF_MS;
      warn(`[Radar] Mappls place details unavailable (${response.status}); showing search results only.`);
      return null;
    }
    const value = response.status === 200 ? normalizePlaceDetails(response.data, kind) : null;
    boundedSet(detailsCache, eLoc, {
      value,
      expiresAt: now() + (value ? config.detailsCacheTtlMs : FAILED_DETAILS_TTL_MS),
    });
    return value;
  }

  const needsDetails = (station) =>
    station.latitude === undefined || station.longitude === undefined || (kind === 'ev' && station.connectorTypes === undefined);

  async function loadArea(center, radiusMeters) {
    const stations = await searchNearby(center, radiusMeters);
    const enriched = await Promise.all(stations.map(async (station, index) => {
      if (index >= config.detailsLimit || !needsDetails(station)) return station;
      const details = await placeDetails(station.mapplsPlaceId);
      if (!details) return station;
      // Values from the nearby result win; details only fill what is missing.
      return { ...withoutUndefined(details), ...withoutUndefined(station) };
    }));
    return enriched;
  }

  /**
   * Stations within `radiusMeters` of the customer, nearest first.
   * Searches are shared per ~110 m area and cached; simultaneous requests
   * for the same area make a single Mappls call.
   */
  async function findStations({ lat, lng, radiusMeters }) {
    if (!config.apiKey) {
      throw new EvChargingError(`${KINDS[kind].label} search is not configured.`, 503, `${kind}_search_unavailable`);
    }
    const origin = { lat: Number(lat), lng: Number(lng) };
    if (!(Math.abs(origin.lat) <= 90) || !(Math.abs(origin.lng) <= 180) || (origin.lat === 0 && origin.lng === 0)) {
      throw new EvChargingError('Pass a valid lat and lng.', 400, `${kind}_location_invalid`);
    }
    const radius = Math.round(boundedNumber(radiusMeters, config.defaultRadiusMeters, MIN_RADIUS_METERS, MAX_RADIUS_METERS));
    const center = { lat: Number(origin.lat.toFixed(3)), lng: Number(origin.lng.toFixed(3)) };
    const key = `${center.lat},${center.lng}:${radius}`;

    let stations;
    const cached = searchCache.get(key);
    if (cached && cached.expiresAt > now()) {
      stations = cached.stations;
    } else {
      if (!inFlight.has(key)) {
        inFlight.set(key, loadArea(center, radius)
          .then((result) => {
            boundedSet(searchCache, key, { stations: result, expiresAt: now() + config.searchCacheTtlMs });
            return result;
          })
          .finally(() => inFlight.delete(key)));
      }
      stations = await inFlight.get(key);
    }

    const located = (station) => station.latitude !== undefined && station.longitude !== undefined;
    const results = stations
      .map((station) => {
        const { providerDistanceMeters, ...rest } = station;
        const distance = located(station)
          ? Math.round(distanceMeters(origin, { lat: station.latitude, lng: station.longitude }))
          : providerDistanceMeters;
        return withoutUndefined({
          ...rest,
          latitude: rest.latitude ?? null,
          longitude: rest.longitude ?? null,
          distance,
          isOpen: openStatusFromHours(rest.openingHours?.[0], now()),
          // No live occupancy source yet; kept explicit so one can be added later.
          availability: kind === 'ev' ? { status: 'unknown' } : undefined,
        });
      })
      .sort((left, right) => (left.distance ?? Infinity) - (right.distance ?? Infinity));

    return {
      source: 'mappls',
      radiusMeters: radius,
      stations: results,
      total: results.length,
      located: results.filter((station) => station.latitude !== null).length,
    };
  }

  return { findStations };
}

export const createFuelStationService = (options = {}) =>
  createEvChargingService({ ...options, config: options.config ?? getFuelStationConfig() });

let evService = null;
let fuelService = null;

export function getEvChargingService() {
  if (!evService) evService = createEvChargingService();
  return evService;
}

export function getFuelStationService() {
  if (!fuelService) fuelService = createFuelStationService();
  return fuelService;
}
