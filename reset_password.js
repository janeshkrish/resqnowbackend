import './loadEnv.js';
import * as db from './db.js';
import bcrypt from 'bcrypt';

async function resetPassword() {
    try {
        const email = 'booshanbaratvajy@gmail.com';
        const newPassword = 'password123';
        const hash = await bcrypt.hash(newPassword, 10);

        await db.query("UPDATE technicians SET password_hash = ? WHERE email = ?", [hash, email]);
        console.log(`Password for ${email} reset to ${newPassword}`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

resetPassword();
