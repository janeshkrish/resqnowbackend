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
 const urls=[];const fetch=async(url,options)=>{urls.push(String(url));if(String(url).startsWith(infoUrl.replace('/latest','?per_page=100&page=')))return json([release()]);if(fetcher)return fetcher(String(url),options);assert.equal(options.redirect,'manual');if(String(url)===infoUrl)return json(release());if(String(url)===jsonUrl)return json(fixture);throw Error('Unexpected upstream URL');};
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
 assert.ok(results.every(x=>x.state==='ready'&&x.release.versionCode===12));assert.equal(urls.length,3);
 results[0].release.versionCode=99;assert.equal((await service.getRelease()).release.versionCode,12);
 time=299999;assert.equal((await service.getRelease()).state,'ready');assert.equal(urls.length,3);
 time=300000;await service.getRelease();assert.equal(urls.length,6);
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
 assert.equal((await service.getRelease()).state,'ready');assert.ok(urls.includes(infoUrl)&&urls.includes(jsonUrl)&&urls.includes(cdn));assert.equal(urls.length,4);
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
function changingUpstream(){
 let code=12,highest=12,hash=fixture.sha256,time=0;const urls=[];
 const metadata=()=>({...fixture,versionCode:code,versionName:'1.4.'+code,sha256:hash,apkUrl:fixture.apkUrl.replace('android-v12','android-v'+code)});
 const information=n=>release({tag_name:'android-v'+n,assets:release().assets.map(asset=>({...asset,browser_download_url:asset.browser_download_url.replace('android-v12','android-v'+n),...(asset.name==='resqnow.apk'?{digest:'sha256:'+hash}:{})}))});
 const service=createAndroidReleaseService({env:{ANDROID_UPDATES_ENABLED:'true',ANDROID_RELEASE_DOWNLOADS_ENABLED:'true'},now:()=>time,fetch:async url=>{urls.push(String(url));return json(String(url)===infoUrl?information(code):String(url).includes('?per_page=100&page=')?[information(highest)]:metadata());}});
 return {service,urls,set:values=>{({code=code,highest=highest,hash=hash,time=time}=values);}};
}
test('cold discovery checks published Android history instead of trusting a stale latest pointer',async()=>{
 const f=changingUpstream();f.set({code:11,highest:12});assert.deepEqual(await f.service.getRelease({purpose:'website'}),{state:'unavailable'});
});
test('known versions never regress across TTL expiry, outages or shared website/update requests',async()=>{
 const f=changingUpstream();assert.equal((await f.service.getRelease()).release.versionCode,12);f.set({code:11,highest:11,time:300000});
 assert.deepEqual(await f.service.getRelease({purpose:'website'}),{state:'unavailable'});const count=f.urls.length;assert.deepEqual(await f.service.getRelease(),{state:'unavailable'});assert.equal(f.urls.length,count);
 f.set({code:13,highest:13,time:330000});assert.equal((await f.service.getRelease()).release.versionCode,13);
});
test('a previously validated version cannot silently change its immutable asset identity',async()=>{
 const f=changingUpstream();assert.equal((await f.service.getRelease()).state,'ready');f.set({hash:'d'.repeat(64),time:300000});assert.deepEqual(await f.service.getRelease(),{state:'unavailable'});
});
test('cold history rejects malformed or unavailable data and ignores unpublished reservations',async()=>{
 for(const history of [null,{},[{tag_name:'android-v012',draft:false,prerelease:false}]]){
  const service=createAndroidReleaseService({env:{ANDROID_UPDATES_ENABLED:'true'},fetch:async url=>json(String(url)===infoUrl?release():String(url)===jsonUrl?fixture:history)});assert.deepEqual(await service.getRelease(),{state:'unavailable'});
 }
 const history=[release(),release({tag_name:'android-v99',draft:true}),release({tag_name:'android-v98',prerelease:true})];
 const service=createAndroidReleaseService({env:{ANDROID_UPDATES_ENABLED:'true'},fetch:async url=>json(String(url)===infoUrl?release():String(url)===jsonUrl?fixture:history)});assert.equal((await service.getRelease()).release.versionCode,12);
});
test('history pagination uses constructed approved URLs and fails closed at the bounded page limit',async()=>{
 const history=[];const service=createAndroidReleaseService({env:{ANDROID_UPDATES_ENABLED:'true'},fetch:async url=>{
  if(String(url)===infoUrl)return json(release());if(String(url)===jsonUrl)return json(fixture);history.push(String(url));return new Response(JSON.stringify([release()]),{headers:{link:'<http://127.0.0.1/private>; rel="next"'}});
 }});
 assert.deepEqual(await service.getRelease(),{state:'unavailable'});assert.equal(history.length,10);assert.ok(history.every((url,index)=>url===`https://api.github.com/repos/janeshkrish/resqnowfrontend/releases?per_page=100&page=${index+1}`));
});
