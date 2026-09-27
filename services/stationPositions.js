import axios from 'axios';
import { distanceMeters } from './liveTrackingContract.js';
import { searchLocations } from './locationProviderService.js';

// Map positions for radar stations when Mappls does not share coordinates.
//
// Mappls tells us each station's name, brand, address and distance from the
// search centre, but not where it is. OpenStreetMap does know where most fuel
// pumps (and some chargers) are, so a station is placed on an OpenStreetMap
// feature only when the brand (or a distinctive name) matches AND the
// feature's distance from the centre agrees with the Mappls distance. A
// station with no confident match stays unplaced. Positions come from
// OpenStreetMap (© OpenStreetMap contributors, ODbL) and are only used to draw
// pins; station details keep coming from Mappls.

// Public Overpass servers are often busy, so the next one is tried when one fails.
const DEFAULT_OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_AMENITY = { ev: 'charging_station', fuel: 'fuel' };
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const AREA_TTL_MS = 24 * 60 * 60_000;
// After a failed lookup, stations are tried again this soon instead of a day later.
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
// One area lookup covers a ~1 km cell plus the search radius, shared by everyone in it.
const AREA_MARGIN_METERS = 1_500;
const POSITION_TTL_MS = 7 * 24 * 60 * 60_000;
const MISS_TTL_MS = 24 * 60 * 60_000;
// Nominatim's usage policy allows one request per second.
const LOOKUP_SPACING_MS = 1_100;
const MAX_QUEUED_LOOKUPS = 60;
const MAX_CACHE_ENTRIES = 5_000;
// A runner-up this close to the best candidate makes the match ambiguous.
const AMBIGUITY_MARGIN_METERS = 60;

const BRAND_PATTERNS = {
  indianoil: /indian\s*oil|\biocl?\b/i,
  bpcl: /bharath?\s*petroleum|\bbpcl\b/i,
  hpcl: /hindustan\s*petroleum|\bhpcl\b|\bhp\b/i,
  nayara: /nayara|\bessar\b/i,
  shell: /\bshell\b/i,
  jiobp: /jio[\s-]*bp|\bjio\b|reliance|bp\s*pulse/i,
  tatapower: /tata\s*power|ez\s*charge/i,
  statiq: /statiq/i,
  chargezone: /charge\s*zone/i,
  zeon: /\bzeon\b/i,
  ather: /\bather\b/i,
};

const GENERIC_WORDS = new Set([
  'electric', 'vehicle', 'vehicles', 'charging', 'charger', 'chargers', 'charge', 'station', 'stations', 'point', 'hub',
  'petrol', 'pump', 'fuel', 'filling', 'service', 'services', 'cng', 'gas', 'city', 'the', 'and', 'of', 'centre', 'center',
]);

