import assert from 'node:assert/strict';
import test from 'node:test';

import { handleLiveTrackingRecovery } from '../routes/technicians.js';

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

test('REST location recovery delegates to canonical ingestion and publication', async () => {
  const ingested = [];
  const published = [];
  const heartbeats = [];
  const response = createResponse();
  const acceptedLocation = {
    technicianId: 'tech-1',
    requestId: 'job-1',
    lat: 12.9716,
    lng: 77.5946,
    sequenceId: 42,
  };

  await handleLiveTrackingRecovery(
    {
      technicianId: 'tech-1',
      body: {
        jobId: 'job-1',
        latitude: 12.9716,
        longitude: 77.5946,
        speed: 8,
        heading: 90,
        accuracy: 6,
        recordedAt: '2026-09-17T10:00:00.000Z',
        sequenceId: 42,
      },
      get: () => 'web',
    },
    response,
    {
      getRuntime: () => ({
        ingestion: {
          ingest: async (input) => {
            ingested.push(input);
            return { ok: true, location: acceptedLocation };
          },
        },
      }),
      publishAcceptedTracking: async (result) => published.push(result),
      markHeartbeat: async (input) => heartbeats.push(input),
    },
  );

  assert.equal(ingested.length, 1);
  assert.deepEqual(ingested[0], {
    identity: { id: 'tech-1', role: 'technician' },
    payload: {
      version: 1,
      technicianId: 'tech-1',
      jobId: 'job-1',
      lat: 12.9716,
      lng: 77.5946,
      speed: 8,
      heading: 90,
      accuracy: 6,
      recordedAt: '2026-09-17T10:00:00.000Z',
      sequenceId: 42,
    },
    source: 'rest',
  });
  assert.deepEqual(published, [{ ok: true, location: acceptedLocation }]);
  assert.equal(heartbeats.length, 1);
  assert.deepEqual(response.body, { success: true, location: acceptedLocation });
});

test('REST recovery returns canonical rejection codes instead of persisting directly', async () => {
  const response = createResponse();
  let published = false;

  await handleLiveTrackingRecovery(
    {
      technicianId: 'tech-1',
      body: { jobId: 'job-1', latitude: 12.9716, longitude: 77.5946 },
      get: () => 'web',
    },
    response,
    {
      getRuntime: () => ({
        ingestion: { ingest: async () => ({ ok: false, code: 'STALE_LOCATION' }) },
      }),
      publishAcceptedTracking: async () => { published = true; },
    },
  );

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'Location update rejected.', code: 'STALE_LOCATION' });
  assert.equal(published, false);
});
