
import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
        console.warn("EMAIL_USER and EMAIL_PASS must be set in .env to send emails.");
        return null;
    }

    transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user, pass },
    });
    return transporter;
}

// Simple duplicate-prevention cache to avoid sending the exact same email multiple times in a short window
const recentEmails = new Map(); // key -> timestamp
const EMAIL_DEDUP_WINDOW_MS = 10 * 1000; // 10 seconds

export async function sendMail({ to, subject, html, attachments = [] }) {
    const transport = getTransporter();
    if (!transport) {
        console.log(`[Mock Mail] To: ${to}, Subject: ${subject}`);
        return;
    }

    const key = `${to}|${subject}`;
    const now = Date.now();
    const last = recentEmails.get(key);
    if (last && (now - last) < EMAIL_DEDUP_WINDOW_MS) {
        console.warn(`Duplicate email suppressed to ${to} for '${subject}'`);
        return;
    }
    recentEmails.set(key, now);

    try {
        const result = await transport.sendMail({
            from: process.env.EMAIL_USER,
            to,
            subject,
            html,
            attachments,
        });
        console.log(`Email sent to ${to}`);
        return result;
    } catch (error) {
        console.error("Error sending email:", error);
        throw error;
    }
}

export async function sendInvoiceEmail(to, invoiceData, pdfBuffer=null) {
    const transport = getTransporter();
    if (!transport) {
        console.log(`[Mock Invoice] To: ${to}, Amount: ${invoiceData.totalAmount}`);
        return;
    }

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-bottom: 1px solid #e0e0e0;">
            <h2 style="color: #dc2626; margin: 0;">ResQNow Invoice</h2>
            <p style="color: #666; margin: 5px 0 0;">Transaction Completed</p>
        </div>
        
        <div style="padding: 20px;">
            <p>Hi <strong>${invoiceData.customerName}</strong>,</p>
            <p>Here is your invoice for the roadside assistance service.</p>
            
            <table style="width: 100%; margin-top: 20px; border-collapse: collapse;">
                <tr>
                    <td style="padding: 10px 0; color: #666;">Service Type:</td>
                    <td style="text-align: right; font-weight: bold;">${invoiceData.serviceType}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Technician:</td>
                    <td style="text-align: right;">${invoiceData.technicianName}</td>
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
                    <td style="text-align: right;">₹${invoiceData.amount.toFixed(2)}</td>
                </tr>
                ${invoiceData.gst ? `
                <tr>
                    <td style="padding: 10px 0;">GST (18%)</td>
                    <td style="text-align: right;">₹${invoiceData.gst.toFixed(2)}</td>
                </tr>` : ''}
                <tr style="font-size: 1.1em; font-weight: bold; border-top: 2px solid #333;">
                    <td style="padding: 15px 0;">Total Paid</td>
                    <td style="text-align: right;">₹${invoiceData.totalAmount.toFixed(2)}</td>
                </tr>
            </table>
            
            <div style="margin-top: 30px; text-align: center;">
                <p style="font-size: 0.9em; color: #888;">Payment Method: ${invoiceData.paymentMethod.toUpperCase()}</p>
                <p style="font-size: 0.9em; color: #888;">Transaction ID: ${invoiceData.transactionId}</p>
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
        subject: `Invoice - Service #${invoiceData.requestId}`,
        html,
        attachments: []
    };

    if (pdfBuffer) {
        mailOptions.attachments = [{
            filename: `invoice_${invoiceData.requestId}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
        }];
    }

    return sendMail(mailOptions);
}
