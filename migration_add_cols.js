import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import { getPool } from './db.js';

async function migrate() {
    console.log('Starting migration...');
    const pool = await getPool();

    try {
        // Add columns if they don't exist
        const columns = [
            "ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8)",
            "ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8)",
            "ADD COLUMN IF NOT EXISTS rating DECIMAL(3, 2) DEFAULT 5.00",
            "ADD COLUMN IF NOT EXISTS jobs_completed INT DEFAULT 0",
            "ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE"
        ];

        for (const col of columns) {
            const query = `ALTER TABLE technicians ${col}`;
            console.log(`Executing: ${query}`);
            await pool.query(query);
        }

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrate();
