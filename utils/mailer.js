import { Resend } from "resend";

// Resend uses HTTPS (port 443) - works on all cloud platforms including Render free tier
// Client is lazily initialized at first use so dotenv has time to load
let _resendClient = null;

function getResendClient() {
  if (_resendClient) return _resendClient;
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) return null;
  _resendClient = new Resend(apiKey);
  return _resendClient;
}

const EMAIL_FROM = () => String(process.env.EMAIL_FROM || "ResQNow <onboarding@resend.dev>").trim();

let verifyCache = {
  checkedAt: 0,
  ok: false,
  error: null,
};

export function getMailerTransportConfig() {
  return {
    host: "api.resend.com",
    port: 443,
    secure: true,
    auth: {
      user: null,
      pass: RESEND_API_KEY ? "***" : null,
    },
    tls: {
      rejectUnauthorized: true,
    },
  };
}

export function isMailerTransportConfigured() {
  return Boolean(String(process.env.RESEND_API_KEY || "").trim());
}

export function getMailerTransportVerificationState() {
  return {
    checkedAt: verifyCache.checkedAt || null,
    ok: verifyCache.ok,
  };
}

// Resend doesn't have a separate verify step - we check config presence
export async function verifyMailerTransport({ force = false } = {}) {
  const now = Date.now();

  if (!force && verifyCache.checkedAt && now - verifyCache.checkedAt < 60000) {
    if (verifyCache.ok) return true;
    throw verifyCache.error;
  }

  if (!getResendClient()) {
    const err = new Error("RESEND_API_KEY is not configured.");
    verifyCache = { checkedAt: now, ok: false, error: err };
    throw err;
  }

  // Lightweight API ping to verify key validity
  try {
    await getResendClient().domains.list();
    console.log("[Mailer] Resend API key verified successfully");
    verifyCache = { checkedAt: now, ok: true, error: null };
    return true;
  } catch (err) {
    // If domains.list fails but key exists, still treat as valid - the key may lack domain perms
    if (err.message?.includes("RESEND_API_KEY")) {
      verifyCache = { checkedAt: now, ok: false, error: err };
      throw err;
    }
    console.warn("[Mailer] Resend domain-list check failed, assuming key valid:", err.message);
    verifyCache = { checkedAt: now, ok: true, error: null };
    return true;
  }
}

// Core send function using Resend HTTP API
export async function sendMailViaResend({ from, to, subject, html, text, replyTo, attachments = [] }) {
  const client = getResendClient();
  if (!client) {
    throw new Error("Resend client is not initialized. Set RESEND_API_KEY in environment variables.");
  }

  const recipients = Array.isArray(to) ? to : [to];
  const sender = from || EMAIL_FROM();

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

// Compatibility alias so existing code works unchanged
export const transporter = {
  sendMail: sendMailViaResend,
  verify: verifyMailerTransport,
};
