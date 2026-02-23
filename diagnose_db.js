import * as db from "./db.js";
import "./loadEnv.js";

async function diagnose() {
    console.log("Diagnosing 'users' table schema...");
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("DESCRIBE users");
        console.log(rows);
    } catch (err) {
        console.error("Diagnosis failed:", err);
    } finally {
        process.exit();
    }
}

diagnose();
