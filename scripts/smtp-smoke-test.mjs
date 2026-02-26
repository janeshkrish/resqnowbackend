import "../loadEnv.js";
import nodemailer from "nodemailer";

function toBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function maskEmail(value) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@")) return "";
  const [name, domain] = email.split("@");
  if (!name || !domain) return "";
  if (name.length < 3) return `${name[0] || "*"}***@${domain}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function smtpErrorDetails(error) {
  const err = error || {};
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    code: err.code || null,
    command: err.command || null,
    responseCode: err.responseCode || null,
    response: err.response || null,
    errno: err.errno || null,
    syscall: err.syscall || null,
    address: err.address || null,
    port: err.port || null,
    stack: err.stack || null,
  };
}

const user = String(process.env.EMAIL_USER || "").trim();
const pass = String(process.env.EMAIL_PASS || "").trim();
const host = String(process.env.SMTP_HOST || "smtp.gmail.com").trim();
const port = toInt(process.env.SMTP_PORT, 587);
const secure = port === 465;
const tlsRejectUnauthorized = toBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true);
const debug = toBool(process.env.SMTP_DEBUG, false);

if (!user || !pass) {
  console.error("[SMTP-SMOKE] Missing EMAIL_USER or EMAIL_PASS.");
  process.exit(1);
}

const transportConfig = {
  host,
  port,
  secure,
  requireTLS: !secure,
  auth: { user, pass },
  tls: { rejectUnauthorized: tlsRejectUnauthorized },
  connectionTimeout: toInt(process.env.SMTP_CONNECTION_TIMEOUT_MS, 15000),
  greetingTimeout: toInt(process.env.SMTP_GREETING_TIMEOUT_MS, 10000),
  socketTimeout: toInt(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),
  logger: debug,
  debug,
};

const summary = {
  host,
  port,
  secure,
  requireTLS: !secure,
  tlsRejectUnauthorized,
  smtpDebugEnabled: debug,
  emailUserMasked: maskEmail(user),
  emailPassSet: !!pass,
  emailFrom: String(process.env.EMAIL_FROM || user).trim(),
};

console.log("[SMTP-SMOKE] Config summary", summary);

const transporter = nodemailer.createTransport(transportConfig);

try {
  await transporter.verify();
  console.log("[SMTP-SMOKE] VERIFY_OK");
} catch (error) {
  console.error("[SMTP-SMOKE] VERIFY_FAILED", smtpErrorDetails(error));
  process.exit(1);
}

const testTo = String(process.env.SMTP_TEST_TO || "").trim();
if (!testTo) {
  console.log("[SMTP-SMOKE] Skipping send test. Set SMTP_TEST_TO to send an actual test email.");
  process.exit(0);
}

try {
  const result = await transporter.sendMail({
    from: String(process.env.EMAIL_FROM || user).trim(),
    to: testTo,
    subject: "ResQNow SMTP smoke test",
    text: "SMTP smoke test successful.",
    html: "<p>SMTP smoke test successful.</p>",
  });
  console.log("[SMTP-SMOKE] SEND_OK", {
    messageId: result.messageId || null,
    accepted: result.accepted || [],
    rejected: result.rejected || [],
  });
} catch (error) {
  console.error("[SMTP-SMOKE] SEND_FAILED", smtpErrorDetails(error));
  process.exit(1);
}
