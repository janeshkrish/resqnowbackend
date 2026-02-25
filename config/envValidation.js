import { getBackendPublicUrl, getFrontendUrl, getGoogleCallbackUrl } from "./network.js";

const REQUIRED_ENV_KEYS = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "JWT_SECRET",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "EMAIL_USER",
  "EMAIL_PASS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "FRONTEND_URL",
];

const SECRET_KEYS = new Set([
  "DB_PASSWORD",
  "JWT_SECRET",
  "ADMIN_PASSWORD",
  "RAZORPAY_KEY_SECRET",
  "EMAIL_PASS",
  "GOOGLE_CLIENT_SECRET",
]);

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function parseUrlOrThrow(name, value) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateHost(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  return isPrivateIpv4(normalized);
}

function envState(key) {
  const value = String(process.env[key] || "").trim();
  if (!value) return "missing";
  if (SECRET_KEYS.has(key)) return "set";
  return value;
}

export function validateEnvironmentOrThrow() {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !String(process.env[key] || "").trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const frontendUrl = normalizeUrl(getFrontendUrl());
  const backendPublicUrl = normalizeUrl(getBackendPublicUrl());
  const googleCallbackUrl = normalizeUrl(getGoogleCallbackUrl());

  const frontend = parseUrlOrThrow("FRONTEND_URL", frontendUrl);
  const backend = parseUrlOrThrow("BACKEND_URL/BACKEND_PUBLIC_URL", backendPublicUrl);
  const googleCallback = parseUrlOrThrow("GOOGLE_CALLBACK_URL", googleCallbackUrl);

  if (isProductionLike()) {
    if (frontend.protocol !== "https:") {
      throw new Error(`FRONTEND_URL must use https in production. Received: ${frontendUrl}`);
    }
    if (backend.protocol !== "https:") {
      throw new Error(`BACKEND_URL must use https in production. Received: ${backendPublicUrl}`);
    }
    if (googleCallback.protocol !== "https:") {
      throw new Error(`GOOGLE_CALLBACK_URL must use https in production. Received: ${googleCallbackUrl}`);
    }
    if (isPrivateHost(backend.hostname)) {
      throw new Error(`BACKEND_URL cannot point to localhost/private host in production. Received: ${backendPublicUrl}`);
    }
  }

  const expectedGoogleCallback = `${backendPublicUrl}/auth/google/callback`;
  if (googleCallbackUrl !== expectedGoogleCallback) {
    throw new Error(
      `GOOGLE_CALLBACK_URL should match ${expectedGoogleCallback}. Received: ${googleCallbackUrl}`
    );
  }
}

export function logEnvironmentSummary() {
  const summary = {};
  for (const key of REQUIRED_ENV_KEYS) {
    summary[key] = envState(key);
  }
  summary.NODE_ENV = String(process.env.NODE_ENV || "development");
  summary.BACKEND_PUBLIC_URL = normalizeUrl(getBackendPublicUrl()) || "missing";
  summary.FRONTEND_EFFECTIVE_URL = normalizeUrl(getFrontendUrl()) || "missing";
  summary.GOOGLE_CALLBACK_EFFECTIVE_URL = normalizeUrl(getGoogleCallbackUrl()) || "missing";
  console.log("[ENV] Required variable summary:", summary);
}
