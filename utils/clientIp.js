/**
 * Helper to safely extract client IP behind reverse proxies (Cloudflare, Railway, Render, Netlify, Vercel).
 */

export function normalizeIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return '127.0.0.1';
  let ip = rawIp.trim();

  // Strip port if present in IPv4 (e.g. 192.168.1.1:54321)
  if (/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }

  // Normalize IPv6 mapped IPv4 (e.g. ::ffff:192.168.1.1 -> 192.168.1.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }

  // Normalize IPv6 localhost
  if (ip === '::1' || ip === 'localhost') {
    ip = '127.0.0.1';
  }

  return ip;
}

export function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  const normalized = normalizeIp(ip);

  if (normalized === '127.0.0.1' || normalized === 'localhost') return true;

  // RFC1918 Private IPv4 ranges
  // 10.0.0.0/8
  if (/^10\./.test(normalized)) return true;
  // 172.16.0.0/12
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalized)) return true;
  // 192.168.0.0/16
  if (/^192\.168\./.test(normalized)) return true;
  // Link-local / CGNAT
  if (/^169\.254\./.test(normalized) || /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./.test(normalized)) return true;

  // IPv6 local/private
  if (normalized.startsWith('fc00:') || normalized.startsWith('fd00:') || normalized.startsWith('fe80:')) return true;

  return false;
}

export function extractClientIp(req) {
  if (!req) return '127.0.0.1';

  // 1. Cloudflare header
  const cfConnectingIp = req.headers?.['cf-connecting-ip'];
  if (cfConnectingIp && typeof cfConnectingIp === 'string') {
    return normalizeIp(cfConnectingIp);
  }

  // 2. Standard proxy header (X-Forwarded-For: client, proxy1, proxy2)
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    const first = forwarded.split(',')[0];
    if (first) return normalizeIp(first);
  }

  // 3. X-Real-IP
  const realIp = req.headers?.['x-real-ip'];
  if (realIp && typeof realIp === 'string') {
    return normalizeIp(realIp);
  }

  // 4. Express req.ips (if trust proxy is enabled)
  if (Array.isArray(req.ips) && req.ips.length > 0) {
    return normalizeIp(req.ips[0]);
  }

  // 5. req.ip or socket remote address
  return normalizeIp(req.ip || req.socket?.remoteAddress || '127.0.0.1');
}
