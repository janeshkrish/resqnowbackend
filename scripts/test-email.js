
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

// Configure dotenv to read from the root .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
dotenv.config({ path: path.join(rootDir, '.env') });

console.log('Testing Email Configuration...');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? 'Set' : 'Not Set');
console.log('EMAIL_PASS:', process.env.EMAIL_PASS ? 'Set' : 'Not Set');

async function sendTestEmail() {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
        console.error('Missing EMAIL_USER or EMAIL_PASS in .env');
        return;
    }

    const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false, // true for 465, false for other ports
        auth: {
            user: user,
            pass: pass,
        },
    });

    try {
        const info = await transporter.sendMail({
            from: user, // sender address
            to: "ashwin.s.shastry@gmail.com", // list of receivers - CHANGE THIS IF NEEDED
            subject: "ResQNow Email Test", // Subject line
            text: "This is a test email from ResQNow debugger.", // plain text body
            html: "<b>This is a test email from ResQNow debugger.</b>", // html body
        });

        console.log("Message sent: %s", info.messageId);
    } catch (error) {
        console.error("Error sending email:", error);
    }
}

sendTestEmail();
