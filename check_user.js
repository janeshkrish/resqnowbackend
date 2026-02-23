import * as db from "./db.js";
import "./loadEnv.js";

async function check() {
    console.log("Checking schema and user status...");
    try {
        const pool = await db.getPool();

        // 1. Schema
        const [cols] = await pool.query("DESCRIBE users");
        const fields = cols.map(c => c.Field);
        console.log("Users Table Columns:", fields);

        // 2. User Data
        const [users] = await pool.query("SELECT * FROM users WHERE email = 'janeshkrishna12@gmail.com'");
        if (users.length > 0) {
            console.log("User found:", users[0]);
        } else {
            console.log("User 'janeshkrishna12@gmail.com' NOT found.");
        }

    } catch (err) {
        console.error("Check failed:", err);
    } finally {
        process.exit();
    }
}

check();
