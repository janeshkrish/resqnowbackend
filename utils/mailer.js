import nodemailer from "nodemailer";

const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number.parseInt(String(process.env.SMTP_PORT || "").trim(), 10);
const EMAIL_USER = String(process.env.EMAIL_USER || "").trim();
const EMAIL_PASS = String(process.env.EMAIL_PASS || "").trim();
const TLS_REJECT_UNAUTHORIZED =
  String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || "").trim().toLowerCase() === "true";

const HAS_VALID_SMTP_PORT = Number.isInteger(SMTP_PORT) && SMTP_PORT > 0;
const TRANSPORT_CONFIGURED = Boolean(SMTP_HOST && HAS_VALID_SMTP_PORT && EMAIL_USER && EMAIL_PASS);
const VERIFY_CACHE_TTL_MS = 60 * 1000;

let verifyCache = {
  checkedAt: 0,
  ok: false,
  error: null,
};

export const transporter = TRANSPORT_CONFIGURED
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number.parseInt(process.env.SMTP_PORT, 10),
      secure: process.env.SMTP_PORT == "465",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED === "true",
      },
    })
  : null;

export function getMailerTransportConfig() {
  return {
    host: SMTP_HOST || null,
    port: HAS_VALID_SMTP_PORT ? SMTP_PORT : null,
    secure: String(process.env.SMTP_PORT || "").trim() === "465",
    auth: {
      user: EMAIL_USER || null,
      pass: EMAIL_PASS || null,
    },
    tls: {
      rejectUnauthorized: TLS_REJECT_UNAUTHORIZED,
    },
  };
}

export function isMailerTransportConfigured() {
  return TRANSPORT_CONFIGURED;
}

export function getMailerTransportVerificationState() {
  return {
    checkedAt: verifyCache.checkedAt || null,
    ok: TRANSPORT_CONFIGURED && verifyCache.ok,
  };
}

export async function verifyMailerTransport({ force = false } = {}) {
  if (!transporter) {
    const configError = new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_PORT, EMAIL_USER, and EMAIL_PASS."
    );
    verifyCache = {
      checkedAt: Date.now(),
      ok: false,
      error: configError,
    };
    throw configError;
  }

  const now = Date.now();
  if (!force && verifyCache.checkedAt && now - verifyCache.checkedAt < VERIFY_CACHE_TTL_MS) {
    if (verifyCache.ok) {
      return true;
    }
    throw verifyCache.error;
  }

  try {
    await transporter.verify();
    verifyCache = {
      checkedAt: now,
      ok: true,
      error: null,
    };
    return true;
  } catch (error) {
    verifyCache = {
      checkedAt: now,
      ok: false,
      error,
    };
    throw error;
  }
}
