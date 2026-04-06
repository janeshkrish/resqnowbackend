import { getEmailServiceConfigSnapshot, sendEmail } from "../services/emailService.js";

const snapshot = getEmailServiceConfigSnapshot();
const recipient = String(
  process.env.EMAIL_SMOKE_TO ||
  process.argv[2] ||
  process.env.ADMIN_EMAIL ||
  ""
).trim();

if (!snapshot.configured) {
  console.error("[EMAIL-SMOKE] Missing RESEND_API_KEY.");
  process.exit(1);
}

if (!recipient) {
  console.error("[EMAIL-SMOKE] Missing recipient. Set EMAIL_SMOKE_TO or pass an email as the first argument.");
  process.exit(1);
}

const subject = `ResQNow email smoke test ${new Date().toISOString()}`;

try {
  const result = await sendEmail({
    to: recipient,
    subject,
    text: "ResQNow email smoke test.",
    html: "<p>ResQNow email smoke test.</p>",
  });

  console.log("[EMAIL-SMOKE] SENT", {
    to: recipient,
    from: snapshot.emailFrom,
    emailId: result?.id || null,
  });
} catch (error) {
  console.error("[EMAIL-SMOKE] FAILED", {
    message: error?.message || String(error),
  });
  process.exit(1);
}
