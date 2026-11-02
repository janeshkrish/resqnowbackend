import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createPasswordRecoveryRouter } from '../routes/passwordRecovery.js';
import { mountCredentialSessions } from '../middleware/credentialSessions.js';
const USER='11111111-1111-4111-8111-111111111111', TECH='22222222-2222-4222-8222-222222222222';
process.env.JWT_SECRET='synthetic-recovery-router-secret';

test('real HTTP recovery routes enforce actor role, neutral accepted requests, no-store and controlled errors',async t=>{
  const calls=[];
  const service=Object.fromEntries(['request','confirm','verificationRequest','verifyEmail','status'].map(method=>[method,async args=>{
    calls.push({method,...args});if(args.token==='expired')throw Object.assign(Error('Link expired'),{statusCode:400});
    return method==='status'?{verified:false,hasPassword:true,email:'owner@example.test'}:{message:method==='request'?'Check your email.':'Done.'};
  }]));
  const app=express();app.use(express.json());mountCredentialSessions(app,{validateSession:async identity=>{
    if(identity.sessionVersion!==1)throw Object.assign(Error('revoked'),{statusCode:401});
  }});app.use('/api/password-recovery',createPasswordRecoveryRouter({service,responseFloorMs:0}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const call=(role,path,{body,actor,sv=1}={})=>fetch(`http://127.0.0.1:${server.address().port}/api/password-recovery/${role}/${path}`,{
    method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(actor?{Authorization:`Bearer ${jwt.sign({id:actor==='technician'?TECH:USER,role:actor,sv},process.env.JWT_SECRET)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  for(const role of ['user','technician']) {
    const request=await call(role,'request',{body:{email:'unknown@example.test'}});assert.equal(request.status,202);assert.equal(request.headers.get('cache-control'),'no-store');
    assert.equal((await call(role,'verification/request',{body:{currentPassword:'private'}})).status,401);
    const status=await call(role,'status',{actor:role});assert.equal(status.status,200);
    assert.equal((await call(role,'verification/request',{actor:role,body:{currentPassword:'private'}})).status,202);
    const last=calls.at(-1);assert.equal(last.accountId,role==='user'?USER:TECH);assert.equal(last.role,role);
    assert.equal((await call(role,'status',{actor:role,sv:0})).status,401);
    assert.equal((await call(role,'confirm',{body:{token:'expired',password:'new-password!'}})).status,400);
  }
  assert.equal((await call('user','status',{actor:'technician'})).status,403);
  assert.equal((await call('technician','status',{actor:'user'})).status,403);
  assert.equal((await call('admin','request',{body:{email:'owner@example.test'}})).status,400);
});
