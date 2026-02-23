import { Router } from "express";
import * as db from "../db.js";
import nodemailer from "nodemailer";

const router = Router();

/**
 * GET /api/public/stats
 * Returns public statistics for the About Us page.
 */
router.get("/stats", async (req, res) => {
    try {
        const pool = await db.getPool();

        // Count registered users
        const [userRows] = await pool.query("SELECT COUNT(*) as count FROM users");
        const users = userRows[0]?.count || 0;

        // Count verified technicians
        const [techRows] = await pool.query("SELECT COUNT(*) as count FROM technicians WHERE status = 'approved'");
        const technicians = techRows[0]?.count || 0;

        // Count completed service requests
        const [serviceRows] = await pool.query("SELECT COUNT(*) as count FROM service_requests WHERE status = 'completed'");
        const completedServices = serviceRows[0]?.count || 0;

        res.json({
            users,
            technicians,
            completedServices
        });
    } catch (error) {
        console.error("[Public Stats] Error:", error);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

/**
 * POST /api/public/contact
 * Handles contact form submissions.
 */
router.post("/contact", async (req, res) => {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
        return res.status(400).json({ error: "All fields are required" });
    }

    try {
        // Configure transporter
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        const mailOptions = {
            from: `"${name}" <${email}>`, // sender address
            to: "resqnow01@gmail.com", // list of receivers
            subject: `ResQNow Contact: ${subject}`, // Subject line
            text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`, // plain text body
            html: `
        <h3>New Contact Message</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <br/>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, "<br>")}</p>
      `
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: "Message sent successfully" });

    } catch (error) {
        console.error("[Contact Form] Error:", error);
        res.status(500).json({ error: "Failed to send message" });
    }
});

/**
 * GET /api/public/reverse-geocode?lat=..&lng=..
 * Proxies reverse geocoding to avoid browser CORS issues.
 */
router.get("/reverse-geocode", async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ error: "Valid lat and lng are required." });
        }

        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`;
        const upstream = await fetch(url, {
            headers: {
                "User-Agent": "ResQNow/1.0 (support@resqnow.com)",
                "Accept": "application/json",
            },
        });

        if (!upstream.ok) {
            return res.status(502).json({ error: "Geocoding provider failed." });
        }

        const data = await upstream.json();
        return res.json(data);
    } catch (error) {
        console.error("[Reverse Geocode] Error:", error);
        return res.status(500).json({ error: "Failed to reverse geocode." });
    }
});

export default router;
