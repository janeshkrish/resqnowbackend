import { Resend } from "resend";

const DEFAULT_FROM_ADDRESS = "ResQNow <onboarding@resend.dev>";

let resendClient = null;

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function getApiKey() {
  return String(process.env.RESEND_API_KEY || "").trim();
}

export function maskEmail(value) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@")) return "";
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  if (name.length <= 2) return `${name[0] || "*"}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key[0] || "*"}***`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

export function extractEmailAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/<([^>]+)>/);
  const candidate = String(match?.[1] || raw).trim();
  return candidate.includes("@") ? candidate : "";
}

export function getDefaultFromAddress() {
  return String(process.env.EMAIL_FROM || "").trim() || DEFAULT_FROM_ADDRESS;
}

export function getEmailServiceConfigSnapshot() {
  const apiKey = getApiKey();

  return {
    configured: !!apiKey,
    provider: "resend",
    transportVerified: !!apiKey,
    productionLike: isProductionLike(),
    host: null,
    port: null,
    secure: null,
    requireTLS: null,
    tlsRejectUnauthorized: null,
    smtpDebugEnabled: false,
    emailUserSet: false,
    emailPassSet: false,
    emailUserMasked: "",
    emailFrom: getDefaultFromAddress(),
    resendApiKeySet: !!apiKey,
    resendApiKeyMasked: maskApiKey(apiKey),
  };
}

function normalizeError(error) {
  if (error instanceof Error) return error;

  const message =
    error?.message ||
    error?.error ||
    error?.name ||
    "Unknown email service error";
  const normalized = new Error(String(message));
  if (error && typeof error === "object") {
    Object.assign(normalized, error);
  }
  return normalized;
}

export function getEmailErrorDetails(error) {
  const err = normalizeError(error || {});
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    code: err.code || null,
    statusCode: err.statusCode || err.status || null,
    type: err.type || null,
    response: err.response || err.body || null,
    cause: err.cause || null,
    stack: err.stack || null,
  };
}

function getResendClient() {
  if (resendClient) return resendClient;

  const apiKey = getApiKey();
  if (!apiKey) {
    const message = "Email is not configured. Set RESEND_API_KEY.";
    if (isProductionLike()) {
      throw new Error(message);
    }
    console.warn(`[EmailService] ${message}`);
    return null;
  }

  resendClient = new Resend(apiKey);
  return resendClient;
}

function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  return attachments
    .filter(Boolean)
    .map((attachment) => {
      const normalized = {};

      if (attachment.filename) {
        normalized.filename = attachment.filename;
      }

      if (attachment.content != null) {
        normalized.content = attachment.content;
      }

      if (attachment.path) {
        normalized.path = attachment.path;
      }

      if (attachment.contentId || attachment.cid) {
        normalized.contentId = attachment.contentId || attachment.cid;
      }

      return normalized;
    })
    .filter((attachment) => attachment.filename && (attachment.content != null || attachment.path));
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments = [],
  from,
  replyTo,
}) {
  const resend = getResendClient();
  if (!resend) {
    console.log(`[Mock Mail] To: ${to}, Subject: ${subject}`);
    return null;
  }

  try {
    const response = await resend.emails.send({
      from: from || getDefaultFromAddress(),
      to,
      subject,
      html,
      text,
      replyTo,
      attachments: normalizeAttachments(attachments),
    });

    const error = response?.error || null;
    if (error) {
      throw normalizeError(error);
    }

    return response?.data || response || null;
  } catch (error) {
    console.error("[EmailService] Email send error:", getEmailErrorDetails(error));
    throw normalizeError(error);
  }
}
