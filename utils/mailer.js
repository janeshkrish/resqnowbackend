import { Resend } from "resend";

// Resend uses HTTPS (port 443) — works on Render free tier (no SMTP port blocking)
// All env vars are read lazily (on first use) so dotenv has time to populate them.

let _resendClient = null;

function getResendClient() {
  if (_resendClient) return _resendClient;
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) return null;
  _resendClient = new Resend(apiKey);
  return _resendClient;
}

function getApiKeySet() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

function getEmailFrom() {
  return String(process.env.EMAIL_FROM || "ResQNow <onboarding@resend.dev>").trim();
}

let verifyCache = {
  checkedAt: 0,
  ok: false,
  error: null,
};

export function getMailerTransportConfig() {
  const apiKeySet = getApiKeySet();
  return {
    host: "api.resend.com",
    port: 443,
    secure: true,
    auth: {
      user: null,
      pass: apiKeySet ? "***" : null,
    },
    tls: {
      rejectUnauthorized: true,
    },
  };
}

export function isMailerTransportConfigured() {
  return getApiKeySet();
}

export function getMailerTransportVerificationState() {
  return {
    checkedAt: verifyCache.checkedAt || null,
    ok: verifyCache.ok,
  };
}

// Verify the mailer is ready — for Resend, checking key presence + cached ping is enough
export async function verifyMailerTransport({ force = false } = {}) {
  const now = Date.now();

  if (!force && verifyCache.checkedAt && now - verifyCache.checkedAt < 60000) {
    if (verifyCache.ok) return true;
    throw verifyCache.error;
  }

  if (!getApiKeySet()) {
    const err = new Error("RESEND_API_KEY is not set in environment variables.");
    verifyCache = { checkedAt: now, ok: false, error: err };
    throw err;
  }

  // Key is present — mark as verified without making an API call.
  // Real errors will surface when we actually try to send.
  console.log("[Mailer] Resend transport configured and ready (HTTPS, port 443)");
  verifyCache = { checkedAt: now, ok: true, error: null };
  return true;
}

// Core send function using Resend HTTP API
export async function sendMailViaResend({ from, to, subject, html, text, replyTo, attachments = [] }) {
  const client = getResendClient();
  if (!client) {
    throw new Error("Email is not configured. Set RESEND_API_KEY in environment variables.");
  }

  const recipients = Array.isArray(to) ? to : [to];
  const sender = from || getEmailFrom();

  const payload = {
    from: sender,
    to: recipients,
    subject,
  };

  if (html) payload.html = html;
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.map(att => ({
      filename: att.filename,
      content: att.content,
    }));
  }

  const { data, error } = await client.emails.send(payload);

  if (error) {
    console.error("[Mailer] Resend send error:", error);
    const err = new Error(error.message || "Resend email send failed");
    err.code = error.statusCode;
    throw err;
  }

  console.log("[Mailer] Email sent via Resend:", { id: data.id, to: recipients });
  return { messageId: data.id, accepted: recipients, rejected: [] };
}

// Compatibility alias — existing code calls transporter.sendMail() and transporter.verify()
export const transporter = {
  sendMail: sendMailViaResend,
  verify: verifyMailerTransport,
};
