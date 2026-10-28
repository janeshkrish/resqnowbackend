import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const store=await import('../services/appAnalyticsStore.js').catch(()=>({}));
const migration=await import('../models/migrations/appAnalyticsMigration.js').catch(()=>({}));
const enabled=process.env.APP_ANALYTICS_TEST_DB==='1';

test('real DB: account deletion locks the parent before analytics cleanup, even without gap locks',{skip:!enabled},async()=>{
 const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');const db=await createDisposableDatabase();
 try{
  await migration.migrateAppAnalytics({pool:db.pool,mode:'apply'});
  for(const kind of ['user','technician']){
   const table=kind==='user'?'users':'technicians',accountId=randomUUID();await db.pool.query(`INSERT INTO ${table} VALUES (?,?)`,[accountId,'Synthetic deletion race']);
   const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};await store.registerInstallation({pool:db.pool,report});
   const deletion=await db.pool.getConnection();let linking;
   try{
    await deletion.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await deletion.beginTransaction();
    await store.deleteInstallationAccountLinks({connection:deletion,kind,accountId});
    let settled=false;linking=store.linkInstallationAccount({pool:db.pool,installationId:report.installationId,proof:report.installationSecret,consentRevision:1,account:{kind,id:accountId}}).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(settled,false,'link must wait for the deleting parent transaction');
    await deletion.query(`DELETE FROM ${table} WHERE id=?`,[accountId]);await deletion.commit();assert.equal((await linking)?.status,403);
    const [[row]]=await db.pool.query('SELECT COUNT(*) n FROM android_app_installation_accounts WHERE account_id=?',[accountId]);assert.equal(Number(row.n),0);
   }finally{await deletion.rollback();deletion.release();if(linking)await linking;}
  }
 }finally{await db.close();}
});
test('real DB: schema check refuses a table missing its uniqueness guarantee',{skip:!enabled},async()=>{const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');const db=await createDisposableDatabase();try{await migration.migrateAppAnalytics({pool:db.pool,mode:'apply'});await db.pool.query('ALTER TABLE android_app_analytics_daily DROP INDEX uq_android_day_metric');await assert.rejects(migration.migrateAppAnalytics({pool:db.pool,mode:'check'}),/index/i);}finally{await db.close();}});
test('real DB: the production analytics pool accepts stable native UUIDs without changing business ID generation', {skip:!enabled},async()=>{
 const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');const {createAnalyticsPool}=await import('../services/appAnalyticsDatabase.js');const db=await createDisposableDatabase(),analytics=createAnalyticsPool(db.config);
 try{await migration.migrateAppAnalytics({pool:db.pool,mode:'apply'});const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};assert.equal((await store.registerInstallation({pool:analytics,report})).created,true);assert.equal((await store.registerInstallation({pool:analytics,report})).created,false);}finally{await analytics.end();await db.close();}
});
test('real DB: withdrawal before analytics schema is installed is harmless', {skip:!enabled}, async()=>{
 const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');const db=await createDisposableDatabase();
 try{await store.withdrawInstallation({pool:db.pool,installationId:randomUUID(),proof:'a'.repeat(64),consentRevision:2});const [tables]=await db.pool.query("SHOW TABLES LIKE 'android_%'");assert.equal(tables.length,0);}finally{await db.close();}
});
test('real DB: a client deadline retains its SQL slot while business queries remain available', {skip:!enabled,timeout:3000}, async()=>{
 const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');const {createAnalyticsPool}=await import('../services/appAnalyticsDatabase.js');const {createAppAnalyticsWriteQueue}=await import('../services/appAnalyticsWriteQueue.js');
 const db=await createDisposableDatabase(),analytics=createAnalyticsPool(db.config,{timeoutMs:20}),q=createAppAnalyticsWriteQueue({timeoutMs:15});
 try{
   const jobs=[q.submit(()=>analytics.query('SELECT SLEEP(0.1)')),q.submit(()=>analytics.query('SELECT SLEEP(0.1)'))];
   await Promise.all(jobs.map(p=>assert.rejects(p)));
   assert.equal(q.health().active,2);await db.pool.query('SELECT 1');
   await new Promise(r=>setTimeout(r,45));assert.equal(q.health().active,2);
   await new Promise(r=>setTimeout(r,200));assert.equal(q.health().active,0);
 }finally{await analytics.end();await db.close();}
});
test('installation store and additive migration are available',()=>{assert.equal(typeof store.registerInstallation,'function');assert.equal(typeof migration.migrateAppAnalytics,'function');});
test('Kolkata calendar period includes midnight rather than rolling 24-hour windows',()=>{assert.equal(typeof store.reportWindow,'function');assert.equal(store.reportWindow(7,Date.parse('2026-10-27T02:00:00Z')).start.toISOString(),'2026-10-20T18:30:00.000Z');});
test('real DB: races, proof/consent, account deletion, download deduplication, retention', {skip:!enabled}, async()=>{
  assert.equal(typeof store.registerInstallation,'function');
  const {createDisposableDatabase}=await import('./helpers/appAnalyticsDatabase.mjs');
  const db=await createDisposableDatabase();const pool=db.pool;
  const now=Date.parse('2026-10-27T06:00:00Z');
  const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};
  try{
    await migration.migrateAppAnalytics({pool,mode:'apply'});await migration.migrateAppAnalytics({pool,mode:'apply'});
    const replies=await Promise.all(Array.from({length:20},()=>store.registerInstallation({pool,report,now})));
    assert.equal(replies.filter(r=>r.created).length,1);
    let summary=await store.getInstallSummary({pool,days:30,now});assert.equal(summary.totals.installations,1);
    await assert.rejects(store.registerInstallation({pool,report:{...report,installationSecret:'b'.repeat(64)},now}),{status:403});
    const user=randomUUID(),tech=randomUUID();await pool.query('INSERT INTO users VALUES (?,?)',[user,'Synthetic customer']);await pool.query('INSERT INTO technicians VALUES (?,?)',[tech,'Synthetic technician']);
    const link=(installationId,kind,id)=>store.linkInstallationAccount({pool,installationId,proof:report.installationSecret,consentRevision:1,account:{kind,id},now});
    await link(report.installationId,'user',user);await link(report.installationId,'technician',tech);
    const second={...report,installationId:randomUUID()};await store.registerInstallation({pool,report:second,now});await link(second.installationId,'user',user);
    summary=await store.getInstallSummary({pool,days:30,now});assert.equal(summary.totals.installations,2);assert.equal(summary.totals.customers,1);assert.equal(summary.totals.technicians,1);
    await store.deleteInstallationAccountLinks({connection:pool,kind:'user',accountId:user});await pool.query('DELETE FROM users WHERE id=?',[user]);
    const list=await store.listInstallations({pool,days:30,role:'formerly-linked',page:1,limit:25,now});assert.equal(list.total,1);
    await store.withdrawInstallation({pool,installationId:report.installationId,proof:report.installationSecret,consentRevision:2,now});
    await assert.rejects(store.registerInstallation({pool,report,now}),{status:409});
    await store.registerInstallation({pool,report:{...report,consentRevision:3,versionCode:5,versionName:'1.4'},now});
    summary=await store.getInstallSummary({pool,days:30,now});assert.equal(summary.totals.installations,2);assert.equal(summary.totals.technicians,0);
    const downloadId=randomUUID();await Promise.all(Array.from({length:10},()=>store.recordDownloadSession({pool,downloadId,releaseKey:'fixture.apk:4',now})));
    assert.equal((await store.getInstallSummary({pool,days:30,now})).totals.downloads,1);
    await store.purgeDownloadSessions({pool,now:now+31*86400000});
    assert.equal((await store.getInstallSummary({pool,days:30,now:now+31*86400000})).totals.downloads,1);
    const [rows]=await pool.query('SELECT COUNT(*) n FROM android_apk_download_sessions');assert.equal(Number(rows[0].n),0);
    const json=JSON.stringify(summary);assert.ok(!json.includes(report.installationSecret));assert.ok(!json.includes('proof_hash'));
    // Out-of-order withdrawal before first registration must not be undone.
    const late={...report,installationId:randomUUID()};await store.withdrawInstallation({pool,installationId:late.installationId,proof:late.installationSecret,consentRevision:2,now});
    await assert.rejects(store.registerInstallation({pool,report:late,now}),{status:409});
  } finally {await db.close();}
});
