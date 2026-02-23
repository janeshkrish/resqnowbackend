import * as db from "./db.js";
import "./loadEnv.js";

async function fixSchema() {
    console.log("Starting schema fix...");
    try {
        const pool = await db.getPool();

        const [columns] = await pool.query("SHOW COLUMNS FROM users");
        const colNames = columns.map(c => c.Field);
        console.log("Current columns:", colNames);

        if (!colNames.includes('google_id')) {
            console.log("Adding google_id...");
            await pool.query("ALTER TABLE users ADD COLUMN google_id VARCHAR(255)");
            try {
                await pool.query("CREATE UNIQUE INDEX idx_users_google_id ON users(google_id)");
            } catch (e) {
                console.log("Index might already exist or failed:", e.message);
            }
        }

        if (!colNames.includes('is_verified')) {
            console.log("Adding is_verified...");
            await pool.query("ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT FALSE");
        }

        if (colNames.includes('email_confirmed')) {
            console.log("Migrating email_confirmed -> is_verified...");
            await pool.query("UPDATE users SET is_verified = email_confirmed WHERE email_confirmed IS NOT NULL");
            // Optional: Drop email_confirmed or keep it for safety. keeping for now.
        }

        // Force update the specific user 90001 (janeshkrishna12@gmail.com) just to be sure
        console.log("Force verifying janeshkrishna12@gmail.com...");
        await pool.query("UPDATE users SET is_verified = 1 WHERE email = 'janeshkrishna12@gmail.com'");

        console.log("Schema fix complete.");

    } catch (err) {
        console.error("Fix failed:", err);
    } finally {
        process.exit();
    }
}

fixSchema();
