import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { withUuidPersistence } from '../models/persistence.js';
import { createPasswordRecoveryService, validateRecoveryPassword, recoveryLink } from '../services/passwordRecoveryService.js';

const USER='11111111-1111-4111-8111-111111111111', TECH='22222222-2222-4222-8222-222222222222';
const EMAIL='owner@example.test', OLD='Original-Password!', NEW='New-safe-password!';
const hash=bcrypt.hashSync(OLD,4);
const clone=value=>structuredClone(value);

// Real service/crypto/bcrypt and emitted SQL, with only SQL/mail/session-delivery
// boundaries replaced. The queue verifies transaction ordering, not MySQL isolation.
function fixture({verified=true,password=true,frontend='https://app.example.test'}={}) {
  const state={now:0,accounts:[
    {id:USER,account_role:'user',role:'user',email:EMAIL,password_hash:password?hash:null,recovery_email:EMAIL,recovery_email_verified_at:verified?'verified':null,auth_version:0,status:'approved',current_job_id:'keep-user-job'},
    {id:TECH,account_role:'technician',email:EMAIL,password_hash:password?hash:null,recovery_email:EMAIL,recovery_email_verified_at:verified?'verified':null,auth_version:0,status:'approved',is_active:1,is_available:0,current_job_id:'keep-tech-job'},
  ],challenges:[],limits:{},devices:[{user_id:USER,user_type:'user'},{user_id:TECH,user_type:'technician'}],mails:[],revoked:[],failPassword:false};
  let tail=Promise.resolve();
  const connection=()=>{
    let unlock,before;
    const conn={
      beginTransaction:async()=>{const previous=tail; tail=new Promise(resolve=>{unlock=resolve;});await previous;before=clone({accounts:state.accounts,challenges:state.challenges,limits:state.limits,devices:state.devices});},
      commit:async()=>{unlock?.();unlock=null;},
      rollback:async()=>{if(before)Object.assign(state,before);unlock?.();unlock=null;},
      release:()=>{},
      query:async(sql,args=[])=>{
        if (/FROM (users|technicians)/.test(sql)) {
          const role=/FROM users/.test(sql)?'user':'technician';
          const rows=state.accounts.filter(a=>a.account_role===role && a.role!=='admin' &&
            (/LOWER\(TRIM\(email\)\)/.test(sql)?a.email?.trim().toLowerCase()===args[0]:a.id===args[0]));
          return [clone(rows)];
        }
        if (/FROM password_recovery_tokens/.test(sql)) {
          const rows=state.challenges.filter(c=>c.token_hash===args[0]&&c.account_role===args[1]&&c.purpose===args[2]);
          return [clone(rows.map(c=>({...c,unexpired:c.expires_at>state.now?1:0})))];
        }
        if (/FROM recovery_rate_limits/.test(sql)) {
          const row=state.limits[args[0]];
          return [row?[{...row,age_seconds:(state.now-row.window_started_at)/1000,
            since_last_seconds:row.last_request_at==null?null:(state.now-row.last_request_at)/1000}]:[]];
        }
        throw new Error(`Unexpected recovery query: ${sql}`);
      },
      execute:async(sql,args=[])=>{
        if (/INSERT INTO recovery_rate_limits/.test(sql)) {
          const key=args[1]; state.limits[key]??={bucket_key:key,request_count:0,window_started_at:state.now,last_request_at:null};
          return [{affectedRows:1}];
        }
        if (/UPDATE recovery_rate_limits/.test(sql)) {
          const row=state.limits[args[2]];row.request_count=args[0];if(args[1])row.window_started_at=state.now;row.last_request_at=state.now;
          return [{affectedRows:1}];
        }
        if (/INSERT INTO password_recovery_tokens/.test(sql)) {
          const [id,account_id,account_role,purpose,token_hash,email,auth_version]=args;
          state.challenges.push({id,account_id,account_role,purpose,token_hash,email,auth_version,expires_at:state.now+900000,consumed_at:null});
          return [{affectedRows:1}];
        }
        if (/UPDATE password_recovery_tokens/.test(sql)) {
          let count=0;
          for(const c of state.challenges) if(c.account_id===args[0]&&c.account_role===args[1]&&
            (!/purpose = \?/.test(sql)||c.purpose===args[2])&&c.consumed_at==null){c.consumed_at='consumed';count++;}
          return [{affectedRows:count}];
        }
        if (/UPDATE (users|technicians) SET password_hash/.test(sql)) {
          assert.match(sql,/auth_version = auth_version \+ 1/); assert.match(sql,/AND auth_version = \?/);
          if(state.failPassword)throw new Error('Simulated password update failure');
          const role=/UPDATE users/.test(sql)?'user':'technician';
          const account=state.accounts.find(a=>a.id===args[1]&&a.account_role===role&&a.auth_version===args[2]);
          if(!account)return[{affectedRows:0}];account.password_hash=args[0];account.auth_version++;
          return[{affectedRows:1}];
        }
        if (/UPDATE (users|technicians) SET recovery_email/.test(sql)) {
          const a=state.accounts.find(a=>a.id===args[1]);a.recovery_email=args[0];a.recovery_email_verified_at='verified';return[{affectedRows:1}];
        }
        if (/DELETE FROM device_tokens/.test(sql)) {
          state.devices=state.devices.filter(d=>d.user_id!==args[0]||d.user_type!==args[1]);return[{affectedRows:1}];
        }
        if (/DELETE FROM (recovery_rate_limits|password_recovery_tokens)/.test(sql))return[{affectedRows:0}];
        throw new Error(`Unexpected recovery mutation: ${sql}`);
      },
    };
    return conn;
  };
  const pool=withUuidPersistence({getConnection:async()=>connection()});
  const service=createPasswordRecoveryService({getPool:async()=>pool,frontendUrl:frontend,
    sendMail:async mail=>{state.mails.push(mail);},revokeSessions:async(role,id)=>{state.revoked.push({role,id});}});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const request=async(role='user',email=EMAIL,ip='127.0.0.1')=>{const result=await service.request({role,email,ip});await flush();return result;};
  const token=(index=0)=>new URL(state.mails[index].link).hash.slice('#token='.length);
  return {state,service,request,token,flush};
}

