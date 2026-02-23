
import { Router } from "express";
import * as db from "../db.js";
import { verifyUser } from "../middleware/auth.js";

const router = Router();

const normalizeVehicleStatus = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "ready";
    if (["ready", "maintenance", "inactive"].includes(raw)) return raw;
    return "ready";
};

// GET /api/vehicles - List user's vehicles
router.get("/", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;

        const rows = await db.query(
            "SELECT * FROM user_vehicles WHERE user_id = ? ORDER BY created_at DESC",
            [userId]
        );

        res.json(rows);
    } catch (err) {
        console.error("Get vehicles error:", err);
        res.status(500).json({ error: "Failed to fetch vehicles" });
    }
});

// POST /api/vehicles - Add a new vehicle
router.post("/", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { type, make, model, license_plate, status } = req.body;

        if (!type || !make || !model) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO user_vehicles (user_id, type, make, model, license_plate, status) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, type, make, model, license_plate || null, normalizeVehicleStatus(status)]
        );

        res.status(201).json({ id: result.insertId, message: "Vehicle added successfully" });
    } catch (err) {
        console.error("Add vehicle error:", err);
        res.status(500).json({ error: "Failed to add vehicle" });
    }
});

// DELETE /api/vehicles/:id - Remove a vehicle
router.delete("/:id", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { id } = req.params;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM user_vehicles WHERE id = ? AND user_id = ?", [id, userId]);

        res.json({ success: true, message: "Vehicle removed" });
    } catch (err) {
        console.error("Delete vehicle error:", err);
        res.status(500).json({ error: "Failed to delete vehicle" });
    }
});

router.patch("/:id/status", verifyUser, async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id;
        const { id } = req.params;
        const status = normalizeVehicleStatus(req.body?.status);

        const pool = await db.getPool();
        const [result] = await pool.execute(
            "UPDATE user_vehicles SET status = ? WHERE id = ? AND user_id = ?",
            [status, id, userId]
        );

        if (!result?.affectedRows) {
            return res.status(404).json({ error: "Vehicle not found" });
        }

        return res.json({ success: true, status });
    } catch (err) {
        console.error("Update vehicle status error:", err);
        return res.status(500).json({ error: "Failed to update vehicle status" });
    }
});

export default router;
