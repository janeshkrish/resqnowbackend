import "./loadEnv.js";
import * as db from "./db.js";
import fs from "fs";

async function checkJobs() {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("SELECT id, user_id, technician_id, service_type, service_charge, amount, status, created_at FROM service_requests ORDER BY created_at DESC LIMIT 5");
        console.log("Recent Jobs:");
        const json = JSON.stringify(rows, null, 2);
        console.log(json);
        fs.writeFileSync("jobs_dump.json", json, "utf8");
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkJobs();
