const LOCAL_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5173",
];

const PROD_ORIGINS = [
  "https://resqnow.org",
  "https://www.resqnow.org",
  // Backward-compatible allowance if old domain is still in use.
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

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function defaultFrontendUrl() {
  return normalizeUrl(process.env.FRONTEND_URL) || "https://resqnow.org";
}

function defaultBackendUrl() {
  const renderPublicUrl = normalizeUrl(process.env.RENDER_EXTERNAL_URL);
  if (renderPublicUrl) return renderPublicUrl;

  const configured = normalizeUrl(process.env.BACKEND_URL);
  if (configured) return configured;

  if (isProductionLike()) {
    return "https://resqnowbackend.onrender.com";
  }

  const port = process.env.PORT || "3001";
  return `http://localhost:${port}`;
}

export function getFrontendUrl() {
  return normalizeUrl(process.env.FRONTEND_PUBLIC_URL) || defaultFrontendUrl();
}

export function getBackendPublicUrl() {
  return normalizeUrl(process.env.BACKEND_PUBLIC_URL) || defaultBackendUrl();
}

export function getApiBaseUrl() {
  return getBackendPublicUrl();
}

export function getGoogleCallbackUrl() {
  let explicit = normalizeUrl(process.env.GOOGLE_CALLBACK_URL);
  if (explicit) {
    // make sure we always include the standard callback path; if the value is just the
    // domain the developer probably forgot to append it.  append automatically so the
    // API still works, but log a warning to make the misconfiguration visible.
    const expectedSuffix = "/auth/google/callback";
    if (!explicit.endsWith(expectedSuffix)) {
      // simple domain case (no path)
      if (/^https?:\/\/[^\/]+$/i.test(explicit)) {
        console.warn(
          `[network] GOOGLE_CALLBACK_URL appears to be missing callback path, auto‑appending ${expectedSuffix}`
        );
        explicit = explicit + expectedSuffix;
      } else {
        // custom path provided that doesn't match convention; keep as‑is but log
        console.warn(
          `[network] GOOGLE_CALLBACK_URL does not end with ${expectedSuffix}; using provided value ${explicit}`
        );
      }
    }
    return explicit;
  }
  return `${getBackendPublicUrl()}/auth/google/callback`;
}

function getCorsAllowedOrigins() {
  const explicit = parseEnvOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const dynamic = [
    normalizeUrl(process.env.FRONTEND_URL),
    normalizeUrl(process.env.FRONTEND_PUBLIC_URL),
    normalizeUrl(process.env.BACKEND_URL),
    normalizeUrl(process.env.BACKEND_PUBLIC_URL),
  ].filter(Boolean);

  const includeLocalOrigins =
    String(process.env.CORS_INCLUDE_LOCAL_ORIGINS || (!isProductionLike())).toLowerCase() === "true";

  return new Set([
    ...(includeLocalOrigins ? LOCAL_ORIGINS : []),
    ...PROD_ORIGINS,
    ...dynamic,
    ...explicit,
  ]);
}

function envFlagOrDefault(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return defaultValue;
  return String(raw).toLowerCase() === "true";
}

export function isOriginAllowed(origin) {
  if (!origin) return true;
  if (String(process.env.CORS_ALLOW_ALL).toLowerCase() === "true") return true;

  const normalizedOrigin = normalizeUrl(origin);
  const allowedOrigins = getCorsAllowedOrigins();
  if (allowedOrigins.has(normalizedOrigin)) return true;

  const allowLanOrigins = envFlagOrDefault("CORS_ALLOW_LAN_ORIGINS", !isProductionLike());
  if (allowLanOrigins) {
    if (LAN_ORIGIN_PATTERN.test(normalizedOrigin)) return true;
  }

  const allowTunnelOrigins = envFlagOrDefault("CORS_ALLOW_TUNNEL_ORIGINS", !isProductionLike());
  if (allowTunnelOrigins) {
    if (TUNNEL_ORIGIN_PATTERNS.some((pattern) => pattern.test(normalizedOrigin))) return true;
  }

  const allowVercelOrigins = envFlagOrDefault("CORS_ALLOW_VERCEL_ORIGINS", false);
  if (allowVercelOrigins) {
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
    exposedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  };
}

export function getAllowedOriginsForLogs() {
  return Array.from(getCorsAllowedOrigins()).sort();
}
