import { TABLES } from './schema/index.js';

export async function ensurePasswordRecoverySchema(pool) {
  for (const table of ['users', 'technicians']) {
    for (const [column, definition] of Object.entries({
      auth_version: 'INT UNSIGNED NOT NULL DEFAULT 0',
      recovery_email: 'VARCHAR(255) NULL',
      recovery_email_verified_at: 'DATETIME(3) NULL',
    })) {
      const [rows] = await pool.query('SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
      if (!rows.length) {
        try { await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
        catch (failure) { if (failure.code !== 'ER_DUP_FIELDNAME') throw failure; }
      }
    }
  }
  await pool.execute(TABLES.password_recovery_tokens);
  await pool.execute(TABLES.recovery_rate_limits);
  // Fail closed on incompatible partial deployments. Do not silently accept a
  // nullable/default-less version or a truncated/nonunique challenge hash.
  for (const table of ['users', 'technicians', 'password_recovery_tokens', 'recovery_rate_limits']) {
    const [columns] = await pool.query('SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', [table]);
    const byName = Object.fromEntries(columns.map(c => [c.COLUMN_NAME, c]));
    const required = table === 'password_recovery_tokens'
      ? ['id','account_id','account_role','purpose','token_hash','email','auth_version','expires_at','consumed_at','created_at']
      : table === 'recovery_rate_limits' ? ['id','bucket_key','request_count','window_started_at','last_request_at']
      : ['auth_version','recovery_email','recovery_email_verified_at'];
    if (required.some(column => !byName[column])) throw new Error(`Incompatible password recovery schema: ${table} has missing columns.`);
    const expected = table === 'password_recovery_tokens' ? {
      id:'char(36)',account_id:'char(36)',account_role:"enum('user','technician')",purpose:"enum('password_reset','verify_email')",
      email:'varchar(255)',expires_at:'datetime(3)',consumed_at:'datetime(3)',created_at:'datetime(3)',
    } : table === 'recovery_rate_limits' ? {id:'char(36)',request_count:'int unsigned',window_started_at:'datetime(3)',last_request_at:'datetime(3)'}
      : {recovery_email:'varchar(255)',recovery_email_verified_at:'datetime(3)'};
    for (const [column, type] of Object.entries(expected)) {
      const actual=String(byName[column]?.COLUMN_TYPE || '').toLowerCase().replace(/int\(\d+\)/,'int').replace(/\s+/g,'');
      if(actual!==type.replace(/\s+/g,'')) throw new Error(`Incompatible password recovery schema: ${table}.${column} type.`);
    }
    if (byName.auth_version && (!/^int(?:\(\d+\))? unsigned$/i.test(byName.auth_version.COLUMN_TYPE) || byName.auth_version.IS_NULLABLE !== 'NO')) throw new Error(`Incompatible password recovery schema: ${table}.auth_version.`);
    const hashColumn = table === 'password_recovery_tokens' ? 'token_hash' : table === 'recovery_rate_limits' ? 'bucket_key' : null;
    if (hashColumn) {
      const c = byName[hashColumn];
      const [indexes] = await pool.query('SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?', [table]);
      const uniqueSingle = indexes.some(i => i.COLUMN_NAME === hashColumn && Number(i.NON_UNIQUE) === 0 && indexes.filter(j => j.INDEX_NAME === i.INDEX_NAME).length === 1);
      if (c.COLUMN_TYPE !== 'char(64)' || c.COLLATION_NAME !== 'ascii_bin' || c.IS_NULLABLE !== 'NO' || !uniqueSingle) throw new Error(`Incompatible password recovery schema: ${table}.${hashColumn}.`);
    } else if (String(byName.auth_version.COLUMN_DEFAULT) !== '0') throw new Error(`Incompatible password recovery schema: ${table}.auth_version default.`);
  }
}
