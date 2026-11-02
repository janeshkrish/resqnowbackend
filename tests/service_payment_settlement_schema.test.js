import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as bootstrap from '../models/bootstrap.js';

function fixture({ column = false, index = false, denyColumn = false, denyIndex = false } = {}) {
  const state = { column, index, writes: 0 };
  return { state, query: async (sql, args) => {
    if (/information_schema.columns/.test(sql)) return [state.column ? [{ column_name: 'settlement_key', data_type: 'varchar', character_maximum_length: 80, is_nullable: 'YES' }] : []];
    if (/information_schema.statistics/.test(sql)) return [state.index ? [{ column_name: 'settlement_key', non_unique: state.index === 'nonunique' ? 1 : 0, seq_in_index: 1 }] : []];
    if (/ADD COLUMN settlement_key/.test(sql)) { if (denyColumn) throw new Error('DDL denied'); state.column = true; state.writes++; return [{}]; }
    if (/CREATE UNIQUE INDEX uq_payments_settlement_key/.test(sql)) { if (denyIndex) throw new Error('DDL denied'); state.index = true; state.writes++; return [{}]; }
    throw new Error(`Unexpected schema SQL: ${sql}`);
  } };
}
const ensure = async pool => {
  assert.equal(typeof bootstrap.ensureServicePaymentSettlementSchema, 'function', 'bootstrap enforcement is missing');
  return bootstrap.ensureServicePaymentSettlementSchema(pool);
};
test('settlement bootstrap adds nullable identity and unique index, then becomes a no-op', async () => {
  const pool = fixture(); await ensure(pool); assert.equal(pool.state.column,true); assert.equal(pool.state.index,true);
  const writes = pool.state.writes; await ensure(pool); assert.equal(pool.state.writes,writes);
});
test('settlement bootstrap refuses an unavailable required column', async () => { await assert.rejects(ensure(fixture({ denyColumn: true })), /settlement|DDL/i); });
test('settlement bootstrap refuses a nonunique lookalike index', async () => { await assert.rejects(ensure(fixture({ column: true, index: 'nonunique' })), /settlement|unique/i); });
test('settlement bootstrap refuses a failed required unique index', async () => { await assert.rejects(ensure(fixture({ column: true, denyIndex: true })), /settlement|DDL/i); });
