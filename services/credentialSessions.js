import { getPool } from '../db.js';
import { isUuid } from '../models/identifiers.js';
import { isCurrentAdminSession } from './adminCredentials.js';

export function createCredentialSessionValidator({ getPool: resolvePool = getPool } = {}) {
  return async function validateCredentialSession(identity) {
    const denied = () => Object.assign(new Error('Please sign in again.'), { statusCode: 401 });
    // The admin account lives in the environment, so its sessions are versioned by
    // ADMIN_SESSION_VERSION rather than a database row. No default: a token without
    // a version is a pre-revocation token and must sign in again.
    if (identity?.role === 'admin') {
      if (!isCurrentAdminSession(identity.sessionVersion)) throw denied();
      return;
    }
    const { id, role, sessionVersion = 0 } = identity || {};
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
