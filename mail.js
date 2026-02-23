import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) {
    throw new Error("EMAIL_USER and EMAIL_PASS must be set in .env");
  }
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user, pass },
  });
  return transporter;
}

export async function sendMail({ to, subject, html }) {
  const transport = getTransporter();
  await transport.sendMail({
    from: process.env.EMAIL_USER,
    to,
    subject,
    html,
  });
}
