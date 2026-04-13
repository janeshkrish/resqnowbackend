import {
  getMailerTransportConfig,
  getMailerTransportVerificationState,
  isMailerTransportConfigured,
  transporter,
  verifyMailerTransport,
} from "./mailer.js";

const DEFAULT_FROM_NAME = "ResQNow";

function isProductionLike() {
  return (
    String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
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
  const smtpUser = String(process.env.EMAIL_USER || "").trim().toLowerCase();
  if (!email) return true;

  const normalized = email.toLowerCase();
  return (
    (smtpUser && normalized !== smtpUser) ||
    normalized.endsWith("@example.com") ||
    normalized.endsWith("@example.org") ||
    normalized.endsWith("@example.net")
  );
}

export function getDefaultFromAddress() {
  const configuredFrom = String(process.env.EMAIL_FROM || "").trim();
  const smtpUser = String(process.env.EMAIL_USER || "").trim();

  if (configuredFrom && !shouldUseFallbackFromAddress(configuredFrom)) {
    return configuredFrom;
  }

  if (!smtpUser) {
    return "";
  }

  return `"${DEFAULT_FROM_NAME}" <${smtpUser}>`;
}

export function getEmailServiceConfigSnapshot() {
  const transportConfig = getMailerTransportConfig();
  const verificationState = getMailerTransportVerificationState();

  return {
    configured: isMailerTransportConfigured(),
    provider: "smtp",
    transportVerified: verificationState.ok,
    productionLike: isProductionLike(),
    host: transportConfig.host,
    port: transportConfig.port,
    secure: transportConfig.secure,
    requireTLS: null,
    tlsRejectUnauthorized: transportConfig.tls.rejectUnauthorized,
    smtpDebugEnabled: false,
    emailUserSet: Boolean(transportConfig.auth.user),
    emailPassSet: Boolean(transportConfig.auth.pass),
    emailUserMasked: maskEmail(transportConfig.auth.user),
    emailFrom: getDefaultFromAddress(),
    lastVerifiedAt: verificationState.checkedAt,
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
        normalized.cid = attachment.contentId || attachment.cid;
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
    responseCode: err.responseCode || null,
    type: err.type || null,
    command: err.command || null,
    response: err.response || err.body || null,
    accepted: err.accepted || null,
    rejected: err.rejected || null,
    cause: err.cause || null,
    stack: err.stack || null,
  };
}

export async function verifyEmailTransport(options = {}) {
  return verifyMailerTransport(options);
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
    if (!transporter) {
      throw new Error(
        "Email is not configured. Set RESEND_API_KEY in environment variables."
      );
    }

    const recipients = normalizeRecipients(to);
    if (recipients.length === 0) {
      throw new Error("Email recipient is required.");
    }

    const sender = from || getDefaultFromAddress();
    if (!sender) {
      throw new Error("Email sender is not configured. Set EMAIL_USER or EMAIL_FROM.");
    }

    const payload = {
      from: sender,
      to: recipients,
      subject,
    };

    if (html != null) {
      payload.html = html;
    }

    if (text != null) {
      payload.text = text;
    }

    if (replyTo) {
      payload.reply_to = replyTo;
    }

    const normalizedAttachments = normalizeAttachments(attachments);
    if (normalizedAttachments) {
      payload.attachments = normalizedAttachments;
    }

    const response = await transporter.sendMail(payload);

    if (
      Array.isArray(response?.rejected) &&
      response.rejected.length > 0 &&
      (!Array.isArray(response.accepted) || response.accepted.length === 0)
    ) {
      const rejectionError = new Error("SMTP server rejected all recipients.");
      rejectionError.rejected = response.rejected;
      rejectionError.response = response.response || null;
      throw rejectionError;
    }

    console.log("[Email] Resend send succeeded:", {
      to: recipients.map((recipient) => maskEmail(recipient)),
      messageId: response?.messageId || null,
      acceptedCount: Array.isArray(response?.accepted) ? response.accepted.length : 0,
      rejectedCount: Array.isArray(response?.rejected) ? response.rejected.length : 0,
    });
    return response;
  } catch (err) {
    console.error("EMAIL ERROR FULL:", getEmailErrorDetails(err));
    throw normalizeError(err);
  }
}
