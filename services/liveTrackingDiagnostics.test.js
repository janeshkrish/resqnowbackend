import assert from 'node:assert/strict';
import test from 'node:test';

import { logLiveTrackingDiagnostic } from './liveTrackingDiagnostics.js';

test('logs live-tracking diagnostics only when explicitly enabled', () => {
  const entries = [];
  const logger = (...args) => entries.push(args);

  logLiveTrackingDiagnostic('[RT-BACKEND-IN]', 'location_received', { role: 'technician', socketId: 'socket-1' }, {
    environment: {},
    logger,
  });
  assert.equal(entries.length, 0);

  logLiveTrackingDiagnostic('[RT-BACKEND-IN]', 'location_received', { role: 'technician', socketId: 'socket-1' }, {
    environment: { LIVE_TRACKING_DIAGNOSTICS: 'true' },
    logger,
  });
  assert.deepEqual(entries, [[
    '[RT-BACKEND-IN]',
    { event: 'location_received', role: 'technician', socketId: 'socket-1' },
  ]]);
});
