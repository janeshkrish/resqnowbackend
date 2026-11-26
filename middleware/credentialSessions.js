import jwt from 'jsonwebtoken';
import { validateCredentialSession } from '../services/credentialSessions.js';

export function credentialSessions({ validateSession = validateCredentialSession } = {}) {
  return async (req, res, next) => {
    // A stale optional header must not prevent the ordinary login routes from
    // checking new credentials. Exempt exact public routes, never /me or /verify.
    const path = String(req.path || '').replace(/\/+$/, '').toLowerCase();
    const publicPost = /^\/(?:users\/(?:login|phone-login|send-otp|send-otp-debug|verify-otp)|technicians?\/(?:login|register))$/;
    const publicGet = /^\/(?:auth\/)?google\/(?:url|callback)$/;
    if ((req.method === 'POST' && publicPost.test(path)) || (req.method === 'GET' && publicGet.test(path))) return next();
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return next();
    let payload;
    try { payload = jwt.verify(authorization.slice(7), String(process.env.JWT_SECRET || '').trim()); }
    catch { return next(); } // Existing role middleware handles malformed/expired tokens.
    const role = String(payload.role || payload.type || 'user').toLowerCase();
    // Admins are validated too (by ADMIN_SESSION_VERSION); their tokens must carry sv.
    const sessionVersion = role === 'admin' ? payload.sv : (payload.sv ?? 0);
    try {
      await validateSession({ id: payload.userId || payload.id || payload.technicianId, role, sessionVersion });
      return next();
    } catch (error) {
      res.set('Cache-Control', 'no-store');
      return res.status(error.statusCode === 401 ? 401 : 503).json({ error: error.statusCode === 401 ? 'Please sign in again.' : 'Authentication is temporarily unavailable. Please retry.' });
    }
  };
}

export function mountCredentialSessions(app, options) {
  const guard = credentialSessions(options);
  app.use('/api', guard);
  app.use('/auth', guard);
}
