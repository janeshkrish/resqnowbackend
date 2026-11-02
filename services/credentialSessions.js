import { getPool } from '../db.js';
import { isUuid } from '../models/identifiers.js';

export function createCredentialSessionValidator({ getPool: resolvePool = getPool } = {}) {
  return async function validateCredentialSession(identity) {
    if (identity?.role === 'admin') return;
    const { id, role, sessionVersion = 0 } = identity || {};
    const denied = () => Object.assign(new Error('Please sign in again.'), { statusCode: 401 });
    if (!isUuid(id) || !['user','technician'].includes(role) || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0) throw denied();
    let row;
    try {
      const [[account]] = await (await resolvePool()).query(`SELECT auth_version FROM ${role === 'user' ? 'users' : 'technicians'} WHERE id = ?${role === 'user' ? " AND COALESCE(role, 'user') = 'user'" : ''} LIMIT 1`, [id]);
      row = account;
    } catch { throw Object.assign(new Error('Authentication is temporarily unavailable. Please retry.'), { statusCode: 503 }); }
    if (!row || Number(row.auth_version) !== sessionVersion) throw denied();
  };
}

export const validateCredentialSession = createCredentialSessionValidator();
