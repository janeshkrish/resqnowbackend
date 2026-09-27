import axios from 'axios';

// A representative photo for a car or bike model: the main free image of the
// model's English Wikipedia article, with the credit its licence requires.
// Looked up the first time a model is shown and remembered; nothing is
// downloaded or stored here, the app shows the image from Wikimedia.

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'ResQNow/1.0 (support@resqnow.com)';
const FOUND_TTL_MS = 7 * 24 * 60 * 60_000;
const MISSING_TTL_MS = 24 * 60 * 60_000;
const FAILED_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 5_000;

// How Wikipedia titles name each brand's models ("Maruti Suzuki Swift" is "Suzuki Swift").
const BRAND_PREFIXES = {
  'maruti suzuki': ['Maruti Suzuki', 'Suzuki'], 'tata motors': ['Tata'], 'honda cars': ['Honda'],
  'honda motorcycles': ['Honda'], 'mg motor': ['MG'], 'force motors': ['Force'], 'hero motocorp': ['Hero', 'Hero Honda'],
  'tvs motor': ['TVS'], 'tvs electric': ['TVS'], 'jawa / yezdi': ['Jawa'], 'ola electric': ['Ola'],
  'ather energy': ['Ather'], 'simple energy': ['Simple'], 'revolt motors': ['Revolt'], 'bajaj electric': ['Bajaj'],
};
const VEHICLE_WORDS = /\b(car|cars|automobile|vehicle|suv|hatchback|sedan|saloon|crossover|mpv|minivan|multi-purpose|pickup|coupe|roadster|motorcycle|motorbike|scooter|moped|bike|truck|van|compact|supermini|estate|off-road)\b/i;
const GENERIC_TOKENS = new Set(['the', 'and', 'of', 'new', 'old', 'gen', '1st', '2nd', '3rd', 'series', 'class']);

const stripHtml = (value) => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** "Activa 3G/4G/5G/6G" → "Activa 3G", "Swift (1st Gen)" → "Swift". */
export function cleanModelName(model) {
  let value = String(model || '').replace(/\(.*?\)/g, ' ');
  if (/\w\/\w/.test(value)) value = value.split('/')[0];
  return value.replace(/\s+/g, ' ').trim();
}

function tokens(text) {
  return String(text || '').toLowerCase().replace(/\+/g, ' plus ').split(/[^a-z0-9]+/)
    .filter((token) => token && (token.length >= 2 || /\d/.test(token)) && !GENERIC_TOKENS.has(token));
}

export function searchQueries(make, model) {
  const cleaned = cleanModelName(model);
  const prefixes = BRAND_PREFIXES[String(make || '').trim().toLowerCase()] || [String(make || '').trim()];
  const first = cleaned.split(' ')[0].toLowerCase();
  if (prefixes.some((prefix) => prefix.split(' ')[0].toLowerCase() === first)) return [cleaned];
  return prefixes.filter(Boolean).map((prefix) => `${prefix} ${cleaned}`);
}

/** The search result that is this model's own article: every model word in the title, described as a vehicle, with a free lead image. */
export function pickArticle(pages, model) {
  const wanted = tokens(cleanModelName(model));
  if (!wanted.length) return null;
  const ranked = [...pages].sort((left, right) => (left.index ?? 99) - (right.index ?? 99));
  return ranked.find((page) => {
    const image = page.pageprops?.page_image_free;
    if (!image) return false;
    const title = String(page.title || '').toLowerCase();
    const titleTokens = new Set(tokens(title));
    const matches = wanted.every((token) => titleTokens.has(token) || title.replace(/\s+/g, '').includes(token));
    return matches && VEHICLE_WORDS.test(`${page.description || ''} ${page.title || ''}`);
  }) || null;
}

export function createVehiclePhotoService({ http = axios, now = () => Date.now(), warn = console.warn, timeoutMs = 6_000 } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const remember = (key, value, ttl) => {
    cache.set(key, { value, expiresAt: now() + ttl });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  };

  const get = (url, params) => http.get(url, {
    params: { ...params, format: 'json', formatversion: 2 },
    timeout: timeoutMs,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });

  async function findArticle(make, model) {
    for (const query of searchQueries(make, model)) {
      const { data } = await get(WIKIPEDIA_API, {
        action: 'query', generator: 'search', gsrsearch: query, gsrlimit: 5, gsrnamespace: 0,
        prop: 'pageprops|description', ppprop: 'page_image_free', redirects: 1,
      });
      const article = pickArticle(data?.query?.pages || [], model);
      if (article) return article;
    }
    return null;
  }

  async function lookup(make, model) {
    let article = await findArticle(make, model);
    // "Activa 3G" or "Splendor+" may only have an article for the wider family.
    const words = cleanModelName(model).split(' ');
    if (!article && words.length > 1) article = await findArticle(make, words.slice(0, -1).join(' '));
    if (!article && /\+$/.test(cleanModelName(model))) article = await findArticle(make, cleanModelName(model).replace(/\+$/, ''));
    if (!article) return null;

    const file = `File:${article.pageprops.page_image_free}`;
    const { data } = await get(COMMONS_API, {
      action: 'query', titles: file, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: 960,
    });
    const info = data?.query?.pages?.[0]?.imageinfo?.[0];
    if (!info?.thumburl && !info?.url) return null;
    const meta = info.extmetadata || {};
    return {
      // Wikimedia adds tracking parameters to image links; the image doesn't need them.
      url: String(info.thumburl || info.url).split('?')[0],
      width: info.thumbwidth || info.width || null,
      height: info.thumbheight || info.height || null,
      article: article.title,
      credit: {
        author: stripHtml(meta.Artist?.value) || 'Unknown author',
        license: stripHtml(meta.LicenseShortName?.value) || 'See source',
        source: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(file)}`,
      },
    };
  }

  /** The photo for a make and model, or null when Wikipedia has no suitable one. */
  async function findPhoto({ make, model }) {
    const key = `${String(make).trim().toLowerCase()}|${String(model).trim().toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!inFlight.has(key)) {
      inFlight.set(key, lookup(make, model)
        .then((photo) => {
          remember(key, photo, photo ? FOUND_TTL_MS : MISSING_TTL_MS);
          return photo;
        })
        .catch((error) => {
          warn(`[VehiclePhoto] Lookup failed for ${make} ${model}: ${error?.response?.status || error?.code || 'error'}`);
          remember(key, null, FAILED_TTL_MS);
          return null;
        })
        .finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  return { findPhoto };
}

let service = null;
export function getVehiclePhotoService() {
  if (!service) service = createVehiclePhotoService();
  return service;
}
