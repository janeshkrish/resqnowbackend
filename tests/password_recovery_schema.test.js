import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES } from '../models/schema/index.js';
import { referenceTarget } from '../models/relationships.js';
import { ensurePasswordRecoverySchema } from '../models/recoverySchema.js';

test('canonical recovery schema has UUID actors, role/purpose/version binding, unique token hashes and durable limits', () => {
  assert.match(TABLES.password_recovery_tokens, /account_id CHAR\(36\).*ascii_bin/);
  assert.match(TABLES.password_recovery_tokens, /auth_version INT UNSIGNED NOT NULL/);
  assert.match(TABLES.password_recovery_tokens, /token_hash CHAR\(64\).*ascii_bin NOT NULL UNIQUE/);
  assert.match(TABLES.recovery_rate_limits, /bucket_key CHAR\(64\).*ascii_bin NOT NULL UNIQUE/);
  for (const table of ['users','technicians']) {
    assert.match(TABLES[table], /auth_version INT UNSIGNED NOT NULL DEFAULT 0/);
    assert.match(TABLES[table], /recovery_email_verified_at DATETIME\(3\)/);
  }
  assert.equal(referenceTarget('password_recovery_tokens','account_id',{account_role:'technician'}),'technicians');
  assert.equal(referenceTarget('password_recovery_tokens','account_id',{account_role:'user'}),'users');
});

test('schema bootstrap refuses readiness if credential columns cannot be installed', async () => {
  const pool={execute:async()=>[[]],query:async()=>[[]]};
  await assert.rejects(ensurePasswordRecoverySchema(pool), /recovery schema/i);
});

function metadataPool() {
  const columns=Object.fromEntries(['users','technicians','password_recovery_tokens','recovery_rate_limits'].map(table=>[table,
    TABLES[table].split('\n').flatMap(line=>{
      const match=line.trim().match(/^(\w+)\s+(enum\([^)]*\)|\w+(?:\(\d+\))?(?: UNSIGNED)?)/i);
      if(!match || ['CREATE','INDEX'].includes(match[1]))return[];
      return[{COLUMN_NAME:match[1],COLUMN_TYPE:match[2].toLowerCase(),IS_NULLABLE:/NOT NULL/.test(line)?'NO':'YES',COLUMN_DEFAULT:/DEFAULT 0/.test(line)?'0':null,COLLATION_NAME:/ascii_bin/.test(line)?'ascii_bin':null}];
    })]));
  const pool={execute:async()=>[[]],query:async(sql,[table,column])=>{
    if(sql.includes('information_schema.statistics'))return[[{INDEX_NAME:'hash_unique',COLUMN_NAME:table==='password_recovery_tokens'?'token_hash':'bucket_key',NON_UNIQUE:0,SEQ_IN_INDEX:1}]];
    return[column?columns[table].filter(c=>c.COLUMN_NAME===column):columns[table]];
  }};
  return {pool,columns};
}
test('readiness accepts the complete modeled schema and rejects a damaged expiry/version definition',async()=>{
  const f=metadataPool();await ensurePasswordRecoverySchema(f.pool);
  f.columns.password_recovery_tokens.find(c=>c.COLUMN_NAME==='expires_at').COLUMN_TYPE='varchar(255)';
  await assert.rejects(ensurePasswordRecoverySchema(f.pool),/expires_at type/);
  const g=metadataPool();g.columns.users.find(c=>c.COLUMN_NAME==='auth_version').IS_NULLABLE='YES';
  await assert.rejects(ensurePasswordRecoverySchema(g.pool),/users.auth_version/);
});
