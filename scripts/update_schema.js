
import { getPool } from "../db.js";

async function run() {
    try {
        const pool = await getPool();
        console.log("Adding is_available column to technicians table...");
        await pool.query("ALTER TABLE technicians ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT FALSE");
        console.log("Successfully added is_available column.");
        process.exit(0);
    } catch (err) {
        console.error("Error updating schema:", err);
        process.exit(1);
    }
}

run();
