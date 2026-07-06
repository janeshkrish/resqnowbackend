import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import * as db from "../db.js";
import { sendMail } from "../services/mailer.js";
import {
    normalizeLocationProviderError,
    reverseGeocode,
    searchLocations,
} from "../services/locationProviderService.js";
import { getRoute, normalizeRouteServiceError } from "../services/routeService.js";

const router = Router();

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(ROUTES_DIR, "..");
const DEFAULT_ANDROID_APK_FILE_NAME = "resqnow.apk";
const DEFAULT_ANDROID_APK_RELATIVE_PATH = path.join("public", "downloads", DEFAULT_ANDROID_APK_FILE_NAME);

const locationSearchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE || 45),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many location searches. Please try again shortly." },
});

const reverseGeocodeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.REVERSE_GEOCODE_RATE_LIMIT_PER_MINUTE || 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many reverse geocode requests. Please try again shortly." },
});

const routeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.ROUTE_RATE_LIMIT_PER_MINUTE || 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many route requests. Please try again shortly." },
});

function extractEmailAddress(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const match = raw.match(/<([^>]+)>/);
    const candidate = String(match?.[1] || raw).trim();
    return candidate.includes("@") ? candidate : "";
}

function getContactReceiverEmail() {
    return (
        String(process.env.CONTACT_RECEIVER_EMAIL || "").trim() ||
        String(process.env.ADMIN_EMAIL || "").trim() ||
        extractEmailAddress(process.env.EMAIL_FROM) ||
        String(process.env.EMAIL_USER || "").trim()
    );
}

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
 * Returns live public statistics from the primary database.
 */
router.get("/stats", async (req, res) => {
    try {
        const pool = await db.getPool();

        const [[userRows], [techRows], [incidentRows], [serviceRows]] = await Promise.all([
            pool.query("SELECT COUNT(*) AS count FROM users"),
            pool.query("SELECT COUNT(*) AS count FROM technicians WHERE LOWER(COALESCE(status, '')) = 'approved'"),
            pool.query("SELECT COUNT(*) AS count FROM service_requests"),
            pool.query(
                "SELECT COUNT(*) AS count FROM service_requests WHERE LOWER(COALESCE(status, '')) IN ('completed', 'paid')"
            ),
        ]);

        const users = Number(userRows[0]?.count || 0);
        const technicians = Number(techRows[0]?.count || 0);
        const incidents = Number(incidentRows[0]?.count || 0);
        const completedServices = Number(serviceRows[0]?.count || 0);

        res.set("Cache-Control", "no-store, no-cache, must-revalidate");
        res.json({
            users,
            technicians,
            incidents,
            completedServices,
            generatedAt: new Date().toISOString(),
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
        const contactReceiver = getContactReceiverEmail();
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
 * GET /api/public/location-search?q=..
 * Backend-driven OSM-compatible autocomplete endpoint.
 */
router.get("/location-search", locationSearchLimiter, async (req, res) => {
    try {
        const result = await searchLocations({
            query: req.query.q || req.query.query,
            lat: req.query.lat,
            lng: req.query.lng || req.query.lon,
            limit: req.query.limit,
            provider: req.query.provider,
        });
        return res.json(result);
    } catch (error) {
        const normalized = normalizeLocationProviderError(error);
        return res.status(normalized.statusCode).json(normalized.payload);
    }
});

/**
 * GET /api/public/reverse-geocode?lat=..&lng=..
 * Proxies reverse geocoding through the backend provider layer.
 */
router.get("/reverse-geocode", reverseGeocodeLimiter, async (req, res) => {
    try {
        const result = await reverseGeocode({
            lat: req.query.lat,
            lng: req.query.lng || req.query.lon,
            provider: req.query.provider,
        });
        return res.json(result);
    } catch (error) {
        const normalized = normalizeLocationProviderError(error);
        return res.status(normalized.statusCode).json(normalized.payload);
    }
});

function parseRoutePoints(query) {
    const rawPoints = String(query.points || "").trim();
    if (rawPoints) {
        return rawPoints
            .split(";")
            .map((pair) => {
                const [lat, lng] = pair.split(",").map((value) => Number(value.trim()));
                return { lat, lng };
            });
    }

    return [
        { lat: query.pickupLat ?? query.fromLat, lng: query.pickupLng ?? query.fromLng },
        { lat: query.dropLat ?? query.toLat, lng: query.dropLng ?? query.toLng },
    ];
}

/**
 * GET /api/public/route?points=lat,lng;lat,lng
 * Returns road geometry from the configured OSRM-compatible route provider.
 */
router.get("/route", routeLimiter, async (req, res) => {
    try {
        const route = await getRoute({
            points: parseRoutePoints(req.query),
            overview: req.query.overview || "full",
        });
        return res.json(route);
    } catch (error) {
        const normalized = normalizeRouteServiceError(error);
        return res.status(normalized.statusCode).json(normalized.payload);
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
