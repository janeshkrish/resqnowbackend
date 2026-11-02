import express from 'express';
import { verifyUser, verifyTechnician } from '../middleware/auth.js';
import { createPasswordRecoveryService } from '../services/passwordRecoveryService.js';
import { getPool } from '../db.js';
import { getFrontendUrl } from '../config/network.js';
import { sendEmail } from '../services/emailService.js';
import { socketService } from '../services/socket.js';

export function createPasswordRecoveryRouter({ service, responseFloorMs = 300 } = {}) {
  const recovery = service || createPasswordRecoveryService({
    getPool, frontendUrl: getFrontendUrl(),
    revokeSessions: (role, id) => socketService.revokeSessions(role, id),
    onDeliveryError: () => console.warn('[Password recovery] Delivery unavailable; no challenge contents logged.'),
    sendMail: ({ kind, to, role, link }) => {
      const account = role === 'technician' ? 'technician' : 'customer';
      const subject = kind === 'password_changed' ? 'ResQNow password changed' : kind === 'verify_email' ? 'Verify your ResQNow recovery email' : 'Reset your ResQNow password';
      const text = kind === 'password_changed'
        ? `Your ResQNow ${account} password was changed and existing sessions were revoked. If you did not do this, contact ResQNow support immediately.`
        : `For your ResQNow ${account} account: ${link}\nThis single-use link expires in 15 minutes. If you did not request it, ignore this email.`;
      return sendEmail({ to, subject: `${subject} (${account})`, text, sensitive: true });
    },
  });
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); next();
  });
  const action = (method, status = 200) => async (req, res) => {
    const started = Date.now();
    try {
      const result = await recovery[method]({ role: req.params.role, email: req.body?.email, token: req.body?.token, password: req.body?.password,
        currentPassword: req.body?.currentPassword, ip: req.ip, accountId: req.technicianId || req.user?.userId || req.user?.id });
      if (method === 'request') await new Promise(resolve => setTimeout(resolve, Math.max(0, responseFloorMs - (Date.now() - started))));
      return res.status(status).json(result);
    } catch (error) {
      if (method === 'request') await new Promise(resolve => setTimeout(resolve, Math.max(0, responseFloorMs - (Date.now() - started))));
      return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Password recovery is temporarily unavailable. Please retry.' });
    }
  };
  const authenticate = (req, res, next) => {
    if (req.params.role === 'technician') return verifyTechnician(req, res, next);
    return verifyUser(req, res, () => {
      const role = req.user?.role || req.user?.type || 'user';
      if (role !== 'user') return res.status(403).json({ error: 'Forbidden' });
      next();
    });
  };
  router.param('role', (req, res, next, role) => ['user', 'technician'].includes(role) ? next() : res.status(400).json({ error: 'Invalid account type.' }));
  router.post('/:role/request', action('request', 202));
  router.post('/:role/confirm', action('confirm'));
  router.post('/:role/verification/request', authenticate, action('verificationRequest', 202));
  router.post('/:role/verification/confirm', action('verifyEmail'));
  router.get('/:role/status', authenticate, action('status'));
  return router;
}
