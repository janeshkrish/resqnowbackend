import test from 'node:test';
import assert from 'node:assert/strict';
const {createAndroidReleaseService}=await import('../services/androidReleaseService.js').catch(()=>({}));
const fixture={schemaVersion:1,channel:'stable',applicationId:'com.resqnow1.app',versionCode:12,versionName:'1.4.12',minSdk:24,targetSdk:36,sizeBytes:16,sha256:'a'.repeat(64),signingCertificateSha256:'b'.repeat(64),apkUrl:'https://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/resqnow.apk',sourceCommit:'c'.repeat(40),publishedAt:'2026-10-30T12:00:00Z'};
const infoUrl='https://api.github.com/repos/janeshkrish/resqnowfrontend/releases/latest';
const jsonUrl='https://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/android-release.json';
const release=(extra={})=>({tag_name:'android-v12',draft:false,prerelease:false,assets:[{name:'resqnow.apk',size:16,digest:'sha256:'+fixture.sha256,browser_download_url:fixture.apkUrl},{name:'android-release.json',size:900,browser_download_url:jsonUrl}],...extra});
const json=value=>new Response(JSON.stringify(value),{status:200});
function make({env={ANDROID_UPDATES_ENABLED:'true'},fetch:fetcher,now=()=>0,...rest}={}){
 assert.equal(typeof createAndroidReleaseService,'function');
 const urls=[];const fetch=async(url,options)=>{urls.push(String(url));if(fetcher)return fetcher(String(url),options);assert.equal(options.redirect,'manual');if(String(url)===infoUrl)return json(release());if(String(url)===jsonUrl)return json(fixture);throw Error('Unexpected upstream URL');};
 return {service:createAndroidReleaseService({env,fetch,now,...rest}),urls};
}
test('disabled checks perform no network work and website activation is independent',async()=>{
 const env={ANDROID_RELEASE_DOWNLOADS_ENABLED:'true'};const {service,urls}=make({env});
 assert.deepEqual(await service.getRelease(),{state:'disabled'});assert.equal(urls.length,0);
 assert.equal((await service.getRelease({purpose:'website'})).state,'ready');
 assert.deepEqual(await service.getRelease(),{state:'disabled'});
});
test('concurrent misses coalesce; validated results expire after five minutes',async()=>{
 let time=0;const {service,urls}=make({now:()=>time});
 const results=await Promise.all(Array.from({length:20},()=>service.getRelease()));
 assert.ok(results.every(x=>x.state==='ready'&&x.release.versionCode===12));assert.equal(urls.length,2);
 results[0].release.versionCode=99;assert.equal((await service.getRelease()).release.versionCode,12);
 time=299999;assert.equal((await service.getRelease()).state,'ready');assert.equal(urls.length,2);
 time=300000;await service.getRelease();assert.equal(urls.length,4);
});
test('failed upstream lookups are bounded by a thirty-second negative cache',async()=>{
 let time=0;const {service,urls}=make({now:()=>time,fetch:()=>new Response('',{status:503})});
 assert.deepEqual(await service.getRelease(),{state:'unavailable'});await service.getRelease();assert.equal(urls.length,1);
 time=30000;await service.getRelease();assert.equal(urls.length,2);
});
for(const [name,value]of [['draft',release({draft:true})],['prerelease',release({prerelease:true})],['wrong tag',release({tag_name:'web-v12'})],['missing asset',release({assets:[]})],['wrong APK size',release({assets:release().assets.map(x=>x.name==='resqnow.apk'?{...x,size:17}:x)})],['mismatched asset digest',release({assets:release().assets.map(x=>x.name==='resqnow.apk'?{...x,digest:'sha256:'+'f'.repeat(64)}:x)})]])test('does not offer '+name,async()=>{
 const {service}=make({fetch:url=>json(url===infoUrl?value:fixture)});assert.deepEqual(await service.getRelease(),{state:'unavailable'});
});
test('blocks a redirect to local HTTP without fetching the target',async()=>{
 const {service,urls}=make({fetch:()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})});
 assert.deepEqual(await service.getRelease(),{state:'unavailable'});assert.deepEqual(urls,[infoUrl]);
});
test('follows only bounded approved HTTPS CDN redirects',async()=>{
 const cdn='https://release-assets.githubusercontent.com/example/manifest';
 const {service,urls}=make({fetch:url=>url===infoUrl?json(release()):url===jsonUrl?new Response(null,{status:302,headers:{location:cdn}}):json(fixture)});
 assert.equal((await service.getRelease()).state,'ready');assert.deepEqual(urls,[infoUrl,jsonUrl,cdn]);
 const loop=make({fetch:()=>new Response(null,{status:302,headers:{location:infoUrl}})});
 assert.deepEqual(await loop.service.getRelease(),{state:'unavailable'});assert.ok(loop.urls.length<=4);
});
test('rejects an oversized manifest and invalid repository before using unsafe data',async()=>{
 const {service}=make({fetch:url=>url===infoUrl?json(release()):new Response(' '.repeat(16385))});
 assert.deepEqual(await service.getRelease(),{state:'unavailable'});
 const unsafe=make({env:{ANDROID_UPDATES_ENABLED:'true',ANDROID_RELEASES_REPOSITORY:'../private'}});
 assert.deepEqual(await unsafe.service.getRelease(),{state:'unavailable'});assert.equal(unsafe.urls.length,0);
});
test('aborts an upstream that never responds',async()=>{
 const {service}=make({timeoutMs:15,fetch:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
 assert.deepEqual(await service.getRelease(),{state:'unavailable'});
});
