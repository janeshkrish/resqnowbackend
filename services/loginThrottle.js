import crypto from "node:crypto";
import { getPool } from "../db.js";
import { normalizeIp } from "../utils/clientIp.js";

// Brute-force protection for credential endpoints.
//
// - Per account: every attempt counts, atomically, so parallel guesses cannot
//   slip past the limit. A successful sign-in clears the account's bucket.
// - Per IP: only failures count, so busy carrier-NAT addresses (Jio/Airtel
//   share one IP across many customers) are not blocked by normal logins.
//
// The IP is req.ip, which Express resolves through the single trusted proxy hop
// (app.set("trust proxy", 1)). Never key this on client-supplied headers such as
// x-forwarded-for or cf-connecting-ip: an attacker can rotate those freely.

export const LOGIN_LIMITS = Object.freeze({
  windowSeconds: 15 * 60,
  accountAttempts: 8,
  otpAttempts: 5,
  ipFailures: 100,
});

const FAILURE_STATUSES = Object.freeze({
  password: new Set([401, 404]),
  otp: new Set([400, 401]),
});

function bucket(scope, key) {
  return crypto.createHash("sha256").update(`login:${scope}:${key}`).digest("hex");
}

/** Durable store shared by every backend instance (reuses recovery_rate_limits). */
export function createMysqlThrottleStore({ getPool }) {
  async function transaction(action) {
    const conn = await (await getPool()).getConnection();
    try { await conn.beginTransaction(); const result = await action(conn); await conn.commit(); return result; }
    catch (failure) { await conn.rollback(); throw failure; }
    finally { conn.release(); }
  }
  async function readLocked(conn, key) {
    await conn.execute(
      "INSERT INTO recovery_rate_limits (bucket_key, request_count, window_started_at) VALUES (?, 0, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bucket_key = bucket_key",
      [key]
    );
    const [[row]] = await conn.query(
      "SELECT request_count, TIMESTAMPDIFF(SECOND, window_started_at, UTC_TIMESTAMP(3)) AS age_seconds FROM recovery_rate_limits WHERE bucket_key = ? FOR UPDATE",
      [key]
    );
    return row;
  }
  async function bump(conn, key, row, windowSeconds) {
    const reset = Number(row.age_seconds) >= windowSeconds;
    await conn.execute(
      "UPDATE recovery_rate_limits SET request_count = ?, window_started_at = IF(?, UTC_TIMESTAMP(3), window_started_at), last_request_at = UTC_TIMESTAMP(3) WHERE bucket_key = ?",
      [reset ? 1 : Number(row.request_count) + 1, reset, key]
    );
  }
  return {
    async take(key, max, windowSeconds) {
      return transaction(async (conn) => {
        const row = await readLocked(conn, key);
        const expired = Number(row.age_seconds) >= windowSeconds;
        if (!expired && Number(row.request_count) >= max) return false;
        await bump(conn, key, row, windowSeconds);
        return true;
      });
    },
    async exceeded(key, max, windowSeconds) {
      const [[row]] = await (await getPool()).query(
        "SELECT request_count, TIMESTAMPDIFF(SECOND, window_started_at, UTC_TIMESTAMP(3)) AS age_seconds FROM recovery_rate_limits WHERE bucket_key = ?",
        [key]
      );
      return Boolean(row) && Number(row.age_seconds) < windowSeconds && Number(row.request_count) >= max;
    },
    async increment(key, windowSeconds) {
      await transaction(async (conn) => bump(conn, key, await readLocked(conn, key), windowSeconds));
    },
    async clear(key) {
      await (await getPool()).execute("DELETE FROM recovery_rate_limits WHERE bucket_key = ?", [key]);
    },
  };
}

export function createLoginThrottle({ store, limits = LOGIN_LIMITS, onError = () => {} }) {
  const { windowSeconds } = limits;

  /**
   * Express middleware for one credential endpoint.
   * kind: "password" | "otp"; scope: which account table ("user", "technician", "admin", "otp").
   */
  return function loginThrottle({ kind = "password", scope, account }) {
    const failures = FAILURE_STATUSES[kind];
    const maxAttempts = kind === "otp" ? limits.otpAttempts : limits.accountAttempts;

    return async function loginThrottleMiddleware(req, res, next) {
      const ipKey = bucket("ip", normalizeIp(String(req.ip || "")));
      const rawAccount = String(account(req) || "").trim().toLowerCase();
      const accountKey = rawAccount ? bucket(scope, rawAccount) : null;

      let allowed;
      try {
        allowed = !(await store.exceeded(ipKey, limits.ipFailures, windowSeconds))
          && (accountKey === null || await store.take(accountKey, maxAttempts, windowSeconds));
      } catch (error) {
        onError(error);
        res.set("Cache-Control", "no-store");
        return res.status(503).json({ error: "Sign-in is temporarily unavailable. Please retry." });
      }
      if (!allowed) {
        res.set("Retry-After", String(windowSeconds));
        return res.status(429).json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
      }

      res.on("finish", () => {
        const status = res.statusCode;
        let work = null;
        if (failures.has(status)) work = store.increment(ipKey, windowSeconds);
        else if (accountKey && ((status >= 200 && status < 300) || status === 403)) work = store.clear(accountKey);
        if (work) Promise.resolve(work).catch(onError);
      });
      return next();
    };
  };
}

/** In-memory store for tests and single-process tools. Not shared across instances. */
export function createMemoryThrottleStore({ now = () => Date.now() } = {}) {
  const rows = new Map();
  const live = (key, windowSeconds) => {
    const row = rows.get(key);
    if (!row || now() - row.start >= windowSeconds * 1000) return null;
    return row;
  };
  return {
    rows,
    async take(key, max, windowSeconds) {
      const row = live(key, windowSeconds);
      if (row && row.count >= max) return false;
      rows.set(key, row ? { ...row, count: row.count + 1 } : { start: now(), count: 1 });
      return true;
    },
    async exceeded(key, max, windowSeconds) {
      const row = live(key, windowSeconds);
      return Boolean(row) && row.count >= max;
    },
    async increment(key, windowSeconds) {
      const row = live(key, windowSeconds);
      rows.set(key, row ? { ...row, count: row.count + 1 } : { start: now(), count: 1 });
    },
    async clear(key) { rows.delete(key); },
  };
}

/** Shared production throttle. Every credential route must use it (tests/login_throttle.test.js checks). */
export const loginThrottle = createLoginThrottle({
  store: createMysqlThrottleStore({ getPool }),
  onError: (error) => console.error("[Login throttle]", error?.message || error),
});

export const emailFromBody = (req) => req.body?.email;
