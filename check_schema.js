
import * as db from './db.js';

async function checkSchema() {
    try {
        const pool = await db.getPool();
        const [rows] = await pool.query("DESCRIBE service_requests");
        console.log(rows);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkSchema();
