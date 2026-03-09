import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as db from "../db.js";
import { sendMail } from "../services/mailer.js";

const router = Router();

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(ROUTES_DIR, "..");
const WORKSPACE_ROOT = path.resolve(BACKEND_ROOT, "..");
const DEFAULT_ANDROID_APK_FILE_NAME = "app-release.apk";

const ANDROID_APK_RELATIVE_DIRECTORIES = [
    ["resqnowfrontend", "android", "app", "release"],
    ["android", "app", "release"],
    ["resqnowfrontend", "android", "app", "build", "outputs", "apk", "release"],
    ["android", "app", "build", "outputs", "apk", "release"],
];

function normalizeAbsolutePath(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(process.cwd(), raw);
}

function getParentChain(startPath, maxDepth = 4) {
    const chain = [];
    let current = normalizeAbsolutePath(startPath);
    for (let depth = 0; depth < maxDepth; depth += 1) {
        if (!current) break;
        chain.push(current);
        const parent = path.dirname(current);
        if (!parent || parent === current) break;
        current = parent;
    }
    return chain;
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

function collectAndroidApkLookupCandidates() {
    const envDirectory = normalizeAbsolutePath(process.env.ANDROID_APK_RELEASE_DIR || process.env.APK_RELEASE_DIR);
    const envFile = normalizeAbsolutePath(process.env.ANDROID_APK_PATH || process.env.APK_PATH);
    const envFileName = String(process.env.ANDROID_APK_FILE_NAME || DEFAULT_ANDROID_APK_FILE_NAME).trim() || DEFAULT_ANDROID_APK_FILE_NAME;

    const rootCandidates = [
        BACKEND_ROOT,
        WORKSPACE_ROOT,
        process.cwd(),
        ...getParentChain(BACKEND_ROOT, 6),
        ...getParentChain(process.cwd(), 6),
    ];

    const directoryCandidates = [
        envDirectory,
        ...rootCandidates.flatMap((rootPath) =>
            ANDROID_APK_RELATIVE_DIRECTORIES.map((segments) => path.resolve(rootPath, ...segments))
        ),
    ].filter(Boolean).map((entry) => path.normalize(entry));

    return {
        envDirectory,
        envFile,
        fileNameCandidates: [...new Set([envFileName, DEFAULT_ANDROID_APK_FILE_NAME])],
        directoryCandidates: [...new Set(directoryCandidates)],
    };
}

function resolveAndroidApkPath() {
    const lookup = collectAndroidApkLookupCandidates();
    const checks = [];

    if (lookup.envFile) {
        const envFileStat = getFileStatSafe(lookup.envFile);
        checks.push({
            type: "env_file",
            path: lookup.envFile,
            exists: Boolean(envFileStat),
        });
        if (envFileStat) {
            return {
                apkPath: lookup.envFile,
                releaseDir: path.dirname(lookup.envFile),
                source: "env_file",
                stat: envFileStat,
                checks,
            };
        }
    }

    for (const directoryPath of lookup.directoryCandidates) {
        let directoryStat = null;
        try {
            if (fs.existsSync(directoryPath)) {
                const stat = fs.statSync(directoryPath);
                if (stat.isDirectory()) {
                    directoryStat = stat;
                }
            }
        } catch {
            directoryStat = null;
        }
        checks.push({ type: "directory", path: directoryPath, exists: Boolean(directoryStat) });
        if (!directoryStat) continue;

        for (const fileName of lookup.fileNameCandidates) {
            const explicitPath = path.resolve(directoryPath, fileName);
            const explicitStat = getFileStatSafe(explicitPath);
            checks.push({
                type: "explicit_file",
                path: explicitPath,
                exists: Boolean(explicitStat),
            });
            if (explicitStat) {
                return {
                    apkPath: explicitPath,
                    releaseDir: directoryPath,
                    source: "explicit_filename",
                    stat: explicitStat,
                    checks,
                };
            }
        }

        const metadataPath = path.join(directoryPath, "output-metadata.json");
        const metadataStat = getFileStatSafe(metadataPath);
        const metadataExists = Boolean(metadataStat);
        checks.push({ type: "metadata", path: metadataPath, exists: metadataExists });

        if (metadataExists) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
                const outputFile = String(metadata?.elements?.[0]?.outputFile || "").trim();
                if (outputFile) {
                    const resolvedOutput = path.resolve(directoryPath, outputFile);
                    const outputStat = getFileStatSafe(resolvedOutput);
                    checks.push({
                        type: "metadata_output",
                        path: resolvedOutput,
                        exists: Boolean(outputStat),
                    });
                    if (outputStat) {
                        return {
                            apkPath: resolvedOutput,
                            releaseDir: directoryPath,
                            source: "metadata_output",
                            stat: outputStat,
                            checks,
                        };
                    }
                }
            } catch (error) {
                checks.push({
                    type: "metadata_parse_error",
                    path: metadataPath,
                    exists: true,
                    error: String(error?.message || error),
                });
            }
        }

        const apkCandidates = fs
            .readdirSync(directoryPath)
            .filter((entry) => entry.toLowerCase().endsWith(".apk"))
            .map((entry) => path.join(directoryPath, entry))
            .map((entry) => ({ path: entry, stat: getFileStatSafe(entry) }))
            .filter((entry) => Boolean(entry.stat))
            .sort((a, b) => {
                const aTime = Number(a.stat?.mtimeMs || 0);
                const bTime = Number(b.stat?.mtimeMs || 0);
                return bTime - aTime;
            });

        if (apkCandidates.length > 0) {
            const firstCandidate = apkCandidates[0];
            return {
                apkPath: firstCandidate.path,
                releaseDir: directoryPath,
                source: "directory_scan",
                stat: firstCandidate.stat,
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
    return "Android app package is not available yet. Please upload app-release.apk to resqnowfrontend/android/app/release.";
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
        const fileName = apkPath ? path.basename(apkPath) : null;
        const fileSize = Number(resolution?.stat?.size || 0) || null;
        const modifiedAt = toIsoOrNull(resolution?.stat?.mtime || null);

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
        if (!apkPath) {
            console.warn("[Android APK Download] APK not found.", {
                cwd: process.cwd(),
                backendRoot: BACKEND_ROOT,
                checks: resolution?.checks || [],
            });
            return res.status(404).json({
                error: getAndroidApkMissingMessage(),
            });
        }

        const fileName = path.basename(apkPath);
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
