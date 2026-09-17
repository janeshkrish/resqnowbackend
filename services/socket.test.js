import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import {
  SocketAuthError,
  SocketService,
  authenticateSocketToken,
  createSocketAccessControl,
} from './socket.js';

process.env.JWT_SECRET = 'socket-test-secret';

function token(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function emitWithAcknowledgement(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function waitForConnection(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

test('authenticates technician, user, and admin socket identities from JWT claims', () => {
  assert.deepEqual(
    authenticateSocketToken(token({ id: '7', email: 'tech@example.com', role: 'technician' })),
    { id: '7', email: 'tech@example.com', role: 'technician' },
  );
  assert.deepEqual(
    authenticateSocketToken(token({ id: '9', email: 'user@example.com', type: 'user' })),
    { id: '9', email: 'user@example.com', role: 'user' },
  );
});

test('rejects a missing or malformed socket token', () => {
  for (const value of [undefined, '', 'not-a-jwt']) {
    assert.throws(() => authenticateSocketToken(value), SocketAuthError);
  }
});

test('authorises request subscription only for the request owner or an admin', async () => {
  const pool = {
    async execute(_sql, [requestId, userId]) {
      const isAuthorized = String(requestId) === '44' && (userId === undefined || String(userId) === '9');
      return [isAuthorized ? [{ id: 44 }] : [], []];
    },
  };
  const access = createSocketAccessControl({ getPool: async () => pool });

  assert.equal(await access.canSubscribeToRequest({ id: '9', role: 'user' }, '44'), true);
  assert.equal(await access.canSubscribeToRequest({ id: '10', role: 'user' }, '44'), false);
  assert.equal(await access.canSubscribeToRequest({ id: '1', role: 'admin' }, '44'), true);
  assert.equal(await access.canSubscribeToRequest({ id: '7', role: 'technician' }, '44'), false);
});

test('returns the assigned technician only after the subscriber is authorised', async () => {
  const pool = {
    async execute(_sql, [requestId, userId]) {
      const isOwner = String(requestId) === '44' && String(userId) === '9';
      return [isOwner ? [{ id: 44, technician_id: 7 }] : [], []];
    },
  };
  const access = createSocketAccessControl({ getPool: async () => pool });

  assert.deepEqual(
    await access.getTrackingRequest({ id: '9', role: 'user' }, '44'),
    { requestId: '44', technicianId: '7' },
  );
  assert.equal(await access.getTrackingRequest({ id: '10', role: 'user' }, '44'), null);
});

test('delivers accepted tracking only to an authorised request subscriber', async (t) => {
  const server = createServer();
  const service = new SocketService();
  const location = {
    version: 1,
    technicianId: '7',
    requestId: '44',
    jobId: '44',
    lat: 12.9716,
    lng: 77.5946,
    speed: 8,
    heading: 90,
    accuracy: 10,
    recordedAt: '2026-09-17T10:00:00.000Z',
    recordedAtMs: Date.parse('2026-09-17T10:00:00.000Z'),
    sequenceId: 1001,
    receivedAt: '2026-09-17T10:00:00.010Z',
    locationUpdatedAt: '2026-09-17T10:00:00.000Z',
  };
  service.init(server, {
    accessControl: {
      async getTrackingRequest(identity, requestId) {
        return identity.role === 'user' && identity.id === '9' && String(requestId) === '44'
          ? { requestId: '44', technicianId: '7' }
          : null;
      },
    },
    trackingIngestion: {
      async ingest({ identity, payload }) {
        return identity.id === '7' && payload.sequenceId === 1001
          ? { ok: true, location }
          : { ok: false, code: 'FORBIDDEN' };
      },
      async getRecoverySnapshot() {
        return location;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const options = (authToken) => ({ transports: ['websocket'], auth: { token: authToken } });
  const technician = createClient(`http://127.0.0.1:${port}`, options(token({ id: '7', role: 'technician' })));
  const owner = createClient(`http://127.0.0.1:${port}`, options(token({ id: '9', role: 'user' })));
  const intruder = createClient(`http://127.0.0.1:${port}`, options(token({ id: '10', role: 'user' })));

  t.after(async () => {
    technician.disconnect();
    owner.disconnect();
    intruder.disconnect();
    service.io?.close();
    await new Promise((resolve) => server.close(resolve));
  });

  await Promise.all([waitForConnection(technician), waitForConnection(owner), waitForConnection(intruder)]);
  assert.equal((await emitWithAcknowledgement(owner, 'tracking:subscribe:v1', { requestId: '44' })).ok, true);
  assert.deepEqual(await emitWithAcknowledgement(intruder, 'tracking:subscribe:v1', { requestId: '44' }), { ok: false, code: 'FORBIDDEN' });

  const ownerEvent = waitForEvent(owner, 'tracking:location:v1');
  const acknowledgement = await emitWithAcknowledgement(technician, 'tracking:location:v1', location);

  assert.equal(acknowledgement.ok, true);
  assert.deepEqual(await ownerEvent, location);
});