test('reset request is uniform for known, unknown, unverified and passwordless addresses',async()=>{
  const normal=fixture(),unknown=fixture(),unverified=fixture({verified:false}),passwordless=fixture({password:false});
  const result=await normal.request();
  assert.deepEqual(await unknown.request('user','absent@example.test'),result);
  assert.deepEqual(await unverified.request(),result);assert.deepEqual(await passwordless.request(),result);
  assert.equal(normal.state.mails.length,1);assert.equal(unknown.state.mails.length,0);assert.equal(unverified.state.mails.length,0);assert.equal(passwordless.state.mails.length,0);
});

test('only a SHA256 hash of a random opaque token is stored, and links use trusted role-specific fragments',async()=>{
  const f=fixture();await f.request('technician');const token=f.token();
  assert.match(token,/^[a-f0-9]{64}$/);assert.equal(f.state.challenges[0].token_hash,crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(f.state.challenges).includes(token),false);
  const url=new URL(f.state.mails[0].link);assert.equal(url.origin,'https://app.example.test');assert.equal(url.pathname,'/technician/reset-password');assert.equal(url.search,'');
});

for(const role of ['user','technician'])test(`${role} reset changes only its own password and invalidates sessions/links/push`,async()=>{
  const f=fixture();await f.request(role);const other=clone(f.state.accounts.find(a=>a.account_role!==role));
  await f.service.confirm({role,token:f.token(),password:NEW,ip:'127.0.0.1'});await f.flush();
  const account=f.state.accounts.find(a=>a.account_role===role);
  assert.equal(await bcrypt.compare(NEW,account.password_hash),true);assert.equal(await bcrypt.compare(OLD,account.password_hash),false);
  assert.equal(account.auth_version,1);assert.equal(account.status,'approved');assert.match(account.current_job_id,/keep-/);
  assert.deepEqual(f.state.accounts.find(a=>a.account_role!==role),other);
  assert.deepEqual(f.state.revoked,[{role,id:account.id}]);assert.equal(f.state.devices.some(d=>d.user_id===account.id&&d.user_type===role),false);
  assert.equal(f.state.challenges.every(c=>c.consumed_at!=null),true);
  assert.equal(f.state.mails.some(m=>m.kind==='password_changed'),true);
});

