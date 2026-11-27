import crypto from "node:crypto";

// Signed links for uploaded files (launch checklist #4, QA-009).
//
// Files are stored at /api/upload/files/<name> and can only be downloaded with
// ?exp=<unix seconds>&sig=<HMAC>. The server adds those parameters to every upload
// link in JSON responses and socket messages. Those responses were already limited by
// their own endpoint's permission checks (job details to the assigned technician,
// request details to the customer and admins, documents to the technician and
// admins), so whoever can see a record can open its files, and nobody else can.
// Old app versions keep working because they only display the links they are given.
//
// Links are valid for 6-12 hours and identical within each 6-hour window, so
// browsers can still cache images. The signing key is derived from JWT_SECRET: no
// new environment variable (a missing variable fails Railway's /ready check).

export const UPLOAD_PREFIX = "/api/upload/files/";
const NAME = /^[A-Za-z0-9._-]+$/;
const PATH = /^\/api\/upload\/files\/([A-Za-z0-9._-]+)$/;
const WINDOW_SECONDS = 6 * 60 * 60;
const SIG = /^[A-Za-z0-9_-]{43}$/;
const MAX_DEPTH = 32;

const isSafeName = (name) => typeof name === "string" && NAME.test(name) && !/^\.+$/.test(name);

function resolveOptions(options = {}) {
  return {
    secret: String(options.secret ?? process.env.JWT_SECRET ?? "").trim(),
    nowMs: (options.now ?? Date.now)(),
  };
}

function hmac(secret, filename, exp) {
  const key = crypto.createHash("sha256").update(`resqnow-upload-link-v1\0${secret}`).digest();
  return crypto.createHmac("sha256", key).update(`${filename}\n${exp}`).digest("base64url");
}

function parseLink(value) {
  if (typeof value !== "string" || !value.includes("api/upload/files/")) return null;
  const raw = value.trim();
  const absolute = /^https?:\/\//i.test(raw);
  let url;
  try {
    url = new URL(raw.startsWith("/") || absolute ? raw : `/${raw}`, "http://relative.invalid");
  } catch {
    return null;
  }
  const match = PATH.exec(url.pathname);
  if (!match || !isSafeName(match[1])) return null;
  return { name: match[1], origin: absolute ? url.origin : "" };
}

/** "/api/upload/files/<name>" for any stored or signed form of an upload link; otherwise null. */
export function canonicalUploadPath(value) {
  const link = parseLink(value);
  return link ? `${UPLOAD_PREFIX}${link.name}` : null;
}

/** Signed form of one upload link. Anything else (or no secret) comes back unchanged. */
export function signUploadLink(value, options) {
  const link = parseLink(value);
  if (!link) return value;
  const { secret, nowMs } = resolveOptions(options);
  if (!secret) return value;
  const exp = (Math.floor(nowMs / 1000 / WINDOW_SECONDS) + 2) * WINDOW_SECONDS;
  return `${link.origin}${UPLOAD_PREFIX}${link.name}?exp=${exp}&sig=${hmac(secret, link.name, exp)}`;
}

/** "ok" | "expired" | "invalid". A bad signature is "invalid" even when also expired. */
export function verifyUploadLink({ filename, exp, sig } = {}, options) {
  const { secret, nowMs } = resolveOptions(options);
  if (!secret || !isSafeName(filename) || !/^\d{1,12}$/.test(String(exp ?? "")) || !SIG.test(String(sig ?? ""))) return "invalid";
  const expected = Buffer.from(hmac(secret, filename, String(exp)));
  const given = Buffer.from(String(sig));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return "invalid";
  return Number(exp) * 1000 <= nowMs ? "expired" : "ok";
}

/** Seconds a verified link has left (for Cache-Control). */
export function secondsLeft(exp, options) {
  const { nowMs } = resolveOptions(options);
  return Math.max(0, Math.floor(Number(exp) - nowMs / 1000));
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Copy of a payload with every upload link signed. The input is never mutated. */
export function signUploadLinks(value, options) {
  const resolved = resolveOptions(options);
  if (!resolved.secret) return value;
  const fixed = { secret: resolved.secret, now: () => resolved.nowMs };
  const seen = new WeakMap();
  const walk = (node, depth) => {
    if (typeof node === "string") return signUploadLink(node, fixed);
    if (depth > MAX_DEPTH || node === null || typeof node !== "object") return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      const out = [];
      seen.set(node, out);
      for (const item of node) out.push(walk(item, depth + 1));
      return out;
    }
    if (!isPlainObject(node)) return node; // Dates, Buffers, class instances stay as they are.
    const out = {};
    seen.set(node, out);
    for (const [key, item] of Object.entries(node)) out[key] = walk(item, depth + 1);
    return out;
  };
  return walk(value, 0);
}

/** Express middleware: sign upload links in every res.json / res.send(object) body. */
export function signUploadLinksInJson(options) {
  return function signUploadLinksMiddleware(_req, res, next) {
    const json = res.json.bind(res);
    res.json = (body) => json(signUploadLinks(body, options));
    next();
  };
}

const OPERATOR_METHODS = ["to", "in", "except", "local", "volatile", "compress", "timeout"];

function wrapOperator(operator, sign) {
  if (!operator || typeof operator.emit !== "function") return operator;
  return new Proxy(operator, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "emit") return (event, ...args) => value.call(target, event, ...args.map(sign));
      if (OPERATOR_METHODS.includes(prop)) return (...args) => wrapOperator(value.apply(target, args), sign);
      return value.bind(target);
    },
  });
}

/** Sign upload links in every server-side socket.io emit (io.emit, io.to(...).emit, chains). */
export function signSocketPayloads(io, options) {
  const sign = (payload) => signUploadLinks(payload, options);
  const emit = io.emit.bind(io);
  io.emit = (event, ...args) => emit(event, ...args.map(sign));
  for (const method of OPERATOR_METHODS) {
    if (typeof io[method] !== "function") continue;
    const original = io[method].bind(io);
    io[method] = (...args) => wrapOperator(original(...args), sign);
  }
  return io;
}
