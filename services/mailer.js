import nodemailer from "nodemailer";

let transporter = null;
let verifyPromise = null;
let transportVerified = false;
let transporterMeta = null;

function isProductionLike() {
    return (
        String(process.env.NODE_ENV || "").toLowerCase() === "production" ||
        String(process.env.RENDER || "").toLowerCase() === "true" ||
        Boolean(process.env.RENDER_EXTERNAL_URL)
    );
}

function toBool(value, defaultValue = false) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!normalized) return defaultValue;
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
    if (name.length <= 2) return `${name[0] || "*"}***@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
}

function normalizeHost(value, fallback = "smtp.gmail.com") {
    const host = String(value || "").trim();
    return host || fallback;
}

function buildMailerConfig() {
    const user = String(process.env.EMAIL_USER || "").trim();
    const pass = String(process.env.EMAIL_PASS || "").trim();
    if (!user || !pass) {
        return null;
    }

    const smtpHost = String(process.env.SMTP_HOST || "").trim();
    const smtpPort = toInt(process.env.SMTP_PORT, 587);
    const isSecure = smtpPort === 465;
    const tlsRejectUnauthorized = toBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true);
    const smtpDebug = toBool(process.env.SMTP_DEBUG, false);

    return {
        host: normalizeHost(smtpHost),
        port: smtpPort,
        secure: isSecure,
        requireTLS: !isSecure,
        auth: {
            user,
            pass,
        },
        user,
        tls: {
            rejectUnauthorized: tlsRejectUnauthorized,
        },
        connectionTimeout: toInt(process.env.SMTP_CONNECTION_TIMEOUT_MS, 15000),
        greetingTimeout: toInt(process.env.SMTP_GREETING_TIMEOUT_MS, 10000),
        socketTimeout: toInt(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),
        logger: smtpDebug,
        debug: smtpDebug,
    };
}

function getFromAddress(configUser = "") {
    return (
        String(process.env.EMAIL_FROM || "").trim() ||
        configUser ||
        String(process.env.EMAIL_USER || "").trim()
    );
}

export function getMailerConfigSnapshot() {
    const config = buildMailerConfig();
    const user = String(process.env.EMAIL_USER || "").trim();
    const pass = String(process.env.EMAIL_PASS || "").trim();

    return {
        configured: !!config,
        transportVerified,
        host: config?.host || null,
        port: config?.port || null,
        secure: !!config?.secure,
        requireTLS: !!config?.requireTLS,
        tlsRejectUnauthorized: config?.tls?.rejectUnauthorized ?? null,
        smtpDebugEnabled: !!config?.debug,
        emailUserSet: !!user,
        emailPassSet: !!pass,
        emailUserMasked: maskEmail(user),
        emailFrom: getFromAddress(config?.user || ""),
    };
}

export function getSmtpErrorDetails(error) {
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

function logSmtpError(prefix, error, extra = {}) {
    console.error(prefix, {
        ...extra,
        error: getSmtpErrorDetails(error),
    });
}

async function getTransporter() {
    if (transporter && verifyPromise) {
        await verifyPromise;
        return transporter;
    }

    const config = buildMailerConfig();
    if (!config) {
        const message = "Email is not configured. Set EMAIL_USER and EMAIL_PASS.";
        if (isProductionLike()) {
            throw new Error(message);
        }
        console.warn(`[Mailer] ${message}`);
        return null;
    }

    transporterMeta = {
        host: config.host || null,
        port: config.port || null,
        secure: !!config.secure,
        requireTLS: !!config.requireTLS,
    };

    transporter = nodemailer.createTransport(config);

    verifyPromise = transporter
        .verify()
        .then(() => {
            transportVerified = true;
            console.log(`[Mailer] Email transporter verified (host=${config.host}:${config.port}).`);
        })
        .catch((err) => {
            transportVerified = false;
            logSmtpError("[Mailer] SMTP transporter verification failed", err, {
                transport: transporterMeta,
            });
            throw err;
        });

    await verifyPromise;
    return transporter;
}

export async function verifyMailerConnection() {
    const result = await verifyMailerConnectionDetailed();
    return result.ok;
}

export async function verifyMailerConnectionDetailed(context = {}) {
    const requestId = String(context.requestId || "").trim();
    const snapshot = getMailerConfigSnapshot();

    try {
        const mailer = await getTransporter();
        if (!mailer) {
            return {
                ok: false,
                reason: "not_configured",
                requestId,
                snapshot,
            };
        }

        return {
            ok: transportVerified,
            reason: transportVerified ? "verified" : "unverified",
            requestId,
            snapshot: getMailerConfigSnapshot(),
        };
    } catch (error) {
        logSmtpError("[Mailer] verifyMailerConnectionDetailed failed", error, {
            requestId,
            snapshot,
        });
        return {
            ok: false,
            reason: "verify_failed",
            requestId,
            snapshot,
            error: getSmtpErrorDetails(error),
        };
    }
}

// Simple duplicate-prevention cache to avoid sending the exact same email multiple times in a short window.
const recentEmails = new Map();
const EMAIL_DEDUP_WINDOW_MS = 10 * 1000;

export async function sendMail({
    to,
    subject,
    html,
    text,
    attachments = [],
    from,
    replyTo,
}) {
    const transport = await getTransporter();
    if (!transport) {
        console.log(`[Mock Mail] To: ${to}, Subject: ${subject}`);
        return;
    }

    const key = `${to}|${subject}`;
    const now = Date.now();
    const last = recentEmails.get(key);
    if (last && (now - last) < EMAIL_DEDUP_WINDOW_MS) {
        console.warn(`[Mailer] Duplicate email suppressed to ${to} for '${subject}'`);
        return;
    }
    recentEmails.set(key, now);

    try {
        const result = await transport.sendMail({
            from: from || getFromAddress(),
            to,
            subject,
            html,
            text,
            replyTo,
            attachments,
        });
        console.log(`[Mailer] Email sent to ${to} (messageId=${result.messageId || "n/a"})`);
        return result;
    } catch (error) {
        logSmtpError("[Mailer] Error sending email", error, {
            to,
            subject,
            transport: transporterMeta,
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