// Tolerances for how far an OpenStreetMap feature's distance from the centre
// may differ from the Mappls distance for the same station.
const tagTolerance = (meters) => Math.max(100, meters * 0.12);
const venueTolerance = (meters) => Math.max(100, meters * 0.2);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How to recognise the station in OpenStreetMap tags: its brand, else a distinctive word of its name. */
function identity(station) {
  if (station.brand && BRAND_PATTERNS[station.brand]) return BRAND_PATTERNS[station.brand];
  const word = String(station.name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((token) => token.length >= 4 && !GENERIC_WORDS.has(token));
  return word ? new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i') : null;
}

function normalizeElement(element) {
  const lat = Number(element?.lat ?? element?.center?.lat);
  const lng = Number(element?.lon ?? element?.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const tags = element.tags || {};
  const text = ['brand', 'brand:en', 'name', 'name:en', 'operator', 'network']
    .map((key) => tags[key])
    .filter(Boolean)
    .join(' ');
  return { id: `${element.type}/${element.id}`, lat, lng, text };
}

/**
 * Pairs stations with OpenStreetMap features. Each feature is used once, and a
 * station whose best feature is barely better than the next is left unplaced.
 */
export function matchStations(stations, elements, center) {
  const candidates = [];
  for (const station of stations) {
    const pattern = identity(station);
    const reported = Number(station.providerDistanceMeters);
    if (!pattern || !Number.isFinite(reported)) continue;
    const options = elements
      .filter((element) => pattern.test(element.text))
      .map((element) => ({ element, gap: Math.abs(distanceMeters(center, element) - reported) }))
      .filter((option) => option.gap <= tagTolerance(reported))
      .sort((left, right) => left.gap - right.gap);
    if (!options.length) continue;
    if (options[1] && options[1].gap - options[0].gap < AMBIGUITY_MARGIN_METERS) continue;
    candidates.push({ station, ...options[0] });
  }

  const placed = new Map();
  const used = new Set();
  for (const candidate of candidates.sort((left, right) => left.gap - right.gap)) {
    if (used.has(candidate.element.id)) continue;
    used.add(candidate.element.id);
    placed.set(candidate.station.mapplsPlaceId, { lat: candidate.element.lat, lng: candidate.element.lng });
  }
  return placed;
}

/** "JW Marriott Hotel UB City, 24/1, Vittal Mallya Road, …, Bengaluru, Karnataka, 560001" → "JW Marriott Hotel UB City, Bengaluru". */
export function venueQuery(station) {
  const parts = String(station.address || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const venue = parts[0];
  if (/^\d/.test(venue) || venue.length < 4) return null;
  const city = parts.length >= 3 ? parts[parts.length - 3] : parts[parts.length - 1];
  return venue === city ? venue : `${venue}, ${city}`;
}

function viewboxAround(center, radiusMeters) {
  const dLat = (radiusMeters + 500) / 111_320;
  const dLng = dLat / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  const f = (value) => value.toFixed(5);
  return `${f(center.lng - dLng)},${f(center.lat + dLat)},${f(center.lng + dLng)},${f(center.lat - dLat)}`;
}

export function createStationPositioner({
  http = axios,
  search = searchLocations,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  warn = (message) => console.warn(message),
  overpassUrls = DEFAULT_OVERPASS_URLS,
  userAgent = 'ResQNow/1.0 (support@resqnow.com)',
  // Area lookups run in the background, so a slow Overpass server never delays the radar.
  timeoutMs = 25_000,
} = {}) {
  const areas = new Map();
  const areaLoads = new Map();
  const positions = new Map();
  const queue = [];
  const queued = new Set();
  let draining = false;

  const remember = (map, key, value) => {
    map.set(key, value);
    if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
  };
  const fresh = (entry) => entry && entry.expiresAt > now();

  const cellOf = (center) => ({ lat: Number(center.lat.toFixed(2)), lng: Number(center.lng.toFixed(2)) });
  const areaKey = (kind, center, radiusMeters) => {
    const cell = cellOf(center);
    return `${kind}:${cell.lat},${cell.lng}:${radiusMeters}`;
  };

  async function fetchArea(kind, center, radiusMeters) {
    const cell = cellOf(center);
    const around = Math.round(radiusMeters + AREA_MARGIN_METERS);
    const query = `[out:json][timeout:25];nwr["amenity"="${OSM_AMENITY[kind]}"](around:${around},${cell.lat},${cell.lng});out center tags;`;
    const statuses = [];
    for (const url of overpassUrls) {
      try {
        const response = await http.post(url, new URLSearchParams({ data: query }).toString(), {
          timeout: timeoutMs,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgent, Accept: 'application/json' },
          validateStatus: () => true,
        });
        if (response.status === 200 && Array.isArray(response.data?.elements)) {
          return { elements: response.data.elements.map(normalizeElement).filter(Boolean), failed: false, expiresAt: now() + AREA_TTL_MS };
        }
        statuses.push(response.status);
      } catch {
        statuses.push('timeout');
      }
    }
    warn(`[Radar] OpenStreetMap ${kind} lookup failed (${statuses.join(', ')}); trying again in 10 minutes.`);
    return { elements: [], failed: true, expiresAt: now() + RETRY_AFTER_FAILURE_MS };
  }

  function areaElements(kind, center, radiusMeters) {
    const key = areaKey(kind, center, radiusMeters);
    if (!areaLoads.has(key)) {
      areaLoads.set(key, fetchArea(kind, center, radiusMeters)
        .then((entry) => {
          remember(areas, key, entry);
          return entry;
        })
        .finally(() => areaLoads.delete(key)));
    }
    return areaLoads.get(key);
  }

  function drain() {
    if (draining) return;
    const job = queue.shift();
    if (!job) return;
    draining = true;
    search({ query: job.query, limit: 3, provider: 'nominatim', viewbox: job.viewbox, bounded: 1 })
      .then((result) => {
        const best = (result?.results || [])
          .map((place) => ({ place, gap: Math.abs(distanceMeters(job.center, place) - job.reported) }))
          .filter((option) => option.gap <= venueTolerance(job.reported))
          .sort((left, right) => left.gap - right.gap)[0];
        remember(positions, job.placeId, best
          ? { position: { lat: best.place.lat, lng: best.place.lng }, expiresAt: now() + POSITION_TTL_MS }
          : { position: null, expiresAt: now() + job.missTtl });
      })
      .catch(() => {
        remember(positions, job.placeId, { position: null, expiresAt: now() + RETRY_AFTER_FAILURE_MS });
      })
      .finally(() => {
        queued.delete(job.placeId);
        draining = false;
        if (queue.length) schedule(drain, LOOKUP_SPACING_MS);
      });
  }

  function enqueueVenueLookup(station, center, radiusMeters, missTtl) {
    const query = venueQuery(station);
    const reported = Number(station.providerDistanceMeters);
    if (!query || !Number.isFinite(reported) || queued.size >= MAX_QUEUED_LOOKUPS) return false;
    queued.add(station.mapplsPlaceId);
    queue.push({ placeId: station.mapplsPlaceId, query, reported, center, missTtl, viewbox: viewboxAround(center, radiusMeters) });
    if (!draining) schedule(drain, 0);
    return true;
  }

  /** Matches stations against an area's features; the rest are looked up by venue. Returns true while lookups run. */
  function settle(stations, area, center, radiusMeters) {
    const matched = matchStations(stations, area.elements, center);
    // Without area data a miss says little, so it is retried soon.
    const missTtl = area.failed ? RETRY_AFTER_FAILURE_MS : MISS_TTL_MS;
    let pending = false;
    for (const station of stations) {
      const position = matched.get(station.mapplsPlaceId);
      if (position) {
        remember(positions, station.mapplsPlaceId, { position, expiresAt: now() + POSITION_TTL_MS });
      } else if (queued.has(station.mapplsPlaceId) || enqueueVenueLookup(station, center, radiusMeters, missTtl)) {
        pending = true;
      } else {
        remember(positions, station.mapplsPlaceId, { position: null, expiresAt: now() + missTtl });
      }
    }
    return pending;
  }

  /**
   * Adds OpenStreetMap positions to stations Mappls left unplaced. Never waits
   * on the network: positions found in the background show up on a later call,
   * and `pending` says whether that is worth asking for.
   */
  async function place({ kind, center, radiusMeters, stations }) {
    const unplaced = stations.filter((station) => station.latitude === undefined && station.mapplsPlaceId);
    if (!unplaced.length || !OSM_AMENITY[kind]) return { stations, pending: false };

    const unknown = unplaced.filter((station) => !fresh(positions.get(station.mapplsPlaceId)));
    let pending = false;
    if (unknown.length) {
      const area = areas.get(areaKey(kind, center, radiusMeters));
      if (fresh(area)) {
        pending = settle(unknown, area, center, radiusMeters);
      } else {
        pending = true;
        areaElements(kind, center, radiusMeters)
          .then((loaded) => settle(unknown, loaded, center, radiusMeters))
          .catch(() => {});
      }
    }

    return {
      pending,
      stations: stations.map((station) => {
        const position = station.latitude === undefined ? positions.get(station.mapplsPlaceId)?.position : null;
        return position
          ? { ...station, latitude: position.lat, longitude: position.lng, positionSource: 'osm' }
          : station;
      }),
    };
  }

  return { place };
}

let positioner = null;

/** Shared positioner, or null when turned off with STATION_POSITIONS=off. */
export function getStationPositioner(env = process.env) {
  if (String(env.STATION_POSITIONS || 'osm').trim().toLowerCase() === 'off') return null;
  if (!positioner) {
    const urls = String(env.OVERPASS_URL || '').split(',').map((url) => url.trim()).filter(Boolean);
    positioner = createStationPositioner({
      overpassUrls: urls.length ? urls : DEFAULT_OVERPASS_URLS,
      userAgent: String(env.LOCATION_PROVIDER_USER_AGENT || 'ResQNow/1.0 (support@resqnow.com)').trim(),
    });
  }
  return positioner;
}
