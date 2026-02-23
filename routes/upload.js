import { Router } from "express";
import multer from "multer";
import { getPool } from "../db.js";

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /pdf|doc|docx|jpg|jpeg|png/;
        const isAllowed = allowedTypes.test(file.originalname.toLowerCase()) || allowedTypes.test(file.mimetype);
        if (isAllowed) {
            return cb(null, true);
        }
        cb(new Error("Only images and documents are allowed (pdf, doc, docx, jpg, png)."));
    }
});

// Single file upload route - Saves to Database
router.post("/", upload.single("file"), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
    }

    try {
        const pool = await getPool();
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${uniqueSuffix}-${req.file.originalname.replace(/\s+/g, '_')}`;

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
        const pool = await getPool();
        const [rows] = await pool.execute(
            "SELECT content, mimetype FROM files WHERE filename = ?",
            [req.params.filename]
        );

        if (rows.length === 0) {
            return res.status(404).send("File not found");
        }

        const file = rows[0];
        res.set("Content-Type", file.mimetype);
        res.send(file.content);
    } catch (err) {
        console.error("File Fetch Error:", err);
        res.status(500).send("Internal Server Error");
    }
});

export default router;
