import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import jwt from 'jsonwebtoken';import {randomUUID} from 'node:crypto';
const m=await import('../routes/appAnalytics.js').catch(()=>({}));
process.env.JWT_SECRET='synthetic-analytics-test-signing-key-not-production';
test('analytics HTTP router is available',()=>assert.equal(typeof m.createAppAnalyticsRouter,'function'));
test('production defaults limit each installation to six reports per minute',async()=>{
 const store={registerInstallation:async()=>({created:true}),touchInstallation:async()=>{}};const app=express();app.use(m.createAppAnalyticsRouter({store,enabled:()=>true}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};
 try{for(let i=0;i<7;i++){const response=await fetch(`http://127.0.0.1:${server.address().port}/installations/heartbeat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});assert.equal(response.status,i<6?200:429);}}finally{await new Promise(r=>server.close(r));}
});
test('production defaults limit new registration to thirty per IP without blocking existing heartbeats',async()=>{
 const store={registerInstallation:async()=>({created:true}),touchInstallation:async()=>{}};const app=express();app.use(m.createAppAnalyticsRouter({store,enabled:()=>true}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};const send=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{for(let i=0;i<31;i++){const r=await send('/installations/register',{...report,installationId:randomUUID()});assert.equal(r.status,i<30?201:429);}assert.equal((await send('/installations/heartbeat',report)).status,200);}finally{await new Promise(r=>server.close(r));}
});
test('real guards, strict bodies, disabled collection and withdrawal privacy behavior',async()=>{
 assert.equal(typeof m.createAppAnalyticsRouter,'function');
 let calls=0,on=true;const store={registerInstallation:async()=>{calls++;return {created:true};},touchInstallation:async()=>{},linkInstallationAccount:async()=>{calls++;},withdrawInstallation:async()=>{calls++;}};
 const app=express();app.use('/api/app-analytics',m.createAppAnalyticsRouter({store,enabled:()=>on}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/app-analytics`;
 const report={installationId:randomUUID(),installationSecret:'a'.repeat(64),consentRevision:1,consentPolicyVersion:'2026-10-27',appId:'com.resqnow1.app',versionName:'1.3',versionCode:4};
 const post=(path,body,token)=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
 const token=role=>jwt.sign({id:randomUUID(),role},process.env.JWT_SECRET);
 try{
  assert.equal((await post('/installations/register',report)).status,201);
  assert.equal((await post('/installations/register',{...report,role:'admin'})).status,400);
  assert.equal((await post('/installations/register',{...report,installationId:'bad'})).status,400);
  assert.equal((await post('/installations/register',{...report,junk:'x'.repeat(2100)})).status,413);
  const link={installationId:report.installationId,installationSecret:report.installationSecret,consentRevision:1};
  assert.equal((await post('/accounts/customer/link',link)).status,401);
  assert.equal((await post('/accounts/customer/link',link,token('admin'))).status,403);
  assert.equal((await post('/accounts/customer/link',link,token('technician'))).status,403);
  assert.equal((await post('/accounts/customer/link',link,token('user'))).status,200);
  assert.equal((await post('/accounts/technician/link',link,token('technician'))).status,200);
  const before=calls;on=false;assert.equal((await post('/installations/register',report)).status,204);assert.equal(calls,before);
  assert.equal((await post('/installations/withdraw',{...link,consentRevision:2})).status,200);assert.equal(calls,before+1);
 }finally{await new Promise(r=>server.close(r));}
});
