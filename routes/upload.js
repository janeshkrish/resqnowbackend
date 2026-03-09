import { Router } from "express";
import multer from "multer";
import { getPool } from "../db.js";

const router = Router();
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

function sanitizeFilename(name) {
    const raw = String(name || "upload").trim();
    const normalized = raw.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    return normalized || "upload";
}

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME_TYPES.has(String(file.mimetype || "").toLowerCase())) {
            return cb(null, true);
        }
        cb(new Error("Unsupported file type. Allowed: PDF, DOC, DOCX, JPG, PNG, WEBP."));
    }
});

// Single file upload route - Saves to Database
router.post("/", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
    }

    try {
        const pool = await getPool();
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const sanitizedOriginal = sanitizeFilename(req.file.originalname);
        const filename = `${uniqueSuffix}-${sanitizedOriginal}`;

        await pool.execute(
            "INSERT INTO files (filename, content, mimetype, size) VALUES (?, ?, ?, ?)",
            [filename, req.file.buffer, req.file.mimetype, req.file.size]
        );

        const fileUrl = `/api/upload/files/${filename}`;
        res.json({ url: fileUrl, filename: filename });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "Failed to store file in database." });
    }
});

// GET route to serve files from DB
router.get("/files/:filename", async (req, res) => {
    try {
        const requestedFilename = String(req.params.filename || "").trim();
        if (!SAFE_FILENAME_PATTERN.test(requestedFilename)) {
            return res.status(400).json({ error: "Invalid filename." });
        }

        const pool = await getPool();
        const [rows] = await pool.execute(
            "SELECT filename, content, mimetype, size FROM files WHERE filename = ?",
            [requestedFilename]
        );

        if (rows.length === 0) {
            return res.status(404).send("File not found");
        }

        const file = rows[0];
        res.set("Content-Type", file.mimetype);
        res.set("Content-Disposition", `inline; filename=\"${file.filename}\"`);
        if (Number.isFinite(Number(file.size)) && Number(file.size) > 0) {
            res.set("Content-Length", String(Number(file.size)));
        }
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.send(file.content);
    } catch (err) {
        console.error("File Fetch Error:", err);
        res.status(500).send("Internal Server Error");
    }
});

export default router;
