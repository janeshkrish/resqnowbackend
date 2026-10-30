import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
const {createAndroidUpdatesRouter}=await import('../routes/androidUpdates.js').catch(()=>({}));
async function withApi(service,check){
 assert.equal(typeof createAndroidUpdatesRouter,'function');const app=express();app.use('/api/public',createAndroidUpdatesRouter({service}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{await check('http://127.0.0.1:'+server.address().port+'/api/public/android-app/update');}finally{await new Promise(resolve=>server.close(resolve));}
}
test('public disabled response needs no login and cannot be cached by a service worker',async()=>withApi({getRelease:async()=>({state:'disabled'})},async url=>{
 const response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{state:'disabled'});
}));
test('unavailable release is explicit without exposing an upstream error',async()=>withApi({getRelease:async()=>{throw Error('private upstream detail');}},async url=>{
 const response=await fetch(url);assert.equal(response.status,503);assert.deepEqual(await response.json(),{state:'unavailable'});
}));
test('ready manifest is returned on the intended public path',async()=>withApi({getRelease:async()=>({state:'ready',release:{versionCode:12}})},async url=>{
 const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'ready',release:{versionCode:12}});
}));
test('the production public router actually mounts disabled updater discovery',async()=>{
 const previous=process.env.ANDROID_UPDATES_ENABLED;process.env.ANDROID_UPDATES_ENABLED='false';
 const {default:router}=await import('../routes/public.js');const app=express();app.use('/api/public',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/public/android-app/update`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'disabled'});}
 finally{await new Promise(resolve=>server.close(resolve));if(previous===undefined)delete process.env.ANDROID_UPDATES_ENABLED;else process.env.ANDROID_UPDATES_ENABLED=previous;}
});
test('activated website status reports the release source, not an old local APK',async()=>{
 const prior=process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED='true';
 try{await withApi({getRelease:async({purpose})=>{assert.equal(purpose,'website');return {state:'ready',release:{versionCode:12,versionName:'1.4.12',sizeBytes:16,publishedAt:'2026-10-30T12:00:00Z'}};}},async url=>{
  const r=await fetch(url.replace('/update','/status'));assert.equal(r.status,200);const body=await r.json();assert.equal(body.available,true);assert.equal(body.source,'github_release');assert.equal(body.fileSize,16);assert.equal(body.versionCode,12);assert.equal(body.apkPath,null);assert.equal(body.downloadUrl,'/api/public/android-app/download');
 });}finally{if(prior===undefined)delete process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;else process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED=prior;}
});
test('activated website status fails closed when release discovery is unavailable',async()=>{
 const prior=process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED='true';
 try{await withApi({getRelease:async()=>({state:'unavailable'})},async url=>{const r=await fetch(url.replace('/update','/status'));assert.equal(r.status,503);assert.equal((await r.json()).available,false);});}
 finally{if(prior===undefined)delete process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;else process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED=prior;}
});
