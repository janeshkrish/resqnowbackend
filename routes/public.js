import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "../db.js";
import { sendMail } from "../services/mailer.js";

const router = Router();

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(ROUTES_DIR, "..");
const DEFAULT_ANDROID_APK_FILE_NAME = "resqnow.apk";
const DEFAULT_ANDROID_APK_RELATIVE_PATH = path.join("public", "downloads", DEFAULT_ANDROID_APK_FILE_NAME);

function getFileStatSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        const stat = fs.statSync(filePath);
        return stat.isFile() ? stat : null;
    } catch {
        return null;
    }
}

function normalizeAbsolutePath(value, relativeBase = BACKEND_ROOT) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (path.isAbsolute(raw)) {
        return path.resolve(raw);
    }
    return path.resolve(relativeBase, raw);
}

function buildAndroidApkCandidates() {
    const envFilePath = normalizeAbsolutePath(process.env.ANDROID_APK_PATH || process.env.APK_PATH, BACKEND_ROOT);
    const envDirectory = normalizeAbsolutePath(process.env.ANDROID_APK_RELEASE_DIR || process.env.APK_RELEASE_DIR, BACKEND_ROOT);
    const envFileName = String(
        process.env.ANDROID_APK_FILE_NAME || process.env.APK_FILE_NAME || DEFAULT_ANDROID_APK_FILE_NAME
    ).trim() || DEFAULT_ANDROID_APK_FILE_NAME;

    const candidates = [];

    if (envFilePath) {
        candidates.push({ source: "env_file", path: envFilePath });
    }

    if (envDirectory) {
        candidates.push({
            source: "env_directory",
            path: path.resolve(envDirectory, envFileName),
        });
    }

    // Production-safe default for Render deployments.
    candidates.push({
        source: "backend_public_downloads",
        path: path.resolve(BACKEND_ROOT, DEFAULT_ANDROID_APK_RELATIVE_PATH),
    });

    // Local legacy fallback to reduce friction during transition.
    candidates.push({
        source: "backend_public_downloads_legacy_name",
        path: path.resolve(BACKEND_ROOT, "public", "downloads", "app-release.apk"),
    });

    const seen = new Set();
    return candidates.filter((entry) => {
        const normalized = path.normalize(entry.path);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        entry.path = normalized;
        return true;
    });
}

function resolveAndroidApkPath() {
    const lookupCandidates = buildAndroidApkCandidates();
    const checks = [];

    for (const candidate of lookupCandidates) {
        const fileStat = getFileStatSafe(candidate.path);
        checks.push({
            source: candidate.source,
            path: candidate.path,
            exists: Boolean(fileStat),
        });

        if (fileStat) {
            return {
                apkPath: candidate.path,
                releaseDir: path.dirname(candidate.path),
                source: candidate.source,
                stat: fileStat,
                checks,
            };
        }
    }

    return {
        apkPath: null,
        releaseDir: null,
        source: null,
        stat: null,
        checks,
    };
}

function toIsoOrNull(value) {
    try {
        if (!value) return null;
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    } catch {
        return null;
    }
}

function getAndroidApkMissingMessage() {
    return "Android app package is not available yet. Upload resqnow.apk to resqnowbackend/public/downloads/.";
}

function setAndroidApkHeaders(res, fileName, fileSize = null) {
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
    if (Number.isFinite(Number(fileSize)) && Number(fileSize) >= 0) {
        res.setHeader("Content-Length", String(fileSize));
    }
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
}

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
        const contactReceiver = String(
            process.env.CONTACT_RECEIVER_EMAIL ||
            process.env.EMAIL_USER ||
            ""
        ).trim();
        if (!contactReceiver) {
            return res.status(503).json({ error: "Contact email receiver is not configured." });
        }

        await sendMail({
            to: contactReceiver,
            subject: `ResQNow Contact: ${subject}`,
            text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
            html: `
        <h3>New Contact Message</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <br/>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, "<br>")}</p>
      `,
            replyTo: email
        });
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

