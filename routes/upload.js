import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { getPool as defaultGetPool } from "../db.js";
import { createMysqlThrottleStore } from "../services/loginThrottle.js";
import { secondsLeft, UPLOAD_PREFIX, verifyUploadLink } from "../services/uploadLinks.js";
import { normalizeIp } from "../utils/clientIp.js";

// Uploaded files (launch checklist #4, QA-009).
// - Download: only with a signed link (services/uploadLinks.js). Plain
//   /api/upload/files/<name> addresses are refused. Responses are privately cached
//   and never type-sniffed.
// - Upload: contents must match the declared type, and uploads are rate limited:
//   per account when signed in, per IP otherwise (technician signup uploads happen
//   before an account exists, and installed app versions upload without a token).

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
    // Voice notes recorded in the request form.
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
    "audio/aac",
    "audio/x-m4a",
]);

export const UPLOAD_LIMITS = Object.freeze({
    windowSeconds: 60 * 60,
    anonymousPerIp: 30,
    perAccount: 120,
});

// Browsers send recordings as e.g. "audio/webm;codecs=opus"; the parameters don't matter here.
const baseMimeType = (value) => String(value || "").split(";")[0].trim().toLowerCase();
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

const startsWith = (buffer, bytes, offset = 0) =>
    buffer.length >= offset + bytes.length && bytes.every((byte, i) => buffer[offset + i] === byte);
const ascii = (text) => [...Buffer.from(text, "latin1")];

// The first bytes of each document/image type. Voice notes are not sniffed: phones
// record several container formats, and audio is served with nosniff anyway.
const SIGNATURES = {
    "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
    "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
    "application/pdf": (b) => startsWith(b, ascii("%PDF-")),
    "application/msword": (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
};

export function contentMatchesType(mimeType, buffer) {
    const check = SIGNATURES[baseMimeType(mimeType)];
    return check ? check(Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0)) : true;
}

function sanitizeFilename(name) {
    const raw = String(name || "upload").trim();
    const normalized = raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    return normalized || "upload";
}

function uploaderIdentity(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return null;
    try {
        const payload = jwt.verify(header.slice(7), String(process.env.JWT_SECRET || "").trim());
        const role = String(payload.role || payload.type || "user").toLowerCase();
        const id = payload.userId || payload.id || payload.technicianId;
        return id ? { role, id: String(id) } : null;
    } catch {
        return null; // Treated as anonymous: still limited per IP.
    }
}

const bucket = (key) => crypto.createHash("sha256").update(`upload:${key}`).digest("hex");

export function createUploadRouter({
    getPool = defaultGetPool,
    throttleStore = createMysqlThrottleStore({ getPool }),
    limits = UPLOAD_LIMITS,
    linkOptions,
} = {}) {
    const router = Router();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: MAX_UPLOAD_BYTES },
        fileFilter: (req, file, cb) => {
            if (ALLOWED_MIME_TYPES.has(baseMimeType(file.mimetype))) {
                return cb(null, true);
            }
            const error = new Error("Unsupported file type. Allowed: PDF, DOC, DOCX, JPG, PNG, WEBP and voice notes.");
            error.status = 400;
            cb(error);
        },
    });

    async function rateLimit(req, res, next) {
        const identity = uploaderIdentity(req);
        const key = identity
            ? bucket(`account:${identity.role}:${identity.id}`)
            : bucket(`ip:${normalizeIp(String(req.ip || ""))}`);
        const max = identity ? limits.perAccount : limits.anonymousPerIp;
        let allowed;
        try {
            allowed = await throttleStore.take(key, max, limits.windowSeconds);
        } catch (error) {
            console.error("[Upload] Rate limiter unavailable:", error?.message || error);
            return res.status(503).json({ error: "Uploads are temporarily unavailable. Please retry." });
        }
        if (!allowed) {
            res.set("Retry-After", String(limits.windowSeconds));
            return res.status(429).json({ error: "Too many uploads. Please wait a while and try again." });
        }
        return next();
    }

    function receiveFile(req, res, next) {
        upload.single("file")(req, res, (error) => {
            if (!error) return next();
            const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            const message = error.code === "LIMIT_FILE_SIZE" ? "The file is larger than 10 MB." : error.message;
            return res.status(status).json({ error: message });
        });
    }

    // Single file upload. The JSON response's url is signed on the way out, so the
    // uploader can show it immediately; requests store only the plain path.
    router.post("/", rateLimit, receiveFile, async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded." });
        }
        if (!contentMatchesType(req.file.mimetype, req.file.buffer)) {
            return res.status(400).json({ error: "The file's contents do not match its type." });
        }

        try {
            const pool = await getPool();
            const uniqueSuffix = `${Date.now()}-${crypto.randomInt(1e9)}`;
            const sanitizedOriginal = sanitizeFilename(req.file.originalname);
            const filename = `${uniqueSuffix}-${sanitizedOriginal}`;

            await pool.execute(
                "INSERT INTO files (filename, content, mimetype, size) VALUES (?, ?, ?, ?)",
                [filename, req.file.buffer, req.file.mimetype, req.file.size]
            );

            res.json({ url: `${UPLOAD_PREFIX}${filename}`, filename });
        } catch (err) {
            console.error("Upload Error:", err?.message || err);
            res.status(500).json({ error: "Failed to store file in database." });
        }
    });

    // Serve a file only for a valid, unexpired signed link.
    router.get("/files/:filename", async (req, res) => {
        res.set("X-Content-Type-Options", "nosniff");
        const requestedFilename = String(req.params.filename || "").trim();
        if (!SAFE_FILENAME_PATTERN.test(requestedFilename) || /^\.+$/.test(requestedFilename)) {
            return res.status(400).json({ error: "Invalid filename." });
        }

        const exp = String(req.query.exp || "");
        const verdict = verifyUploadLink({ filename: requestedFilename, exp, sig: String(req.query.sig || "") }, linkOptions);
        if (verdict !== "ok") {
            res.set("Cache-Control", "no-store");
            return res.status(403).json({
                error: verdict === "expired"
                    ? "This file link has expired. Refresh the page to get a new one."
                    : "This file link is not valid.",
            });
        }

        try {
            const pool = await getPool();
            const [rows] = await pool.execute(
                "SELECT filename, content, mimetype, size FROM files WHERE filename = ?",
                [requestedFilename]
            );

            if (rows.length === 0) {
                return res.status(404).send("File not found");
            }

            const file = rows[0];
            res.set("Content-Type", file.mimetype || "application/octet-stream");
            res.set("Content-Disposition", `inline; filename="${file.filename}"`);
            if (Number.isFinite(Number(file.size)) && Number(file.size) > 0) {
                res.set("Content-Length", String(Number(file.size)));
            }
            res.set("Cache-Control", `private, max-age=${secondsLeft(exp, linkOptions)}`);
            res.send(file.content);
        } catch (err) {
            console.error("File Fetch Error:", err?.message || err);
            res.status(500).send("Internal Server Error");
        }
    });

    return router;
}

export default createUploadRouter();
