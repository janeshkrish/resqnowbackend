import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTrackingIngestion } from './liveTrackingIngestion.js';

const NOW = new Date('2026-09-17T10:00:00.000Z');

function payload(overrides = {}) {
  return {
    version: 1,
    technicianId: '7',
    jobId: '44',
    lat: 12.9716,
    lng: 77.5946,
    speed: 8,
    heading: 90,
    accuracy: 10,
    recordedAt: '2026-09-17T09:59:30.000Z',
    sequenceId: 1001,
    ...overrides,
  };
}

function createHarness({ job = { id: 44, technician_id: 7, status: 'en-route' }, previous = null, sampleResults = [true] } = {}) {
  const calls = [];
  const accepted = [];
  const published = [];
  let current = previous;
  const pool = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM service_requests')) {
        const matchesRequest = String(job?.id) === String(values[0]);
        const matchesTechnician = String(job?.technician_id) === String(values[1]);
        return [matchesRequest && matchesTechnician ? [job] : [], []];
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  const store = {
    async getForTechnician() {
      return current;
    },
    async putIfNewer(location) {
      current = location;
      accepted.push(location);
      return { accepted: true, code: null, location };
    },
    async claimHistorySample() {
      return sampleResults.shift() ?? false;
    },
    async getForRequest(technicianId, requestId) {
      return current && String(current.technicianId) === String(technicianId) && String(current.requestId) === String(requestId)
        ? current
        : null;
    },
  };
  const ingestion = createLiveTrackingIngestion({
    getPool: async () => pool,
    store,
    now: () => NOW,
    publish: (location) => published.push(location),
  });
  return { ingestion, calls, accepted, published };
}

test('accepts an assigned technician location and publishes the server canonical payload', async () => {
  const { ingestion, accepted, published } = createHarness();
  const result = await ingestion.ingest({
    identity: { id: '7', role: 'technician' },
    payload: payload({ technicianId: 'forged-client-id' }),
    source: 'socket',
  });

  assert.equal(result.ok, true);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].technicianId, '7');
  assert.equal(accepted[0].requestId, '44');
  assert.equal(published.length, 1);
  assert.equal(published[0].receivedAt, NOW.toISOString());
});

test('rejects a technician whose active request belongs to somebody else', async () => {
  const { ingestion, accepted } = createHarness({ job: { id: 44, technician_id: 8, status: 'en-route' } });
  const result = await ingestion.ingest({ identity: { id: '7', role: 'technician' }, payload: payload(), source: 'socket' });

  assert.deepEqual(result, { ok: false, code: 'NO_ACTIVE_JOB' });
  assert.equal(accepted.length, 0);
});

test('rejects a completed job before writing current tracking state', async () => {
  const { ingestion, accepted } = createHarness({ job: { id: 44, technician_id: 7, status: 'service_completed' } });
  const result = await ingestion.ingest({ identity: { id: '7', role: 'technician' }, payload: payload(), source: 'rest' });

  assert.deepEqual(result, { ok: false, code: 'NO_ACTIVE_JOB' });
  assert.equal(accepted.length, 0);
});

test('rejects implausible movement before changing current tracking state', async () => {
  const previous = {
    ...payload(),
    technicianId: '7',
    requestId: '44',
    recordedAtMs: Date.parse('2026-09-17T09:59:29.000Z'),
    receivedAt: '2026-09-17T09:59:29.100Z',
  };
  const { ingestion, accepted } = createHarness({ previous });
  const result = await ingestion.ingest({
    identity: { id: '7', role: 'technician' },
    payload: payload({ lat: 13.9716, recordedAt: '2026-09-17T09:59:30.000Z', sequenceId: 1002 }),
    source: 'socket',
  });

  assert.deepEqual(result, { ok: false, code: 'IMPLAUSIBLE_MOVEMENT' });
  assert.equal(accepted.length, 0);
});

test('samples MySQL history only when the store grants the sample claim', async () => {
  const { ingestion, calls } = createHarness({ sampleResults: [true, false] });
  await ingestion.ingest({ identity: { id: '7', role: 'technician' }, payload: payload(), source: 'socket' });
  await ingestion.ingest({
    identity: { id: '7', role: 'technician' },
    payload: payload({ sequenceId: 1002, recordedAt: '2026-09-17T09:59:31.000Z', lat: 12.97161 }),
    source: 'socket',
  });

  assert.equal(calls.filter(({ sql }) => sql.includes('INSERT INTO technician_location_history')).length, 1);
});
