
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from parent directory or current?
// server/.env usually doesn't exist? The user has d:\ResQNow all files\swift-assist-network\.env
// So we need to load from ../.env
dotenv.config({ path: '../.env' });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 4000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function main() {
    try {
        console.log("Updating technician coordinates...");

        // Delhi Coordinates: 28.6139, 77.2090
        // Generate random coords around Delhi
        const baseLat = 28.6139;
        const baseLng = 77.2090;

        const [technicians] = await pool.query("SELECT id FROM technicians");

        for (const tech of technicians) {
            const lat = baseLat + (Math.random() - 0.5) * 0.1; // +/- ~5km
            const lng = baseLng + (Math.random() - 0.5) * 0.1;

            await pool.execute(
                "UPDATE technicians SET latitude = ?, longitude = ?, is_approved = TRUE, status='approved', service_area_range=50 WHERE id = ?",
                [lat, lng, tech.id]
            );
            console.log(`Updated technician ${tech.id} with coords ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
        }

        console.log("Done. Coordinates updated.");
        process.exit(0);
    } catch (err) {
        console.error("Error:", err);
        process.exit(1);
    }
}

main();
