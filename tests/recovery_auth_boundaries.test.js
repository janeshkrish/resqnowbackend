import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from '../db.js';
import adminRouter from '../routes/admin.js';
import { mountCredentialSessions } from '../middleware/credentialSessions.js';
import { verifyUser, signTechnicianToken } from '../middleware/auth.js';

const ID='11111111-1111-4111-8111-111111111111';
Object.assign(process.env,{DB_HOST:'simulated.invalid',DB_USER:'simulated',DB_PASSWORD:'simulated',DB_NAME:'simulated',DB_MIGRATION_MODE:'off',JWT_SECRET:'synthetic-auth-boundary-secret'});
delete process.env.ADMIN_EMAIL;
const { default: usersRouter } = await import('../routes/users.js');

test('admin password change revokes old customer JWT, old password fails, new password signs in despite stale header',async t=>{
  const account={id:ID,email:'owner@example.test',full_name:'Customer',role:'user',is_verified:1,auth_version:0,password_hash:await bcrypt.hash('original-password!',4)};
  const pool={query:async(sql,args)=>{
    if(sql==='SELECT 1')return[[{ok:1}]];
    if(sql.includes('FROM users'))return[[{...account}]];
    throw Error(`Unexpected auth boundary query: ${sql}`);
  },execute:async(sql,args)=>{
    if(sql.includes('SELECT'))return pool.query(sql,args);
    assert.match(sql,/UPDATE users SET full_name = \?, password_hash = \?, auth_version = auth_version \+ 1 WHERE id = \?/);
    assert.equal(args[2],ID);account.full_name=args[0];account.password_hash=args[1];account.auth_version++;return[{affectedRows:1}];
  },end:async()=>{}};
  const driver=mock.method(mysql,'createPool',()=>pool);t.after(async()=>{await db.closePool();driver.mock.restore();});
  const app=express();app.use(express.json());mountCredentialSessions(app);app.use('/api/users',usersRouter);app.use('/api/admin',adminRouter);
  app.get('/api/private',verifyUser,(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const oldToken=jwt.sign({userId:ID,role:'user',sv:0},process.env.JWT_SECRET);
  const call=(path,method,body,token=oldToken)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},...(body?{body:JSON.stringify(body)}:{})});
  const adminToken=jwt.sign({id:ID,role:'admin'},process.env.JWT_SECRET);
  const update=await call(`/api/admin/users/${ID}`,'PUT',{name:'Customer',password:'replacement-password!'},adminToken);
  assert.equal(update.status,200,JSON.stringify(await update.json()));assert.equal(account.auth_version,1);
  assert.equal((await call('/api/private','GET')).status,401);
  assert.equal((await call('/api/users/login','POST',{email:account.email,password:'original-password!'})).status,401);
  const login=await call('/api/users/login','POST',{email:account.email,password:'replacement-password!'});
  assert.equal(login.status,200);const fresh=await login.json();assert.equal(jwt.verify(fresh.token,process.env.JWT_SECRET).sv,1);
  assert.equal((await call('/api/private','GET',null,fresh.token)).status,200);
  assert.equal(jwt.verify(signTechnicianToken(ID,account.email,17),process.env.JWT_SECRET).sv,17);
});
