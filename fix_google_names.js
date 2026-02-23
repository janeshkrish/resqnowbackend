
import "./loadEnv.js";
import { getPool } from "./db.js";

async function fixNames() {
    try {
        const pool = await getPool();
        console.log("Fixing missing names for Google users...");

        // Update users where name is NULL or empty, fallback to email prefix
        const sql = `
      UPDATE users
      SET name = SUBSTRING_INDEX(email, '@', 1)
      WHERE (name IS NULL OR name = '')
      AND provider = 'google'
    `;

        const [result] = await pool.execute(sql);
        console.log(`Updated ${result.affectedRows} users.`);

        process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    }
}

fixNames();
