import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TrackingError,
  compareTrackingOrder,
  parseTrackingLocation,
} from './liveTrackingContract.js';

const NOW_MS = Date.parse('2026-09-17T10:00:00.000Z');

function validPayload(overrides = {}) {
  return {
    version: 1,
    technicianId: '7',
    jobId: '44',
    lat: 12.9716,
    lng: 77.5946,
    speed: 8.25,
    heading: 90,
    accuracy: 12,
    recordedAt: '2026-09-17T09:59:30.000Z',
    sequenceId: 1001,
    ...overrides,
  };
}

test('parses a complete v1 location into normalized tracking data', () => {
  const location = parseTrackingLocation(validPayload(), NOW_MS);

  assert.deepEqual(location, {
    version: 1,
    technicianId: '7',
    jobId: '44',
    lat: 12.9716,
    lng: 77.5946,
    speed: 8.25,
    heading: 90,
    accuracy: 12,
    recordedAt: '2026-09-17T09:59:30.000Z',
    recordedAtMs: Date.parse('2026-09-17T09:59:30.000Z'),
    sequenceId: 1001,
  });
});

test('rejects coordinates outside the earth coordinate range', () => {
  assert.throws(
    () => parseTrackingLocation(validPayload({ lat: 91 }), NOW_MS),
    (error) => error instanceof TrackingError && error.code === 'INVALID_LOCATION',
  );
});

test('rejects locations more than sixty seconds old', () => {
  assert.throws(
    () => parseTrackingLocation(validPayload({ recordedAt: '2026-09-17T09:58:59.999Z' }), NOW_MS),
    (error) => error instanceof TrackingError && error.code === 'STALE_LOCATION',
  );
});

test('orders an equal timestamp by sequence ID', () => {
  const first = parseTrackingLocation(validPayload({ sequenceId: 1001 }), NOW_MS);
  const next = parseTrackingLocation(validPayload({ sequenceId: 1002 }), NOW_MS);

  assert.equal(compareTrackingOrder(next, first), 1);
  assert.equal(compareTrackingOrder(first, next), -1);
  assert.equal(compareTrackingOrder(first, first), 0);
});
