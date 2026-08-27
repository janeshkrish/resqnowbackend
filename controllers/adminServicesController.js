import * as db from "../db.js";

// --- Services ---
export const getServices = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM service_master ORDER BY id");
        res.json(rows);
    } catch (err) {
        console.error("[getServices]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createService = async (req, res) => {
    try {
        const { service_name, description, icon, active } = req.body;
        const service_slug = service_name.toLowerCase().replace(/ /g, '_');
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO service_master (service_name, service_slug, description, icon, active) VALUES (?, ?, ?, ?, ?)",
            [service_name, service_slug, description || null, icon || null, active !== undefined ? active : true]
        );
        res.json({ id: result.insertId, service_name, service_slug, description, icon, active });
    } catch (err) {
        console.error("[createService]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const updateService = async (req, res) => {
    try {
        const id = req.params.id;
        const { service_name, description, icon, active } = req.body;
        const pool = await db.getPool();
        await pool.execute(
            "UPDATE service_master SET service_name = ?, description = ?, icon = ?, active = ? WHERE id = ?",
            [service_name, description || null, icon || null, active !== undefined ? active : true, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("[updateService]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deleteService = async (req, res) => {
    try {
        const id = req.params.id;
        const pool = await db.getPool();
        // Also delete related mapping and pricing fields
        await pool.execute("DELETE FROM service_vehicle_mapping WHERE service_id = ?", [id]);
        await pool.execute("DELETE FROM service_pricing_field_master WHERE service_id = ?", [id]);
        await pool.execute("DELETE FROM service_master WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deleteService]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Vehicle Categories ---
export const getVehicleCategories = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM vehicle_category_master ORDER BY id");
        res.json(rows);
    } catch (err) {
        console.error("[getVehicleCategories]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createVehicleCategory = async (req, res) => {
    try {
        const { category_name, description, active } = req.body;
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO vehicle_category_master (category_name, description, active) VALUES (?, ?, ?)",
            [category_name, description || null, active !== undefined ? active : true]
        );
        res.json({ id: result.insertId, category_name, description, active });
    } catch (err) {
        console.error("[createVehicleCategory]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deleteVehicleCategory = async (req, res) => {
    try {
        const id = req.params.id;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM vehicle_category_master WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deleteVehicleCategory]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Vehicle Subcategories ---
export const getVehicleSubcategories = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM vehicle_subcategory_master ORDER BY id");
        res.json(rows);
    } catch (err) {
        console.error("[getVehicleSubcategories]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createVehicleSubcategory = async (req, res) => {
    try {
        const { vehicle_category_id, subcategory_name, active } = req.body;
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO vehicle_subcategory_master (vehicle_category_id, subcategory_name, active) VALUES (?, ?, ?)",
            [vehicle_category_id, subcategory_name, active !== undefined ? active : true]
        );
        res.json({ id: result.insertId, vehicle_category_id, subcategory_name, active });
    } catch (err) {
        console.error("[createVehicleSubcategory]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deleteVehicleSubcategory = async (req, res) => {
    try {
        const id = req.params.id;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM vehicle_subcategory_master WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deleteVehicleSubcategory]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Service Vehicle Mapping ---
export const getServiceVehicleMappings = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM service_vehicle_mapping");
        res.json(rows);
    } catch (err) {
        console.error("[getServiceVehicleMappings]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createServiceVehicleMapping = async (req, res) => {
    try {
        const { service_id, vehicle_category_id } = req.body;
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO service_vehicle_mapping (service_id, vehicle_category_id) VALUES (?, ?)",
            [service_id, vehicle_category_id]
        );
        res.json({ id: result.insertId, service_id, vehicle_category_id });
    } catch (err) {
        console.error("[createServiceVehicleMapping]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deleteServiceVehicleMapping = async (req, res) => {
    try {
        const { service_id, vehicle_category_id } = req.params;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM service_vehicle_mapping WHERE service_id = ? AND vehicle_category_id = ?", [service_id, vehicle_category_id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deleteServiceVehicleMapping]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Pricing Fields ---
export const getPricingFields = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM service_pricing_field_master ORDER BY service_id, sort_order");
        res.json(rows);
    } catch (err) {
        console.error("[getPricingFields]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createPricingField = async (req, res) => {
    try {
        const { service_id, field_key, field_label, field_type, required, sort_order } = req.body;
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO service_pricing_field_master (service_id, field_key, field_label, field_type, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
            [service_id, field_key, field_label, field_type || 'Number', required !== undefined ? required : true, sort_order || 0]
        );
        res.json({ id: result.insertId, service_id, field_key, field_label, field_type, required, sort_order });
    } catch (err) {
        console.error("[createPricingField]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deletePricingField = async (req, res) => {
    try {
        const id = req.params.id;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM service_pricing_field_master WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deletePricingField]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

// --- Fleets ---
export const getFleets = async (req, res) => {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT * FROM towing_fleet_master ORDER BY id");
        res.json(rows);
    } catch (err) {
        console.error("[getFleets]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createFleet = async (req, res) => {
    try {
        const { fleet_name, description, active } = req.body;
        const pool = await db.getPool();
        const [result] = await pool.execute(
            "INSERT INTO towing_fleet_master (fleet_name, description, active) VALUES (?, ?, ?)",
            [fleet_name, description || null, active !== undefined ? active : true]
        );
        res.json({ id: result.insertId, fleet_name, description, active });
    } catch (err) {
        console.error("[createFleet]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const deleteFleet = async (req, res) => {
    try {
        const id = req.params.id;
        const pool = await db.getPool();
        await pool.execute("DELETE FROM towing_fleet_master WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("[deleteFleet]", err);
        res.status(500).json({ error: "Internal server error" });
    }
};
