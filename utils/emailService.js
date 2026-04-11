import { Resend } from "resend";

const DEFAULT_FROM_ADDRESS = "ResQNow <onboarding@resend.dev>";
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();

console.log("Resend initialized with key:", process.env.RESEND_API_KEY);

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key[0] || "*"}***`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

export function maskEmail(value) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@")) return "";
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  if (name.length <= 2) return `${name[0] || "*"}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

export function extractEmailAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/<([^>]+)>/);
  const candidate = String(match?.[1] || raw).trim();
  return candidate.includes("@") ? candidate : "";
}

function shouldUseFallbackFromAddress(value) {
  const email = extractEmailAddress(value);
  if (!email) return true;

  const normalized = email.toLowerCase();
  return (
    normalized.endsWith("@example.com") ||
    normalized.endsWith("@example.org") ||
    normalized.endsWith("@example.net")
  );
}

export function getDefaultFromAddress() {
  const configuredFrom = String(process.env.EMAIL_FROM || "").trim();

  if (!configuredFrom) {
    return DEFAULT_FROM_ADDRESS;
  }

  if (shouldUseFallbackFromAddress(configuredFrom)) {
    return DEFAULT_FROM_ADDRESS;
  }

  return configuredFrom;
}

export function getEmailServiceConfigSnapshot() {
  return {
    configured: !!RESEND_API_KEY,
    provider: "resend",
    transportVerified: !!RESEND_API_KEY,
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
    resendApiKeySet: !!RESEND_API_KEY,
    resendApiKeyMasked: maskApiKey(RESEND_API_KEY),
  };
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  }

  const normalized = String(value || "").trim();
  return normalized ? [normalized] : [];
}

function normalizeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  const normalizedAttachments = attachments
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

      if (attachment.contentType) {
        normalized.contentType = attachment.contentType;
      }

      if (attachment.contentId || attachment.cid) {
        normalized.contentId = attachment.contentId || attachment.cid;
      }

      return normalized;
    })
    .filter((attachment) => attachment.filename && (attachment.content != null || attachment.path));

  return normalizedAttachments.length > 0 ? normalizedAttachments : undefined;
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

export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments = [],
  from,
  replyTo,
}) {
  try {
    if (!resend) {
      const configError = new Error("Email is not configured. Set RESEND_API_KEY.");
      console.error("EMAIL ERROR FULL:", getEmailErrorDetails(configError));
      if (isProductionLike()) {
        throw configError;
      }
      return null;
    }

    const recipients = normalizeRecipients(to);

    console.log("Sending email to:", recipients);

    const payload = {
      from: from || getDefaultFromAddress() || DEFAULT_FROM_ADDRESS,
      to: recipients,
      subject,
      html,
    };

    if (text != null) {
      payload.text = text;
    }

    if (replyTo) {
      payload.replyTo = replyTo;
    }

    const normalizedAttachments = normalizeAttachments(attachments);
    if (normalizedAttachments) {
      payload.attachments = normalizedAttachments;
    }

    const response = await resend.emails.send(payload);

    console.log("Resend response:", response);

    if (!response || response.error) {
      console.error("Resend error:", response?.error || null);
      throw new Error(response?.error?.message || "Email failed");
    }

    console.log("Email sent:", response.data || response);
    return response.data || response;
  } catch (err) {
    console.error("EMAIL ERROR FULL:", getEmailErrorDetails(err));
    throw normalizeError(err);
  }
}
