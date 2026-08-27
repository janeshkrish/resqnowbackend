import {
  getDefaultFromAddress,
  getEmailErrorDetails as buildEmailErrorDetails,
  getEmailServiceConfigSnapshot,
  maskEmail,
  sendEmail,
  verifyEmailTransport,
} from "./emailService.js";

// Simple duplicate-prevention cache to avoid sending the exact same email multiple times in a short window.
const recentEmails = new Map();
const EMAIL_DEDUP_WINDOW_MS = 10 * 1000;

function logEmailError(prefix, error, extra = {}) {
  console.error(prefix, {
    ...extra,
    error: buildEmailErrorDetails(error),
  });
}

function getMaskedRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => maskEmail(entry)).filter(Boolean).join(", ");
  }
  return maskEmail(value);
}

export function getMailerConfigSnapshot() {
  return getEmailServiceConfigSnapshot();
}

export function getEmailErrorDetails(error) {
  return buildEmailErrorDetails(error);
}

export async function verifyMailerConnection() {
  const result = await verifyMailerConnectionDetailed();
  return result.ok;
}

export async function verifyMailerConnectionDetailed(context = {}) {
  const requestId = String(context.requestId || "").trim();
  const snapshot = getMailerConfigSnapshot();

  if (!snapshot.configured) {
    return {
      ok: false,
      reason: "not_configured",
      requestId,
      snapshot,
    };
  }

  try {
    await verifyEmailTransport();
    return {
      ok: true,
      reason: "verified",
      requestId,
      snapshot: getMailerConfigSnapshot(),
    };
  } catch (error) {
    return {
      ok: false,
      reason: "verify_failed",
      requestId,
      snapshot: getMailerConfigSnapshot(),
      error: buildEmailErrorDetails(error),
    };
  }
}

export async function sendMail({
  to,
  subject,
  html,
  text,
  attachments = [],
  from,
  replyTo,
}) {
  const key = `${to}|${subject}`;
  const now = Date.now();
  const last = recentEmails.get(key);
  if (last && now - last < EMAIL_DEDUP_WINDOW_MS) {
    console.warn(`[Mailer] Duplicate email suppressed to ${to} for '${subject}'`);
    return;
  }
  recentEmails.set(key, now);

  try {
    const result = await sendEmail({
      from: from || getDefaultFromAddress(),
      to,
      subject,
      html,
      text,
      replyTo,
      attachments,
    });

    if (result === null) {
      return null;
    }

    console.log(`[Mailer] Email sent to ${getMaskedRecipients(to)}.`);
    return result;
  } catch (error) {
    logEmailError("[Mailer] Error sending email", error, {
      to,
      subject,
    });
    throw error;
  }
}

export async function sendInvoiceEmail(to, invoiceData, pdfBuffer = null) {
  const amount = Number(invoiceData?.amount || 0);
  const gst = Number(invoiceData?.gst || 0);
  const totalAmount = Number(invoiceData?.totalAmount || 0);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #e0e0e0;">
            <h2 style="color: #dc2626; margin: 0;">ResQNow Invoice</h2>
            <p style="color: #666; margin: 5px 0 0;">Transaction Completed</p>
        </div>

        <div style="padding: 20px;">
            <p>Hi <strong>${invoiceData.customerName || "Customer"}</strong>,</p>
            <p>Here is your invoice for the roadside assistance service.</p>

            <table style="width: 100%; margin-top: 20px; border-collapse: collapse;">
                <tr>
                    <td style="padding: 10px 0; color: #666;">Service Type:</td>
                    <td style="text-align: right; font-weight: bold;">${invoiceData.serviceType || "Roadside Assistance"}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Technician:</td>
                    <td style="text-align: right;">${invoiceData.technicianName || "Assigned Technician"}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Date:</td>
                    <td style="text-align: right;">${new Date().toLocaleDateString()}</td>
                </tr>
            </table>

            <hr style="border: 0; border-top: 1px border-dashed #eee; margin: 20px 0;">

            <table style="width: 100%; border-collapse: collapse;">
                <tr>
                    <td style="padding: 10px 0;">Base Service Charge</td>
                    <td style="text-align: right;">INR ${amount.toFixed(2)}</td>
                </tr>
                ${gst > 0 ? `
                <tr>
                    <td style="padding: 10px 0;">GST (18%)</td>
                    <td style="text-align: right;">INR ${gst.toFixed(2)}</td>
                </tr>` : ""}
                <tr style="font-size: 1.1em; font-weight: bold; border-top: 2px solid #333;">
                    <td style="padding: 15px 0;">Total Paid</td>
                    <td style="text-align: right;">INR ${totalAmount.toFixed(2)}</td>
                </tr>
            </table>

            <div style="margin-top: 30px; text-align: center;">
                <p style="font-size: 0.9em; color: #888;">Payment Method: ${String(invoiceData.paymentMethod || "razorpay").toUpperCase()}</p>
                <p style="font-size: 0.9em; color: #888;">Transaction ID: ${invoiceData.transactionId || "N/A"}</p>
            </div>
        </div>

        <div style="background-color: #f8f9fa; padding: 15px; text-align: center; font-size: 0.8em; color: #888; border-radius: 0 0 8px 8px;">
            <p>Thank you for choosing ResQNow!</p>
            <p>Need help? Contact support@resqnow.com</p>
        </div>
    </div>
    `;

  const mailOptions = {
    to,
    subject: `Invoice - Service #${invoiceData.requestId || invoiceData.orderId || "N/A"}`,
    html,
    attachments: [],
  };

  if (pdfBuffer) {
    mailOptions.attachments = [{
      filename: `invoice_${invoiceData.requestId || invoiceData.orderId || Date.now()}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    }];
  }

  return sendMail(mailOptions);
}
