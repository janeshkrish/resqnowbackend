const LOCAL_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5173",
  "https://reqnow.org",
  "https://www.reqnow.org",
];

const TUNNEL_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.ngrok-free\.app$/i,
  /^https:\/\/[a-z0-9-]+\.ngrok\.io$/i,
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i,
];

const VERCEL_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

const LAN_ORIGIN_PATTERN =
  /^https?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$/i;

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

function parseEnvOrigins(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((item) => normalizeUrl(item))
    .filter(Boolean);
}

function defaultFrontendUrl() {
  return normalizeUrl(process.env.FRONTEND_URL) || "https://reqnow.org";
}

function defaultBackendUrl() {
  const configured = normalizeUrl(process.env.BACKEND_URL);
  if (configured) return configured;
  const renderPublicUrl = normalizeUrl(process.env.RENDER_EXTERNAL_URL);
  if (renderPublicUrl) return renderPublicUrl;
  const port = process.env.PORT || "3001";
  return `http://localhost:${port}`;
}

export function getFrontendUrl() {
  return normalizeUrl(process.env.FRONTEND_PUBLIC_URL) || defaultFrontendUrl();
}

export function getBackendPublicUrl() {
  return normalizeUrl(process.env.BACKEND_PUBLIC_URL) || defaultBackendUrl();
}

function getCorsAllowedOrigins() {
  const explicit = parseEnvOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const dynamic = [
    normalizeUrl(process.env.FRONTEND_URL),
    normalizeUrl(process.env.FRONTEND_PUBLIC_URL),
  ].filter(Boolean);

  return new Set([...LOCAL_ORIGINS, ...dynamic, ...explicit]);
}

export function isOriginAllowed(origin) {
  if (!origin) return true;
  if (String(process.env.CORS_ALLOW_ALL).toLowerCase() === "true") return true;

  const normalizedOrigin = normalizeUrl(origin);
  const allowedOrigins = getCorsAllowedOrigins();
  if (allowedOrigins.has(normalizedOrigin)) return true;

  if (String(process.env.CORS_ALLOW_LAN_ORIGINS || "true").toLowerCase() === "true") {
    if (LAN_ORIGIN_PATTERN.test(normalizedOrigin)) return true;
  }

  if (String(process.env.CORS_ALLOW_TUNNEL_ORIGINS || "true").toLowerCase() === "true") {
    if (TUNNEL_ORIGIN_PATTERNS.some((pattern) => pattern.test(normalizedOrigin))) return true;
  }

  if (String(process.env.CORS_ALLOW_VERCEL_ORIGINS || "true").toLowerCase() === "true") {
    if (VERCEL_ORIGIN_PATTERN.test(normalizedOrigin)) return true;
  }

  return false;
}

export function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error(`CORS policy violation for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    maxAge: 86400,
  };
}

export function getAllowedOriginsForLogs() {
  return Array.from(getCorsAllowedOrigins());
}