/**
 * GET /api/public/android-app/status
 * Resolve whether Android APK is currently available and where it was found.
 */
router.get("/android-app/status", async (_req, res) => {
    try {
        const resolution = resolveAndroidApkPath();
        const apkPath = resolution?.apkPath;
        const fileName = apkPath ? DEFAULT_ANDROID_APK_FILE_NAME : null;
        const fileSize = Number(resolution?.stat?.size || 0) || null;
        const modifiedAt = toIsoOrNull(resolution?.stat?.mtime || null);
        console.info("[Android APK Status] Path resolution summary.", {
            resolvedPath: apkPath || null,
            exists: Boolean(apkPath),
            source: resolution?.source || null,
            cwd: process.cwd(),
        });

        if (apkPath) {
            console.info("[Android APK Status] APK found.", {
                apkPath,
                source: resolution?.source || null,
                releaseDir: resolution?.releaseDir || null,
                cwd: process.cwd(),
            });
        } else {
            console.warn("[Android APK Status] APK not found.", {
                cwd: process.cwd(),
                backendRoot: BACKEND_ROOT,
                checks: resolution?.checks || [],
            });
        }

        return res.json({
            available: Boolean(apkPath),
            apkPath,
            fileName,
            fileSize,
            modifiedAt,
            downloadUrl: "/api/public/android-app/download",
            source: resolution?.source || null,
            releaseDir: resolution?.releaseDir || null,
            error: apkPath ? null : getAndroidApkMissingMessage(),
        });
    } catch (error) {
        console.error("[Android APK Status] Error:", error);
        return res.status(500).json({ error: "Failed to resolve Android app package status." });
    }
});

async function handleAndroidApkDownload(res, { headOnly = false } = {}) {
    try {
        const resolution = resolveAndroidApkPath();
        const apkPath = resolution?.apkPath;
        console.info("[Android APK Download] Path resolution summary.", {
            resolvedPath: apkPath || null,
            exists: Boolean(apkPath),
            source: resolution?.source || null,
            cwd: process.cwd(),
        });
        if (!apkPath) {
            console.warn("[Android APK Download] APK not found.", {
                cwd: process.cwd(),
                backendRoot: BACKEND_ROOT,
                checks: resolution?.checks || [],
            });
            if (headOnly) {
                return res.status(404).end();
            }
            return res.status(404).json({
                error: getAndroidApkMissingMessage(),
            });
        }

        const fileName = DEFAULT_ANDROID_APK_FILE_NAME;
        setAndroidApkHeaders(res, fileName, resolution?.stat?.size);

        if (headOnly) {
            console.info("[Android APK Download] HEAD resolved.", {
                apkPath,
                source: resolution?.source || null,
                releaseDir: resolution?.releaseDir || null,
                cwd: process.cwd(),
            });
            return res.status(200).end();
        }

        console.info("[Android APK Download] Serving APK.", {
            apkPath,
            source: resolution?.source || null,
            releaseDir: resolution?.releaseDir || null,
            cwd: process.cwd(),
        });

        return res.download(apkPath, fileName, (error) => {
            if (!error) return;
            console.error("[Android APK Download] Stream error:", error);
            if (!res.headersSent) {
                res.status(500).json({ error: "Failed to download Android app package." });
            }
        });
    } catch (error) {
        console.error("[Android APK Download] Error:", error);
        return res.status(500).json({ error: "Failed to prepare Android app download." });
    }
}

/**
 * HEAD /api/public/android-app/download
 * Check whether Android APK is available for download.
 */
router.head("/android-app/download", async (_req, res) => {
    return handleAndroidApkDownload(res, { headOnly: true });
});

/**
 * GET /api/public/android-app/download
 * Download latest Android APK from release output folder.
 */
router.get("/android-app/download", async (_req, res) => {
    return handleAndroidApkDownload(res, { headOnly: false });
});

export default router;
