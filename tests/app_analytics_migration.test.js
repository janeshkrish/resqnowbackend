import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../models/migrations/appAnalyticsMigration.js').catch(()=>({}));
test('plan is additive and cannot perform a full cutover or business writes',async()=>{
 assert.equal(typeof module.migrateAppAnalytics,'function');const seen=[];
 const result=await module.migrateAppAnalytics({pool:{query:async sql=>{seen.push(sql);return [[],[]];}},mode:'plan'});
 assert.equal(seen.length,0);assert.equal(result.statements.length,4);
 assert.ok(result.statements.every(sql=>/^CREATE TABLE IF NOT EXISTS android_/i.test(sql)));
});
