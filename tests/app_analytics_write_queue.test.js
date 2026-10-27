import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../services/appAnalyticsWriteQueue.js').catch(() => ({}));
test('bounded executor is available', () => assert.equal(typeof mod.createAppAnalyticsWriteQueue, 'function'));
test('invalid proofs do not count as storage failures or open the circuit',async()=>{const q=mod.createAppAnalyticsWriteQueue();for(let i=0;i<6;i++)await assert.rejects(q.submit(async()=>{throw Object.assign(Error('Invalid proof'),{status:403});}),{status:403});assert.equal(await q.submit(async()=>1),1);assert.equal(q.health().circuitOpen,false);});
test('deadline does not free the slot of a still-running SQL operation', async () => {
  assert.equal(typeof mod.createAppAnalyticsWriteQueue, 'function');
  let finish;
  const queue = mod.createAppAnalyticsWriteQueue({concurrency:1,maxPending:1,timeoutMs:20});
  const result = queue.submit(() => new Promise(resolve => { finish=resolve; }));
  await assert.rejects(result, /unavailable/i);
  assert.equal(queue.health().active,1);
  const next = queue.submit(async () => 'second');
  await assert.rejects(queue.submit(async () => 'overflow'), /unavailable/i);
  finish('done');
  assert.equal(await next,'second');
  assert.ok(queue.health().dropped >= 1);
});
test('circuit opens after five storage failures and later permits a probe', async () => {
  assert.equal(typeof mod.createAppAnalyticsWriteQueue,'function');
  let now=0;
  const q=mod.createAppAnalyticsWriteQueue({now:()=>now});
  for(let i=0;i<5;i++) await assert.rejects(q.submit(async()=>{throw Error('db');}));
  await assert.rejects(q.submit(async()=>1), /unavailable/i);
  now=30001;
  assert.equal(await q.submit(async()=>2),2);
  assert.equal(q.health().circuitOpen,false);
});
