import * as db from "./db.js";
import "./loadEnv.js";

async function setup() {
    console.log("Setting up database for OTP refactor...");
    try {
        const pool = await db.getPool();

        // 1. Create otp_requests table
        console.log("Creating otp_requests table...");
        await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        otp_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email)
      )
    `);

        // 2. Modify users table: Add role if missing
        console.log("Checking columns in users table...");
        const [cols] = await pool.query("SHOW COLUMNS FROM users");
        const colNames = cols.map(c => c.Field);

        if (!colNames.includes("role")) {
            console.log("Adding 'role' column to users...");
            await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'user'");
        }

        // 3. Cleanup users table (Delete all normal users)
        // Technicians are in 'technicians' table. Admins are Env-based. 
        // So 'users' table contains only end-users.
        console.log("Cleaning up users table...");
        await pool.query("DELETE FROM users");
        console.log("Users table cleared.");

    } catch (err) {
        console.error("Setup failed:", err);
    } finally {
        process.exit();
    }
}

setup();
