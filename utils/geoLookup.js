import geoip from 'geoip-lite';
import { isPrivateOrLocalIp, normalizeIp } from './clientIp.js';

// Light in-memory cache to avoid redundant lookups
const GEO_CACHE = new Map();
const MAX_CACHE_SIZE = 5000;

export function resolveLocationFromIp(rawIp) {
  const ip = normalizeIp(rawIp);

  if (!ip || isPrivateOrLocalIp(ip)) {
    return 'Local/Unknown';
  }

  if (GEO_CACHE.has(ip)) {
    return GEO_CACHE.get(ip);
  }

  try {
    const geo = geoip.lookup(ip);
    if (!geo) {
      if (GEO_CACHE.size >= MAX_CACHE_SIZE) GEO_CACHE.clear();
      GEO_CACHE.set(ip, 'Unknown');
      return 'Unknown';
    }

    const parts = [];
    if (geo.city && typeof geo.city === 'string' && geo.city.trim()) {
      parts.push(geo.city.trim());
    }
    if (geo.region && typeof geo.region === 'string' && geo.region.trim()) {
      parts.push(geo.region.trim());
    }
    if (geo.country && typeof geo.country === 'string' && geo.country.trim()) {
      parts.push(geo.country.trim());
    }

    const location = parts.length > 0 ? parts.join(', ') : 'Unknown';

    if (GEO_CACHE.size >= MAX_CACHE_SIZE) GEO_CACHE.clear();
    GEO_CACHE.set(ip, location);
    return location;
  } catch {
    return 'Unknown';
  }
}
