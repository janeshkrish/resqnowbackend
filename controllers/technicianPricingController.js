import * as db from "../db.js";

// Accept an existing transaction so signup and its prices are committed together.
export async function replaceTechnicianServicePricing(conn, technicianId, rows) {
    if (!Array.isArray(rows)) throw new Error("Pricing must be an array.");
    await conn.execute("DELETE FROM technician_service_pricing WHERE technician_id = ?", [technicianId]);
    for (const item of rows) {
        if (!Number.isInteger(Number(item.service_id)) || Number(item.service_id) <= 0 ||
            !Number.isInteger(Number(item.vehicle_category_id)) || Number(item.vehicle_category_id) <= 0 ||
            !item.pricing_json || typeof item.pricing_json !== "object" || Array.isArray(item.pricing_json)) {
            throw new Error("Invalid service pricing row.");
        }
        for (const [key, value] of Object.entries(item.pricing_json)) {
            if (["service_domain", "vehicle_type", "vehicle_subtype", "vehicle_subtype_label"].includes(key)) continue;
            if (value === "" || value == null) continue;
            if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new Error("Prices must be non-negative numbers.");
        }
        await conn.execute(
            "INSERT INTO technician_service_pricing (technician_id, service_id, vehicle_category_id, vehicle_subcategory_id, fleet_id, pricing_json) VALUES (?, ?, ?, ?, ?, ?)",
            [technicianId, item.service_id, item.vehicle_category_id, item.vehicle_subcategory_id || null, item.fleet_id || null, JSON.stringify(item.pricing_json)]
        );
    }
}

export const getPricingTemplate = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [services] = await pool.query("SELECT * FROM service_master WHERE active = 1");
        const [categories] = await pool.query("SELECT * FROM vehicle_category_master WHERE active = 1");
        const [subcategories] = await pool.query("SELECT * FROM vehicle_subcategory_master WHERE active = 1");
        const [pricingFields] = await pool.query("SELECT * FROM service_pricing_field_master ORDER BY sort_order");
        const [fleets] = await pool.query("SELECT * FROM towing_fleet_master WHERE active = 1");

        res.json({
            services,
            categories,
            subcategories,
            pricingFields,
            fleets
        });
    } catch (err) {
        console.error("[getPricingTemplate]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const getTechnicianServicePricing = async (req, res) => {
    try {
        const technician_id = req.params.technicianId || req.user?.id; // Allow admin or technician to fetch
        if (!technician_id) {
            return res.status(400).json({ error: "Technician ID required" });
        }
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM technician_service_pricing WHERE technician_id = ?", [technician_id]);
        res.json(rows);
    } catch (err) {
        console.error("[getTechnicianServicePricing]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const saveTechnicianPricing = async (req, res) => {
    try {
        const technician_id = req.params.technicianId || req.user?.id; 
        const { pricing_data } = req.body; // array of objects

        if (!technician_id) {
            return res.status(400).json({ error: "Technician ID required" });
        }

        const pool = await db.getPool();
        const conn = await pool.getConnection();

        try {
            await conn.beginTransaction();

            await replaceTechnicianServicePricing(conn, technician_id, pricing_data || []);

            await conn.commit();
            res.json({ success: true });
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    } catch (err) {
        console.error("[saveTechnicianPricing]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};
