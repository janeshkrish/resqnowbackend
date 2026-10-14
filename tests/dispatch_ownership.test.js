import assert from 'node:assert/strict';
import test from 'node:test';
import { markTechnicianReserved, releaseTechnicianAvailability } from '../services/technicianStateService.js';
import { jobDispatchService } from '../services/jobDispatchService.js';
import * as technicianState from '../services/technicianStateService.js';
import { assignRequest } from '../controllers/requestController.js';
import { handleTechnicianStatusUpdate } from '../routes/service_requests.js';

// A stateful database boundary double: production SQL drives the visible reservation.
// This exercises guards and transaction ordering, not MySQL's lock implementation.
function database({ pointer = null, available = 1, active = 1, status = 'approved', jobs = [] } = {}) {
  const technician = { id: 7, status, is_active: active, is_available: available, current_job_id: pointer };
  let tail = Promise.resolve();
  const connection = () => {
    let unlock;
    let before;
    const conn = {
      beginTransaction: async () => {},
      commit: async () => { unlock?.(); unlock = null; },
      rollback: async () => { if (before) Object.assign(technician, before); unlock?.(); unlock = null; },
      release: () => {},
      query: async (sql, params = []) => {
        if (/SELECT .*FROM technicians/s.test(sql)) {
          if (/FOR UPDATE/.test(sql) && !unlock) {
            const previous = tail;
            tail = new Promise(resolve => { unlock = resolve; });
            await previous;
            before = { ...technician };
          }
          return [[{ ...technician }]];
        }
        if (/SELECT .*FROM service_requests/s.test(sql)) {
          return [jobs.filter(job => Number(job.technician_id) === Number(params[0]) &&
            Number(job.id) !== Number(params[1]) && ['accepted', 'assigned', 'payment_pending', 'enroute_drop'].includes(job.status))];
        }
        if (/UPDATE technicians/.test(sql) && /current_job_id = \?/.test(sql) && /SET is_available/.test(sql)) {
          if (/current_job_id IS NULL/.test(sql) && technician.current_job_id != null && Number(technician.current_job_id) !== Number(params[0])) return [{ affectedRows: 0 }];
          technician.current_job_id = Number(params[0]); technician.is_available = 0;
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE technicians SET current_job_id = NULL/.test(sql)) {
          if (Number(technician.current_job_id) === Number(params[1])) technician.current_job_id = null;
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE technicians/.test(sql)) {
          technician.is_available = technician.is_active && technician.current_job_id == null &&
            (!/approved/.test(sql) || technician.status === 'approved') ? 1 : 0;
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    return conn;
  };
  return { technician, connection };
}

test('cannot replace another active job pointer', async () => {
  const db = database({ pointer: 101, available: 0 });
  await assert.rejects(markTechnicianReserved(db.connection(), 7, 102), { code: 'technician_busy' });
  assert.equal(db.technician.current_job_id, 101);
});

test('an active request blocks a new reservation even when the pointer is missing', async () => {
  const db = database({ jobs: [{ id: 101, technician_id: 7, status: 'payment_pending' }] });
  await assert.rejects(markTechnicianReserved(db.connection(), 7, 102), { code: 'technician_busy' });
  assert.equal(db.technician.current_job_id, null);
});

test('allows reserving the already assigned job while the technician is unavailable', async () => {
  const db = database({ pointer: 101, available: 0 });
  const conn = db.connection();
  assert.equal(await markTechnicianReserved(conn, 7, 101), true);
  await conn.commit();
  assert.equal(db.technician.current_job_id, 101);
});

test('inactive technicians cannot acquire a new job', async () => {
  const db = database({ active: 0 });
  await assert.rejects(markTechnicianReserved(db.connection(), 7, 101), { code: 'technician_unavailable' });
  assert.equal(db.technician.current_job_id, null);
});

test('two competing reservations cannot both claim the same technician', async () => {
  const db = database();
  const reserve = async id => {
    const conn = db.connection();
    await conn.beginTransaction();
    try { await markTechnicianReserved(conn, 7, id); await conn.commit(); return id; }
    catch (error) { await conn.rollback(); throw error; }
  };
  const results = await Promise.allSettled([reserve(101), reserve(102)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'technician_busy');
  assert.equal(db.technician.current_job_id, 101);
});

test('a stale release cannot clear a newer job reservation', async () => {
  const db = database({ pointer: 102, available: 0 });
  await releaseTechnicianAvailability(db.connection(), 7, 101);
  assert.equal(db.technician.current_job_id, 102);
  assert.equal(db.technician.is_available, 0);
});

test('release does not advertise an unapproved technician as available', async () => {
  const db = database({ pointer: 101, available: 0, status: 'rejected' });
  await releaseTechnicianAvailability(db.connection(), 7, 101);
  assert.equal(db.technician.is_available, 0);
});

function acceptanceDatabase({ pointer = null, owner = null, status = 'pending', offerStatus = 'pending', expired = false, jobOverrides = {}, fleets = [] } = {}) {
  const db = database({ pointer, available: pointer ? 0 : 1 });
  const job = { id: 101, user_id: 41, technician_id: owner, status, amount: 300, service_type: 'car-flat-tire', ...jobOverrides };
  const offer = offerStatus ? { id: 1, technician_id: 7, status: offerStatus, expired: expired ? 1 : 0 } : null;
  const notifications = [];
  let commits = 0;
  const pool = {
    query: async () => [[]],
    getConnection: async () => {
      const conn = db.connection();
      const originalQuery = conn.query;
      const originalCommit = conn.commit;
      conn.commit = async () => { commits++; await originalCommit(); };
      conn.query = async (sql, params = []) => {
        if (/FROM technician_fleet_vehicles/.test(sql)) return [fleets];
        if (/SELECT \* FROM service_requests/.test(sql)) return [[{ ...job }]];
        if (/SELECT .*FROM dispatch_offers/s.test(sql)) return [offer ? [{ ...offer }] : []];
        if (/UPDATE dispatch_offers/.test(sql)) {
          if (/status = 'expired'/.test(sql) && (!offer || offer.status !== 'pending' || !offer.expired)) return [{ affectedRows: 0 }];
          if (offer) offer.status = /SET status = 'accepted'/.test(sql) ? 'accepted' : /SET status = 'expired'/.test(sql) ? 'expired' : offer.status;
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE service_requests/.test(sql)) {
          if (/AND status = 'pending'/.test(sql) && job.status !== 'pending') return [{ affectedRows: 0 }];
          Object.assign(job, { technician_id: 7, status: 'accepted' });
          return [{ affectedRows: 1 }];
        }
        return originalQuery(sql, params);
      };
      return conn;
    },
  };
  const sockets = {
    io: { emit: (...args) => notifications.push(args), to: () => ({ emit: (...args) => notifications.push(args) }) },
    notifyTechnician: (...args) => notifications.push(args),
    notifyUser: (...args) => notifications.push(args),
  };
  return { ...db, job, offer, pool, notifications, fleets, committed: () => commits,
    accept: () => jobDispatchService.acceptJob(7, 101, { pool, sockets, estimateEarning: async () => ({ amount: 300 }) }) };
}

test('acceptance returns a busy conflict without assigning a second request', async () => {
  const db = acceptanceDatabase({ pointer: 102 });
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'technician_busy');
  assert.equal(db.job.status, 'pending');
  assert.equal(db.committed(), 0);
});

test('towing acceptance rejects an old offer when the required equipment is missing', async () => {
  const db = acceptanceDatabase({ jobOverrides: { service_type: 'car-towing', vehicle_type: 'car', tow_truck_type: 'flatbed' }, fleets: [{ vehicle_type: 'wheel-lift', status: 'available' }] });
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'tow_truck_mismatch');
  assert.equal(db.job.status, 'pending');
  assert.equal(db.job.technician_id, null);
  assert.equal(db.technician.current_job_id, null);
  assert.equal(db.offer.status, 'pending');
  assert.equal(db.notifications.length, 0);
});

test('towing acceptance succeeds with the required available truck and recovers a lost response', async () => {
  const db = acceptanceDatabase({ jobOverrides: { service_type: 'car-towing', vehicle_type: 'car', tow_truck_type: 'flatbed' }, fleets: [{ vehicle_type: 'flatbed', status: 'available' }] });
  assert.equal((await db.accept()).success, true);
  db.fleets[0].status = 'busy';
  const retry = await db.accept();
  assert.equal(retry.success, true);
  assert.equal(retry.idempotent, true);
  assert.equal(db.technician.current_job_id, 101);
});

test('manual acceptance cannot bypass towing equipment checks by skipping offer verification', async () => {
  const db = acceptanceDatabase({ offerStatus: null, jobOverrides: { service_type: 'commercial-towing', vehicle_type: 'commercial', tow_truck_type: 'heavy-duty-wrecker' }, fleets: [{ vehicle_type: 'flatbed', status: 'available' }] });
  const result = await jobDispatchService.acceptJob(7, 101, { pool: db.pool, sockets: { io: null }, requireOffer: false, estimateEarning: async () => ({ amount: 300 }) });
  assert.equal(result.code, 'tow_truck_mismatch');
  assert.equal(db.job.technician_id, null);
});

test('a committed acceptance retry returns the existing job without new notifications', async () => {
  const db = acceptanceDatabase();
  const first = await db.accept();
  assert.equal(first.success, true);
  const notificationCount = db.notifications.length;
  const second = await db.accept();
  assert.equal(second.success, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.job.id, 101);
  assert.equal(db.notifications.length, notificationCount);
  assert.equal(db.technician.current_job_id, 101);
});

test('expired acceptance cannot be replayed after the phone reconnects', async () => {
  const db = acceptanceDatabase({ expired: true });
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_expired');
  assert.equal(db.job.status, 'pending');
});

test('a technician without an offer cannot claim an arbitrary pending request', async () => {
  const db = acceptanceDatabase({ offerStatus: null });
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'offer_unavailable');
});

test('another owner receives a taken conflict', async () => {
  const db = acceptanceDatabase({ owner: 9, status: 'accepted' });
  const result = await db.accept();
  assert.equal(result.success, false);
  assert.equal(result.code, 'job_taken');
  assert.equal(db.job.technician_id, 9);
});

test('reconciliation recovers ownership when the acceptance response was lost', async () => {
  const db = acceptanceDatabase();
  await db.accept();
  const result = await jobDispatchService.getAcceptanceOutcome(7, 101, { pool: db.pool });
  assert.equal(result.state, 'accepted');
  assert.equal(result.job.id, 101);
  assert.equal(result.job.technician_id, 7);
});

test('reconciliation never gives another technician the accepted job payload', async () => {
  const db = acceptanceDatabase({ owner: 9, status: 'accepted' });
  const result = await jobDispatchService.getAcceptanceOutcome(7, 101, { pool: db.pool });
  assert.equal(result.state, 'taken');
  assert.equal(result.job, undefined);
});

test('reconciliation requires an offer or ownership', async () => {
  const db = acceptanceDatabase({ offerStatus: null });
  const result = await jobDispatchService.getAcceptanceOutcome(7, 101, { pool: db.pool });
  assert.equal(result.code, 'not_found');
  assert.equal(result.job, undefined);
});

test('an old timeout cannot expire the winning acceptance', async () => {
  const db = acceptanceDatabase({ pointer: 101, owner: 7, status: 'accepted', offerStatus: 'accepted', expired: true });
  const result = await jobDispatchService.expirePendingOffer(101, 7, { pool: db.pool });
  assert.equal(result.expired, false);
  assert.equal(db.offer.status, 'accepted');
  assert.equal(db.job.technician_id, 7);
});

test('a timeout expires only an elapsed pending offer', async () => {
  const db = acceptanceDatabase({ expired: true });
  const result = await jobDispatchService.expirePendingOffer(101, 7, { pool: db.pool });
  assert.equal(result.expired, true);
  assert.equal(db.offer.status, 'expired');
});

test('a direct booking rolls back its new request when technician capacity was taken', async () => {
  const db = database({ pointer: 102, available: 0 });
  let createdRequest = null;
  const conn = db.connection();
  const rollback = conn.rollback;
  conn.execute = async () => { createdRequest = { id: 101, status: 'assigned', technician_id: 7 }; return [{ insertId: 101 }]; };
  conn.rollback = async () => { createdRequest = null; await rollback(); };
  await assert.rejects(technicianState.createRequestWithReservation({ getConnection: async () => conn }, 'INSERT INTO service_requests ...', [], 7), { code: 'technician_busy' });
  assert.equal(createdRequest, null);
  assert.equal(db.technician.current_job_id, 102);
});

test('direct bookings serialize on the technician before inserting an active request', async () => {
  const db = database();
  const conn = db.connection();
  const query = conn.query;
  let locked = false;
  conn.query = async (sql, values) => {
    const result = await query(sql, values);
    if (/FROM technicians/.test(sql) && /FOR UPDATE/.test(sql)) locked = true;
    return result;
  };
  conn.execute = async () => {
    assert.equal(locked, true, 'inserting before the capacity lock can deadlock competing direct bookings');
    return [{ insertId: 101 }];
  };
  await technicianState.createRequestWithReservation({ getConnection: async () => conn }, 'INSERT INTO service_requests ...', [], 7);
  assert.equal(db.technician.current_job_id, 101);
});

function responseRecorder() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test('an old technician status callback cannot resurrect a cancelled assignment', async () => {
  const res = responseRecorder();
  const updates = [];
  let rolledBack = false;
  const conn = {
    beginTransaction: async () => {}, commit: async () => {}, release: () => {},
    rollback: async () => { rolledBack = true; },
    query: async (sql) => { assert.match(sql, /FOR UPDATE/); return [[]]; },
    execute: async (...args) => { updates.push(args); },
  };
  await handleTechnicianStatusUpdate({ technicianId: 7, params: { id: 101 }, body: { status: 'en-route' } }, res, { getPool: async () => ({ getConnection: async () => conn }) });
  assert.equal(res.statusCode, 404);
  assert.equal(updates.length, 0);
  assert.equal(rolledBack, true);
});

test('late rejections cannot reopen a departed, payment-pending or completed job', async () => {
  for (const status of ['en-route', 'payment_pending', 'completed']) {
    const res = responseRecorder();
    const updates = [];
    const conn = {
      beginTransaction: async () => {}, commit: async () => {}, release: () => {}, rollback: async () => {},
      query: async sql => {
        if (/SELECT \* FROM service_requests/.test(sql)) return [[{ id: 101, technician_id: 7, status, service_type: 'battery', user_id: 41 }]];
        throw new Error('An invalid late rejection must stop before dispatching again');
      },
      execute: async (...args) => { updates.push(args); },
    };
    await handleTechnicianStatusUpdate({ technicianId: 7, params: { id: 101 }, body: { status: 'rejected' } }, res, { getPool: async () => ({ getConnection: async () => conn }) });
    assert.equal(res.statusCode, 409, status);
    assert.equal(updates.length, 0);
  }
});

test('admin assignment cannot override technician capacity', async () => {
  const db = database({ pointer: 102, available: 0 });
  const row = { id: 101, technician_id: null, status: 'pending' };
  const conn = db.connection();
  const query = conn.query;
  conn.query = async (sql, params) => /SELECT \* FROM service_requests/.test(sql) ? [[{ ...row }]] : query(sql, params);
  const pool = { query: async sql => /FROM technicians/.test(sql) ? [[{ ...db.technician }]] : [[{ ...row }]], getConnection: async () => conn };
  const res = responseRecorder();
  await assignRequest({ params: { requestId: 101 }, body: { technicianId: 7 } }, res, { getPool: async () => pool });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'technician_busy');
  assert.equal(db.technician.current_job_id, 102);
});
