import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

export const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

let verifyCache = {
  checkedAt: 0,
  ok: false,
  error: null,
};

export function getMailerTransportConfig() {
  return {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER || null,
      pass: process.env.EMAIL_PASS || null,
    },
    tls: {
      rejectUnauthorized: false,
    },
  };
}

export function isMailerTransportConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

export function getMailerTransportVerificationState() {
  return {
    checkedAt: verifyCache.checkedAt || null,
    ok: verifyCache.ok,
  };
}

export async function verifyMailerTransport({ force = false } = {}) {
  const now = Date.now();
  
  if (!force && verifyCache.checkedAt && (now - verifyCache.checkedAt < 60000)) {
    if (verifyCache.ok) return true;
    throw verifyCache.error;
  }

  try {
    await transporter.verify();
    console.log("Transporter verification successful");
    verifyCache = {
      checkedAt: now,
      ok: true,
      error: null,
    };
    return true;
  } catch (error) {
    console.error("Transporter verification error:", error);
    verifyCache = {
      checkedAt: now,
      ok: false,
      error,
    };
    throw error;
  }
}

