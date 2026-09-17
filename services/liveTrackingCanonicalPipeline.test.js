import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';

import { createLiveTrackingIngestion } from './liveTrackingIngestion.js';
import { createLiveTrackingStore } from './liveTrackingStore.js';
import { SocketService } from './socket.js';

process.env.JWT_SECRET = 'canonical-pipeline-test-secret';

const token = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
const emitWithAcknowledgement = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const waitForConnection = (socket) => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});
const waitForEvent = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

class MemoryRedis {
  values = new Map();

  async eval(script, _keys, key, ...args) {
    if (script.includes('-- history-sample')) return ['claimed'];
    const nextJson = args[0];
    const next = JSON.parse(nextJson);
    const existingJson = this.values.get(key);
    if (existingJson) {
      const existing = JSON.parse(existingJson);
      if (next.sequenceId === existing.sequenceId) return ['duplicate', existingJson];
      if (next.recordedAtMs < existing.recordedAtMs ||
        (next.recordedAtMs === existing.recordedAtMs && next.sequenceId < existing.sequenceId)) {
        return ['out_of_order', existingJson];
      }
    }
    this.values.set(key, nextJson);
    return ['accepted', nextJson];
  }

  async get(key) { return this.values.get(key) ?? null; }
  async ttl() { return 30; }
  async set() { return 'OK'; }
}

test('P1 through P4 travel through canonical ingestion, Redis state, request room, and customer socket', async (t) => {
  const redis = new MemoryRedis();
  const store = createLiveTrackingStore(redis);
  const pool = {
    async execute(sql) {
      if (sql.includes('FROM service_requests')) {
        return [[{ id: 44, technician_id: 7, status: 'en-route' }], []];
      }
      return [[], []];
    },
  };
  const ingestion = createLiveTrackingIngestion({
    getPool: async () => pool,
    store,
    now: () => Date.UTC(2026, 8, 17, 10, 0, 12),
  });
  const server = createServer();
  const service = new SocketService();
  service.init(server, {
    trackingIngestion: ingestion,
    accessControl: {
      async getTrackingRequest(identity, requestId) {
        return identity.role === 'user' && identity.id === '9' && String(requestId) === '44'
          ? { requestId: '44', technicianId: '7' }
          : null;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const options = (auth) => ({ transports: ['websocket'], auth: { token: auth } });
  const technician = createClient(`http://127.0.0.1:${port}`, options(token({ id: '7', role: 'technician' })));
  const customer = createClient(`http://127.0.0.1:${port}`, options(token({ id: '9', role: 'user' })));
  t.after(async () => {
    technician.disconnect();
    customer.disconnect();
    service.io?.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await Promise.all([waitForConnection(technician), waitForConnection(customer)]);
  assert.equal((await emitWithAcknowledgement(customer, 'tracking:subscribe:v1', { requestId: '44' })).ok, true);

  const points = [
    [11.0000, 76.0000, 100],
    [11.0010, 76.0010, 101],
    [11.0020, 76.0020, 102],
    [11.0030, 76.0030, 103],
  ];
  const received = [];
  for (let index = 0; index < points.length; index += 1) {
    const [lat, lng, sequenceId] = points[index];
    const expectedEvent = waitForEvent(customer, 'tracking:location:v1');
    const acknowledgement = await emitWithAcknowledgement(technician, 'tracking:location:v1', {
      version: 1,
      technicianId: '7',
      jobId: '44',
      lat,
      lng,
      speed: 12,
      heading: 45,
      accuracy: 8,
      recordedAt: new Date(Date.UTC(2026, 8, 17, 10, 0, index * 3)).toISOString(),
      sequenceId,
    });
    assert.equal(acknowledgement.ok, true, `P${index + 1}: ${JSON.stringify(acknowledgement)}`);
    received.push(await expectedEvent);
  }

  assert.deepEqual(received.map((point) => [point.lat, point.lng, point.sequenceId]), points);
  const stored = await store.getForRequest('7', '44');
  assert.equal(stored.lat, points[3][0]);
  assert.equal(stored.lng, points[3][1]);
  assert.equal(stored.sequenceId, points[3][2]);
  assert.equal(await store.getTtlForTechnician('7'), 30);
});
