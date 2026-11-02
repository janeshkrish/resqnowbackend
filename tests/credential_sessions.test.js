import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createCredentialSessionValidator } from '../services/credentialSessions.js';
import { credentialSessions, mountCredentialSessions } from '../middleware/credentialSessions.js';
const ID='11111111-1111-4111-8111-111111111111';
process.env.JWT_SECRET='synthetic-recovery-tests-secret';

test('legacy and fresh JWT versions track persistent customer and technician credentials',async()=>{
  let version=0; const queries=[];
  const validate=createCredentialSessionValidator({getPool:async()=>({query:async(sql,args)=>{queries.push([sql,args]);return[[{auth_version:version}]];}})});
  for(const role of ['user','technician']) {
    version=0; await validate({id:ID,role,sessionVersion:0});
    version=1; await assert.rejects(validate({id:ID,role,sessionVersion:0}),{statusCode:401});
    await validate({id:ID,role,sessionVersion:1});
    await assert.rejects(validate({id:ID,role,sessionVersion:-1}),{statusCode:401});
  }
  assert.ok(queries.some(([sql])=>sql.includes('FROM technicians')));
  assert.ok(queries.some(([sql])=>sql.includes('FROM users')));
});

test('deleted accounts and unavailable SQL fail closed; admins stay in existing auth',async()=>{
  const missing=createCredentialSessionValidator({getPool:async()=>({query:async()=>[[]]})});
  await assert.rejects(missing({id:ID,role:'user',sessionVersion:0}),{statusCode:401});
  const broken=createCredentialSessionValidator({getPool:async()=>{throw Error('SQL offline');}});
  await assert.rejects(broken({id:ID,role:'technician',sessionVersion:0}),{statusCode:503});
  await broken({id:ID,role:'admin'});
});

test('common API and auth mounts reject old native/REST tokens and accept fresh/legacy-zero tokens',async()=>{
  const mounts=[];mountCredentialSessions({use:(...args)=>mounts.push(args)});
  assert.deepEqual(mounts.map(x=>x[0]),['/api','/auth']);
  let version=1;
  const validateSession=createCredentialSessionValidator({getPool:async()=>({query:async()=>[[{auth_version:version}]]})});
  const guard=credentialSessions({validateSession});
  const call=async(payload)=>{
    let code=200,body,next=false;
    const res={set(){return this;},status(n){code=n;return this;},json(x){body=x;return this;}};
    const req={headers:{authorization:`Bearer ${jwt.sign(payload,process.env.JWT_SECRET)}`}};
    await guard(req,res,()=>{next=true;}); return{code,body,next};
  };
  assert.equal((await call({userId:ID,role:'user'})).code,401);
  assert.equal((await call({id:ID,role:'technician',sv:0})).code,401);
  assert.equal((await call({userId:ID,role:'user',sv:1})).next,true);
  version=0;assert.equal((await call({userId:ID,role:'user'})).next,true);
});

test('whitespace in configured secret cannot bypass version validation',async()=>{
  const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='  synthetic-trimmed-secret  ';
  try {
    let checked=false,accepted=false,code;
    const guard=credentialSessions({validateSession:async()=>{checked=true;throw Object.assign(Error('revoked'),{statusCode:401});}});
    await guard({headers:{authorization:`Bearer ${jwt.sign({userId:ID,role:'user'},process.env.JWT_SECRET.trim())}`}},
      {set(){return this;},status(n){code=n;return this;},json(){return this;}},()=>{accepted=true;});
    assert.equal(checked,true);assert.equal(accepted,false);assert.equal(code,401);
  } finally {process.env.JWT_SECRET=previous;}
});

test('public sign-in endpoints accept new credentials even when clients attach a revoked session',async()=>{
  const guard=credentialSessions({validateSession:async()=>{throw Object.assign(Error('revoked'),{statusCode:401});}});
  for(const path of ['/users/login','/users/phone-login','/technicians/login','/technician/login']) {
    let accepted=false;
    await guard({method:'POST',path,headers:{authorization:`Bearer ${jwt.sign({userId:ID,role:'user',sv:0},process.env.JWT_SECRET)}`}},
      {set(){return this;},status(){return this;},json(){return this;}},()=>{accepted=true;});
    assert.equal(accepted,true,path);
  }
});
