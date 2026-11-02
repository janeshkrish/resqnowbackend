import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as bootstrap from '../models/bootstrap.js';

function fixture({ exists = false, type = 'json', denied = false } = {}) {
  const state = { exists, writes: 0 };
  return { state, query: async sql => {
    if (/information_schema.columns/.test(sql)) return [state.exists ? [{ data_type: type, is_nullable: 'YES' }] : []];
    if (/ADD COLUMN cash_payment_intent/.test(sql)) { if (denied) throw new Error('DDL denied'); state.exists = true; state.writes++; return [{}]; }
    throw new Error(`Unexpected schema SQL: ${sql}`);
  } };
}
async function ensure(pool) {
  assert.equal(typeof bootstrap.ensureCashPaymentIntentSchema,'function','bootstrap cash guard is missing');
  return bootstrap.ensureCashPaymentIntentSchema(pool);
}
test('cash intent schema bootstrap adds nullable JSON and is idempotent', async () => {
  const pool = fixture(); await ensure(pool); await ensure(pool);
  assert.equal(pool.state.exists,true); assert.equal(pool.state.writes,1);
});
test('cash intent schema refuses denied DDL', async () => { await assert.rejects(ensure(fixture({ denied: true })),/cash_payment_intent|DDL denied/); });
test('cash intent schema refuses incompatible legacy column', async () => { await assert.rejects(ensure(fixture({ exists: true, type: 'text' })),/cash_payment_intent/); });
