import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../services/appAnalyticsService.js');
test('retention has a separate enable switch and never overlaps itself',async()=>{
 assert.equal(typeof m.startAppAnalyticsMaintenance,'function');let enabled=false,calls=0;
 const maintenance=m.startAppAnalyticsMaintenance({enabled:()=>enabled,service:{purge:async()=>{calls++;}}});
 try{await maintenance.runNow();assert.equal(calls,0);enabled=true;await Promise.all([maintenance.runNow(),maintenance.runNow()]);assert.equal(calls,1);}finally{maintenance.stop();}
});
