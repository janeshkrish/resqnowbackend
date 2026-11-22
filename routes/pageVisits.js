import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { verifyAdmin } from '../middleware/auth.js';
import { extractClientIp } from '../utils/clientIp.js';
import { parseUserAgent } from '../utils/userAgentParser.js';
import { resolveLocationFromIp } from '../utils/geoLookup.js';
import {
  recordPageVisit,
  getPageVisitSummary,
  listPageVisits,
} from '../services/pageVisitService.js';

function extractUserFromAuthHeader(req) {
  const auth = req.headers?.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  try {
    const token = auth.slice(7);
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === 'object') {
      return {
        email: decoded.email || null,
        name: decoded.name || decoded.fullName || null,
        phone: decoded.phone || decoded.phoneNumber || null,
        role: decoded.role || decoded.type || null,
      };
    }
  } catch {}
  return null;
}

/**
 * Public ingestion router: POST /api/page-visits
 */
export function createPublicPageVisitsRouter() {
  const router = Router();

  // Internal body parsers to ensure robust parsing regardless of upstream middleware position
  router.use(express.json({ limit: '64kb' }));
  router.use(express.text({ type: ['text/plain', 'application/json', '*/*'], limit: '64kb' }));

  const visitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200, // 200 requests per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded' },
  });

  router.post('/', visitLimiter, async (req, res) => {
    try {
      let body = req.body || {};
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }

      const id = body.id || body.visit_id || undefined;
      const pageVisited = String(body.page_visited || '').trim();
      const previousPage = String(body.previous_page || 'direct').trim();
      const sessionId = String(body.session_id || '').trim();
      const timeSpentSeconds = Math.max(0, parseInt(body.time_spent_seconds, 10) || 0);

      // Validate required fields
      if (!pageVisited || !sessionId) {
        return res.status(400).json({ error: 'Missing required tracking parameters' });
      }

      // Skip tracking admin routes
      if (pageVisited.startsWith('/admin')) {
        return res.status(200).json({ ok: true, skipped: 'admin' });
      }

      const clientIp = extractClientIp(req);
      const userAgent = req.headers['user-agent'] || '';
      const { isBot, device, browser } = parseUserAgent(userAgent);

      // Skip bots and crawlers
      if (isBot) {
        return res.status(200).json({ ok: true, skipped: 'bot' });
      }

      const location = resolveLocationFromIp(clientIp);
      const tokenUser = extractUserFromAuthHeader(req);

      const userName = body.user_name || tokenUser?.name || null;
      const userEmail = body.user_email || tokenUser?.email || null;
      const userPhone = body.user_phone || tokenUser?.phone || null;
      const userRole = body.user_role || tokenUser?.role || null;

      const result = await recordPageVisit({
        id,
        ipAddress: clientIp,
        pageVisited,
        previousPage,
        timeSpentSeconds,
        device,
        browser,
        location,
        sessionId,
        userName,
        userEmail,
        userPhone,
        userRole,
      });

      return res.status(200).json({ ok: true, id: result.id });
    } catch (err) {
      console.error('[PageVisitIngestion] Error recording visit:', err?.message || err);
      return res.status(500).json({ error: 'Failed to record visit' });
    }
  });

  return router;
}

/**
 * Admin API router: mounted under /api/admin/page-visits
 */
export function createAdminPageVisitsRouter() {
  const router = Router();

  router.use(express.json());
  router.use(verifyAdmin);

  router.get('/summary', async (req, res) => {
    try {
      const range = String(req.query.range || 'today').trim();
      const summary = await getPageVisitSummary({ range });
      return res.json(summary);
    } catch (err) {
      console.error('[AdminPageVisits] Error getting summary:', err?.message || err);
      return res.status(500).json({ error: 'Failed to load page visit summary' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 25;
      const range = String(req.query.range || 'today').trim();
      const source = req.query.source ? String(req.query.source) : undefined;
      const device = req.query.device ? String(req.query.device) : undefined;
      const browser = req.query.browser ? String(req.query.browser) : undefined;
      const search = req.query.search ? String(req.query.search) : undefined;

      const data = await listPageVisits({
        page,
        limit,
        range,
        source,
        device,
        browser,
        search,
      });

      return res.json(data);
    } catch (err) {
      console.error('[AdminPageVisits] Error listing visits:', err?.message || err);
      return res.status(500).json({ error: 'Failed to list page visits' });
    }
  });

  return router;
}
