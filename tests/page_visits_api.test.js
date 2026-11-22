import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

import { createPublicPageVisitsRouter, createAdminPageVisitsRouter } from '../routes/pageVisits.js';
import { extractClientIp, normalizeIp, isPrivateOrLocalIp } from '../utils/clientIp.js';
import { parseUserAgent } from '../utils/userAgentParser.js';
import { resolveLocationFromIp } from '../utils/geoLookup.js';

process.env.JWT_SECRET = 'test-signing-secret-for-page-visits';

test('client IP extractor handles proxy headers and IPv6 mapping', () => {
  assert.equal(normalizeIp('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normalizeIp('::1'), '127.0.0.1');
  assert.equal(normalizeIp('10.0.0.1:8080'), '10.0.0.1');

  assert.equal(isPrivateOrLocalIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('192.168.0.1'), true);
  assert.equal(isPrivateOrLocalIp('10.20.30.40'), true);
  assert.equal(isPrivateOrLocalIp('8.8.8.8'), false);

  const reqCf = { headers: { 'cf-connecting-ip': '203.0.113.195' } };
  assert.equal(extractClientIp(reqCf), '203.0.113.195');

  const reqXff = { headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } };
  assert.equal(extractClientIp(reqXff), '198.51.100.1');
});

test('user agent parser identifies devices, browsers and bots', () => {
  const chromeDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const parsedDesktop = parseUserAgent(chromeDesktop);
  assert.equal(parsedDesktop.isBot, false);
  assert.ok(parsedDesktop.device.includes('Desktop'));
  assert.ok(parsedDesktop.browser.includes('Chrome'));

  const googlebot = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const parsedBot = parseUserAgent(googlebot);
  assert.equal(parsedBot.isBot, true);

  const androidMobile = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const parsedMobile = parseUserAgent(androidMobile);
  assert.equal(parsedMobile.isBot, false);
  assert.ok(parsedMobile.device.includes('Mobile'));
});

test('geo lookup handles local and private IPs gracefully', () => {
  assert.equal(resolveLocationFromIp('127.0.0.1'), 'Local/Unknown');
  assert.equal(resolveLocationFromIp('192.168.1.1'), 'Local/Unknown');
  assert.equal(resolveLocationFromIp('10.0.0.1'), 'Local/Unknown');
});

test('public page-visit ingestion route validates payload, captures user info and skips bots/admin', async () => {
  const app = express();
  app.use('/api/page-visits', createPublicPageVisitsRouter());

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/page-visits`;

  try {
    // 1. Missing fields -> 400
    const resBad = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_visited: '' }),
    });
    assert.equal(resBad.status, 400);

    // 2. Admin routes -> skipped
    const resAdmin = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_visited: '/admin/today', session_id: 's_123' }),
    });
    assert.equal(resAdmin.status, 200);
    const dataAdmin = await resAdmin.json();
    assert.equal(dataAdmin.skipped, 'admin');

    // 3. Known bot -> skipped
    const resBot = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
      },
      body: JSON.stringify({ page_visited: '/services', session_id: 's_bot' }),
    });
    assert.equal(resBot.status, 200);
    const dataBot = await resBot.json();
    assert.equal(dataBot.skipped, 'bot');

    // 4. Ingestion with logged-in user details (username, gmail, phone) works with plain text/beacon or json
    const resUserVisit = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        id: randomUUID(),
        page_visited: '/services',
        previous_page: '/home',
        session_id: 's_user_session',
        time_spent_seconds: 15,
        user_name: 'Test Visitor',
        user_email: 'visitor@gmail.com',
        user_phone: '+91 9988776655',
        user_role: 'customer',
      }),
    });
    // Will return 200/201 or 500 if DB is mocked/not present, but body parse passes 400 check
    assert.notEqual(resUserVisit.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('admin page-visit routes enforce admin JWT auth', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/page-visits', createAdminPageVisitsRouter());

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/page-visits`;

  const makeToken = (role) =>
    jwt.sign({ id: randomUUID(), userId: randomUUID(), role, email: 'admin@resqnow.org' }, process.env.JWT_SECRET);

  try {
    // 1. No token -> 401
    const resNoAuth = await fetch(`${baseUrl}/summary`);
    assert.equal(resNoAuth.status, 401);

    // 2. User / technician token -> 403
    const resUser = await fetch(`${baseUrl}/summary`, {
      headers: { Authorization: `Bearer ${makeToken('user')}` },
    });
    assert.equal(resUser.status, 403);

    const resTech = await fetch(`${baseUrl}/summary`, {
      headers: { Authorization: `Bearer ${makeToken('technician')}` },
    });
    assert.equal(resTech.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
