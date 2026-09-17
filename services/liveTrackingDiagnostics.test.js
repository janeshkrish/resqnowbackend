import assert from 'node:assert/strict';
import test from 'node:test';

import { logLiveTrackingDiagnostic } from './liveTrackingDiagnostics.js';

test('logs live-tracking diagnostics only when explicitly enabled', () => {
  const entries = [];
  const logger = (...args) => entries.push(args);

  logLiveTrackingDiagnostic('socket_connected', { role: 'user', socketId: 'socket-1' }, {
    environment: {},
    logger,
  });
  assert.equal(entries.length, 0);

  logLiveTrackingDiagnostic('socket_connected', { role: 'user', socketId: 'socket-1' }, {
    environment: { LIVE_TRACKING_DIAGNOSTICS: 'true' },
    logger,
  });
  assert.deepEqual(entries, [[
    '[LiveTracking Diagnostics]',
    { event: 'socket_connected', role: 'user', socketId: 'socket-1' },
  ]]);
});
