import * as db from "./db.js";
import "./loadEnv.js";

async function setup() {
    console.log("Setting up technicians table refactor...");
    try {
        const pool = await db.getPool();

        // 1. Check and Add Columns
        console.log("Checking columns...");
        const [cols] = await pool.query("SHOW COLUMNS FROM technicians");
        const colNames = cols.map(c => c.Field);

        const columnsToAdd = [
            "latitude DECIMAL(10, 8)",
            "longitude DECIMAL(11, 8)",
            "base_price DECIMAL(10, 2) DEFAULT 500",
            "rating DECIMAL(3, 2) DEFAULT 5.0",
            "jobs_completed INT DEFAULT 0",
            "role VARCHAR(20) DEFAULT 'technician'",
            "is_approved BOOLEAN DEFAULT FALSE"
        ];

        for (const colDef of columnsToAdd) {
            const colName = colDef.split(" ")[0];
            if (!colNames.includes(colName)) {
                console.log(`Adding column ${colName}...`);
                await pool.query(`ALTER TABLE technicians ADD COLUMN ${colDef}`);
            }
        }

        // 2. Sync is_approved with status for existing records
        await pool.query("UPDATE technicians SET is_approved = TRUE WHERE status = 'approved'");

        // 3. Clear existing dummy data if needed (optional, but ensures clean state for mock)
        // await pool.query("DELETE FROM technicians WHERE email LIKE '%@example.com'"); 

        // 4. Insert Mock Technicians (Spread around a central point, e.g., Trivandrum or generic)
        // Assuming Trivandrum: 8.5241, 76.9366
        const mockTechs = [
            {
                name: "Rahul Mechanic",
                email: "rahul.mech@example.com",
                phone: "9876543210",
                service_type: "Car Repair",
                lat: 8.5241,
                lng: 76.9366,
                range: 50,
                price: 450,
                rating: 4.8,
                jobs: 120,
                specialties: JSON.stringify(["Car Repair", "Flat Tire"]),
                status: "approved"
            },
            {
                name: "Suresh Bike Specialist",
                email: "suresh.bike@example.com",
                phone: "9876543211",
                service_type: "Bike Repair",
                lat: 8.5290,
                lng: 76.9390, // Slightly away
                range: 30,
                price: 300,
                rating: 4.5,
                jobs: 80,
                specialties: JSON.stringify(["Bike Repair", "Oil Change"]),
                status: "approved"
            },
            {
                name: "EV Expert John",
                email: "john.ev@example.com",
                phone: "9876543212",
                service_type: "EV Support",
                lat: 8.5400,
                lng: 76.9500, // Further away
                range: 100,
                price: 800,
                rating: 4.9,
                jobs: 45,
                specialties: JSON.stringify(["EV Support", "Battery"]),
                status: "approved"
            },
            {
                name: "Towing Titans",
                email: "towing@example.com",
                phone: "9876543213",
                service_type: "Towing",
                lat: 8.5000,
                lng: 76.9000,
                range: 100,
                price: 1500,
                rating: 5.0,
                jobs: 200,
                specialties: JSON.stringify(["Towing"]),
                status: "approved"
            }
        ];

        console.log("Seeding mock technicians...");
        for (const tech of mockTechs) {
            // Check if exists
            const [existing] = await pool.query("SELECT id FROM technicians WHERE email = ?", [tech.email]);
            if (existing.length === 0) {
                await pool.query(
                    `INSERT INTO technicians 
          (name, email, phone, service_type, latitude, longitude, service_area_range, base_price, rating, jobs_completed, specialties, status, is_approved, role, password_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'technician', '$2a$10$GoogleNativeAuthDummyPassHash')`,
                    [tech.name, tech.email, tech.phone, tech.service_type, tech.lat, tech.lng, tech.range, tech.price, tech.rating, tech.jobs, tech.specialties, tech.status]
                );
            }
        }

        console.log("Technicians table setup complete.");

    } catch (err) {
        console.error("Setup failed:", err);
    } finally {
        process.exit();
    }
}

setup();
