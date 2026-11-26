import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Single admin account, configured in the environment:
//   ADMIN_EMAIL            the admin's email
//   ADMIN_PASSWORD_HASH    bcrypt hash of the password (cost >= 10); make one with
//                          `npm run admin:hash-password`
//   ADMIN_SESSION_VERSION  positive integer, default 1. Raise it to sign every admin
//                          out (REST and live sockets) without a redeploy of code.
// The old plaintext ADMIN_PASSWORD is ignored.

const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
const MIN_COST = 10;
export const ADMIN_TOKEN_TTL = "8h";

function configuredHash(env) {
  const hash = String(env.ADMIN_PASSWORD_HASH || "").trim();
  const match = BCRYPT_HASH.exec(hash);
  if (!match || Number(match[1]) < MIN_COST) return null;
  return { hash, cost: Number(match[1]) };
}

export function adminEmail(env = process.env) {
  return String(env.ADMIN_EMAIL || "").trim().toLowerCase();
}

/** Current admin session version, or null when misconfigured (callers fail closed). */
export function currentAdminSessionVersion(env = process.env) {
  const raw = String(env.ADMIN_SESSION_VERSION ?? "").trim();
  if (!raw) return 1;
  if (!/^[1-9]\d{0,8}$/.test(raw)) return null;
  return Number(raw);
}

export function isCurrentAdminSession(sessionVersion, env = process.env) {
  const current = currentAdminSessionVersion(env);
  return current !== null && Number.isSafeInteger(sessionVersion) && sessionVersion === current;
}

export function adminLoginConfigured(env = process.env) {
  return Boolean(adminEmail(env) && configuredHash(env) && currentAdminSessionVersion(env) !== null);
}

const dummyHashes = new Map();
function dummyHash(cost) {
  if (!dummyHashes.has(cost)) dummyHashes.set(cost, bcrypt.hash(crypto.randomBytes(24).toString("hex"), cost));
  return dummyHashes.get(cost);
}

/**
 * Returns "ok" | "invalid" | "not_configured".
 * A wrong email still runs a bcrypt comparison of the same cost, so response time
 * does not reveal which email is the admin's.
 */
export async function checkAdminLogin(email, password, env = process.env) {
  const expectedEmail = adminEmail(env);
  const stored = configuredHash(env);
  if (!expectedEmail || !stored || currentAdminSessionVersion(env) === null) return "not_configured";
  const emailMatches = String(email || "").trim().toLowerCase() === expectedEmail;
  const candidate = emailMatches ? stored.hash : await dummyHash(stored.cost);
  const passwordMatches = await bcrypt.compare(String(password || ""), candidate);
  return emailMatches && passwordMatches ? "ok" : "invalid";
}

/** Startup warnings only; never blocks the API (customers and technicians must keep working). */
export function adminConfigWarnings(env = process.env) {
  const warnings = [];
  if (String(env.ADMIN_PASSWORD || "").trim()) {
    warnings.push("ADMIN_PASSWORD (plaintext) is set but no longer used. Remove it from the environment.");
  }
  if (!configuredHash(env)) {
    warnings.push("ADMIN_PASSWORD_HASH is missing or not a bcrypt hash with cost >= 10. Admin sign-in is disabled until it is set (npm run admin:hash-password).");
  }
  if (currentAdminSessionVersion(env) === null) {
    warnings.push("ADMIN_SESSION_VERSION must be a positive whole number. Admin sign-in and admin sessions are disabled.");
  }
  return warnings;
}