test('same-email opposite-role token cannot reset the other account',async()=>{
  const f=fixture();await f.request('user');
  await assert.rejects(f.service.confirm({role:'technician',token:f.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  assert.equal(f.state.accounts.every(a=>a.auth_version===0),true);
});

test('expired and consumed reset tokens fail and concurrent confirmation has exactly one winner',async()=>{
  const expired=fixture();await expired.request();expired.state.now=900001;
  await assert.rejects(expired.service.confirm({role:'user',token:expired.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  const f=fixture();await f.request();
  const outcomes=await Promise.allSettled([1,2].map(()=>f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'})));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.state.accounts[0].auth_version,1);assert.equal(f.state.revoked.length,1);
  await assert.rejects(f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
});

test('resend invalidates the previous challenge, while cooldown returns the same response without another mail',async()=>{
  const f=fixture();const response=await f.request();const old=f.token();
  assert.deepEqual(await f.request(),response);assert.equal(f.state.mails.length,1);
  f.state.now=61000;await f.request();assert.equal(f.state.mails.length,2);assert.notEqual(f.token(1),old);
  await assert.rejects(f.service.confirm({role:'user',token:old,password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  await f.service.confirm({role:'user',token:f.token(1),password:NEW,ip:'127.0.0.1'});
});

test('durable account request limit applies across service calls and unknown emails',async()=>{
  const f=fixture();for(let i=0;i<4;i++){f.state.now=i*61000;await f.request();}
  assert.equal(f.state.mails.length,3);
  const unknown=fixture();for(let i=0;i<4;i++){unknown.state.now=i*61000;await unknown.request('user','absent@example.test');}
  assert.equal(Object.values(unknown.state.limits).some(l=>l.request_count===3),true);assert.equal(unknown.state.mails.length,0);
});

test('IP limits span different identities and confirmation attempts',async()=>{
  const f=fixture();let rejected=false;
  for(let i=0;i<12;i++){try{await f.request('user',`unknown${i}@example.test`);}catch(error){assert.equal(error.statusCode,429);rejected=true;}}
  assert.equal(rejected,true);
  let confirmLimited=false;
  for(let i=0;i<35;i++){try{await f.service.confirm({role:'user',token:'f'.repeat(64),password:NEW,ip:'127.0.0.2'});}catch(error){if(error.statusCode===429)confirmLimited=true;}}
  assert.equal(confirmLimited,true);
});

test('failure rolls back password, token consumption, session version and push deletion together',async()=>{
  const f=fixture();await f.request();f.state.failPassword=true;
  await assert.rejects(f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'}),/Simulated/);
  assert.equal(f.state.accounts[0].auth_version,0);assert.equal(f.state.challenges[0].consumed_at,null);assert.equal(f.state.devices.length,2);assert.equal(f.state.revoked.length,0);
  f.state.failPassword=false;await f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'});
});

test('weak/overlong passwords are rejected without consuming a valid challenge',async()=>{
  const f=fixture();await f.request();
  for(const password of ['short',' '.repeat(14),'a'.repeat(73),'界'.repeat(25)]) {
    assert.throws(()=>validateRecoveryPassword(password),{statusCode:400});
    await assert.rejects(f.service.confirm({role:'user',token:f.token(),password,ip:'127.0.0.1'}),{statusCode:400});
  }
  assert.equal(f.state.challenges[0].consumed_at,null);assert.doesNotThrow(()=>validateRecoveryPassword(NEW));
});

test('verified email must still match current contact and reset accounts must retain a password',async()=>{
  const f=fixture();await f.request();f.state.accounts[0].email='changed@example.test';
  await assert.rejects(f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  const p=fixture();await p.request();p.state.accounts[0].password_hash=null;
  await assert.rejects(p.service.confirm({role:'user',token:p.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
});

test('another password change invalidates all outstanding reset and email-verification challenges',async()=>{
  const f=fixture();await f.request();f.state.accounts[0].auth_version++;
  await assert.rejects(f.service.confirm({role:'user',token:f.token(),password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  const v=fixture({verified:false});await v.service.verificationRequest({role:'technician',accountId:TECH,currentPassword:OLD,ip:'127.0.0.1'});await v.flush();
  v.state.accounts[1].auth_version++;
  await assert.rejects(v.service.verifyEmail({role:'technician',token:v.token(),ip:'127.0.0.1'}),{statusCode:400});
  assert.equal(v.state.accounts[1].recovery_email_verified_at,null);
});

test('enrollment requires current password and email possession before recovery is enabled',async()=>{
  const f=fixture({verified:false});
  await assert.rejects(f.service.verificationRequest({role:'technician',accountId:TECH,currentPassword:'wrong',ip:'127.0.0.1'}),{statusCode:400});
  f.state.now=61000;
  await f.service.verificationRequest({role:'technician',accountId:TECH,currentPassword:OLD,ip:'127.0.0.1'});await f.flush();
  assert.equal(f.state.accounts[1].recovery_email_verified_at,null);
  const token=f.token();
  await assert.rejects(f.service.confirm({role:'technician',token,password:NEW,ip:'127.0.0.1'}),{statusCode:400});
  await f.service.verifyEmail({role:'technician',token,ip:'127.0.0.1'});
  assert.equal(f.state.accounts[1].recovery_email_verified_at,'verified');
  f.state.now=122000;await f.request('technician');assert.equal(f.state.mails.length,2);
});

test('recovery links reject untrusted schemes/origins and never accept request-host input',()=>{
  assert.throws(()=>recoveryLink('user','password_reset','a'.repeat(64),'http://evil.example.test'));
  assert.throws(()=>recoveryLink('user','password_reset','a'.repeat(64),'https://good.test@evil.test/path'));
  assert.equal(new URL(recoveryLink('user','password_reset','a'.repeat(64),'http://localhost:8080')).origin,'http://localhost:8080');
});
