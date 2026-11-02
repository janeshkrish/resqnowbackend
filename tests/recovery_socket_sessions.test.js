import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { SocketService } from '../services/socket.js';
import { createCredentialSessionValidator } from '../services/credentialSessions.js';
process.env.JWT_SECRET='synthetic-recovery-socket-secret';
const ID='11111111-1111-4111-8111-111111111111';
const event=(s,name)=>new Promise(resolve=>s.once(name,resolve));
test('reset revokes connected socket rooms, rejects old reconnection and accepts new credentials',async t=>{
  let version=0;
  const validateSession=createCredentialSessionValidator({getPool:async()=>({query:async()=>[[{auth_version:version}]]})});
  const server=createServer(),service=new SocketService();service.init(server,{validateSession,sessionCheckIntervalMs:50});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const clients=[];t.after(async()=>{clients.forEach(c=>c.disconnect());await new Promise(resolve=>service.io.close(resolve));});
  const client=sv=>{const s=io(`http://127.0.0.1:${server.address().port}`,{autoConnect:false,reconnection:false,transports:['websocket'],auth:{token:jwt.sign({id:ID,role:'user',sv},process.env.JWT_SECRET)}});clients.push(s);return s;};
  const first=client(0);const connected=event(first,'connect');first.connect();await connected;
  assert.ok([...service.io.sockets.sockets.values()][0].rooms.has(`session_user_${ID}`));
  version=1;const disconnected=event(first,'disconnect');await service.revokeSessions('user',ID);await disconnected;
  const stale=client(0),rejected=event(stale,'connect_error');stale.connect();assert.match((await rejected).message,/Unauthorized/);
  const fresh=client(1),accepted=event(fresh,'connect');fresh.connect();await accepted;assert.equal(fresh.connected,true);
  // Periodic fail-closed validation also closes a passive subscription without a broadcast.
  version=2;await event(fresh,'disconnect');assert.equal(fresh.connected,false);
});

test('an incoming tracking/room packet is checked against the current version before handling',async t=>{
  let version=0;const server=createServer(),service=new SocketService();
  service.init(server,{sessionCheckIntervalMs:60000,validateSession:createCredentialSessionValidator({getPool:async()=>({query:async()=>[[{auth_version:version}]]})})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=io(`http://127.0.0.1:${server.address().port}`,{autoConnect:false,reconnection:false,transports:['websocket'],auth:{token:jwt.sign({id:ID,role:'user',sv:0},process.env.JWT_SECRET)}});
  t.after(async()=>{client.disconnect();await new Promise(resolve=>service.io.close(resolve));});
  const connected=event(client,'connect');client.connect();await connected;
  version=1;const disconnected=event(client,'disconnect');client.emit('join_user_room',ID);await disconnected;
  assert.equal(service.io.sockets.adapter.rooms.has(`user_${ID}`),false);
});
