import assert from 'node:assert/strict';
import test from 'node:test';

import { PhoneLoginError, cleanName, handlePhoneLogin, normalizeE164 } from '../services/phoneLogin.js';

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const PHONE_TOKEN = { uid: 'fb-uid-1', phone_number: '+919876543210', firebase: { sign_in_provider: 'phone' } };

/** The users table as a list of rows, and every write the route makes to it. */
function setup({ rows = [], decoded = PHONE_TOKEN, verifyError = null, insertError = null } = {}) {
  const users = rows.map((row) => ({ ...row }));
  const seen = { selects: 0, updates: [], inserts: [], signed: [] };
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /FROM users/);
      seen.selects += 1;
      const [uid, phone] = params;
      const match = users.find((row) => row.firebase_uid === uid) || users.find((row) => row.phone_e164 === phone);
      return [match ? [{ ...match }] : []];
    },
    execute: async (sql, params) => {
      if (/^UPDATE users/.test(sql)) {
        seen.updates.push(params);
        const row = users.find((item) => item.id === params[2]);
        Object.assign(row, { firebase_uid: params[0], phone_e164: params[1] });
        return [{ affectedRows: 1 }];
      }
      if (/^INSERT INTO users/.test(sql)) {
        if (insertError) {
          // Someone else's request made the account a moment ago.
          users.push({ id: 77, full_name: 'Asha Raman', email: null, phone: params[1], phone_e164: params[2], firebase_uid: params[3] });
          throw insertError;
        }
        seen.inserts.push({ sql, params });
        const id = 500 + seen.inserts.length;
        users.push({ id, full_name: params[0], email: null, phone: params[1], phone_e164: params[2], firebase_uid: params[3] });
        return [{ insertId: id }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const deps = {
    getPool: async () => pool,
    verifyIdToken: async (token) => {
      if (verifyError) throw verifyError;
      assert.equal(token, 'firebase-id-token');
      return decoded;
    },
    signToken: (id, email) => {
      seen.signed.push({ id, email });
      return `jwt-for-${id}`;
    },
  };
  return { users, seen, deps };
}

async function call(body, deps) {
  const res = createResponse();
  await handlePhoneLogin({ body }, res, deps);
  return res;
}

test('normalizeE164 keeps only full international numbers', () => {
  assert.equal(normalizeE164('+919876543210'), '+919876543210');
  assert.equal(normalizeE164(' +919876543210 '), '+919876543210');
  assert.equal(normalizeE164('9876543210'), '');
  assert.equal(normalizeE164('+91 98765 43210'), '');
  assert.equal(normalizeE164(undefined), '');
});

test('cleanName trims and joins spaces', () => {
  assert.equal(cleanName('  Asha   Raman '), 'Asha Raman');
  assert.equal(cleanName(null), '');
});

test('asks for the sign-in token when there is none', async () => {
  const { deps, seen } = setup();
  const res = await call({}, deps);
  assert.equal(res.statusCode, 400);
  assert.equal(seen.selects, 0);
});

test('a token Firebase does not accept is refused', async () => {
  const { deps, seen } = setup({ verifyError: Object.assign(new Error('expired'), { code: 'auth/id-token-expired' }) });
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /could not confirm your number/);
  assert.equal(seen.selects, 0);
});

test('a token from another way of signing in is refused', async () => {
  const { deps } = setup({ decoded: { uid: 'x', phone_number: '+919876543210', firebase: { sign_in_provider: 'google.com' } } });
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 401);
});

test('says so plainly when Firebase Admin is not set up on the server', async () => {
  const { deps } = setup({ verifyError: new PhoneLoginError(503, 'Phone login is not available right now. Please use Google or email.') });
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /not available right now/);
});

test('a known customer logs straight in, with nothing written', async () => {
  const { deps, seen } = setup({ rows: [{ id: 41, full_name: 'Asha Raman', email: 'asha@example.com', phone: '+919876543210', phone_e164: '+919876543210', firebase_uid: 'fb-uid-1' }] });
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    token: 'jwt-for-41',
    role: 'user',
    isNew: false,
    user: { id: 41, name: 'Asha Raman', email: 'asha@example.com', phone: '+919876543210', isVerified: true, role: 'user' },
  });
  assert.deepEqual(seen.signed, [{ id: 41, email: 'asha@example.com' }]);
  assert.equal(seen.updates.length, 0);
  assert.equal(seen.inserts.length, 0);
});

test('a customer found by the verified number gets the Firebase account noted', async () => {
  const { deps, seen } = setup({ rows: [{ id: 41, full_name: 'Asha Raman', email: null, phone: '+919876543210', phone_e164: '+919876543210', firebase_uid: 'old-uid' }] });
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.updates, [['fb-uid-1', '+919876543210', 41]]);
  assert.equal(res.body.user.email, '');
});

test('a new number is asked for a name and nothing is made yet', async () => {
  const { deps, seen } = setup();
  const res = await call({ idToken: 'firebase-id-token' }, deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { needsName: true, phone: '+919876543210' });
  assert.equal(seen.inserts.length, 0);
  assert.equal(seen.signed.length, 0);
});

test('a new number with a name makes the account, without an email', async () => {
  const { deps, seen } = setup();
  const res = await call({ idToken: 'firebase-id-token', name: '  Asha   Raman ' }, deps);
  assert.equal(res.statusCode, 201);
  assert.equal(seen.inserts.length, 1);
  assert.match(seen.inserts[0].sql, /VALUES \(\?, NULL, \?, \?, \?, 'user', 1, 'approved'\)/);
  assert.deepEqual(seen.inserts[0].params, ['Asha Raman', '+919876543210', '+919876543210', 'fb-uid-1']);
  assert.deepEqual(seen.signed, [{ id: 501, email: null }]);
  assert.deepEqual(res.body, {
    token: 'jwt-for-501',
    role: 'user',
    isNew: true,
    user: { id: 501, name: 'Asha Raman', email: '', phone: '+919876543210', isVerified: true, role: 'user' },
  });
});

test('a name that is too long is refused', async () => {
  const { deps, seen } = setup();
  const res = await call({ idToken: 'firebase-id-token', name: 'A'.repeat(81) }, deps);
  assert.equal(res.statusCode, 400);
  assert.equal(seen.inserts.length, 0);
});

test('two taps at once end in the one account', async () => {
  const { deps } = setup({ insertError: Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 }) });
  const res = await call({ idToken: 'firebase-id-token', name: 'Asha Raman' }, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.id, 77);
  assert.equal(res.body.isNew, false);
});
