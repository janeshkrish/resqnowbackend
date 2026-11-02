import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {createHash} from 'node:crypto';import express from 'express';
const {streamAndroidRelease}=await import('../services/androidReleaseStream.js').catch(()=>({}));
const bytes=Buffer.from('0123456789abcdef');
const release={versionCode:12,sizeBytes:16,sha256:createHash('sha256').update(bytes).digest('hex'),apkUrl:'https://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/resqnow.apk'};
async function fixture(check,{upstream,override={},onAccepted,timeoutMs,useHandler=false,available=true}={}){
 assert.equal(typeof streamAndroidRelease,'function');let hits=0,accepted=0;
 const source=http.createServer(upstream??((req,res)=>{
  if(req.headers.range){const [,a,b]=req.headers.range.match(/^bytes=(\d+)-(\d+)$/)||[];res.writeHead(206,{'Content-Range':`bytes ${a}-${b}/16`,'Content-Length':Number(b)-Number(a)+1});res.end(bytes.subarray(Number(a),Number(b)+1));}
  else{res.writeHead(200,{'Content-Length':16});res.end(bytes);}
 }));await new Promise(r=>source.listen(0,'127.0.0.1',r));
 const upstreamFetch=(_url,options)=>{hits++;return fetch(`http://127.0.0.1:${source.address().port}`,options);};
 const previous=process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;let handler;
 if(useHandler){process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED='true';const {handleAndroidApkDownload}=await import('../routes/public.js');const e=express();e.use((req,res)=>{void handleAndroidApkDownload(req,res,{headOnly:req.method==='HEAD',releaseService:{getRelease:async()=>available?{state:'ready',release}:{state:'unavailable'}},releaseFetch:upstreamFetch,analytics:{enqueueDownload:()=>{accepted++;}}});});handler=e;}
 else handler=(req,res)=>{void streamAndroidRelease(req,res,{release:{...release,...override},headOnly:req.method==='HEAD',fetch:upstreamFetch,onAccepted:()=>{accepted++;onAccepted?.();},timeoutMs});};
 const app=http.createServer(handler);await new Promise(r=>app.listen(0,'127.0.0.1',r));
 try{await check(`http://127.0.0.1:${app.address().port}`,()=>({hits,accepted}));}
 finally{app.closeAllConnections();source.closeAllConnections();await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>source.close(r))]);if(previous===undefined)delete process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED;else process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED=previous;}
}
test('streams exact APK bytes and counts a completed GET once',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'16');assert.match(r.headers.get('content-disposition'),/resqnow\.apk/);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(await r.text(),'0123456789abcdef');assert.deepEqual(state(),{hits:1,accepted:1});
}));
test('HEAD uses validated metadata without transferring or counting an APK',()=>fixture(async(url,state)=>{
 const r=await fetch(url,{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'16');assert.equal(await r.text(),'');assert.deepEqual(state(),{hits:0,accepted:0});
}));
for(const [range,text,contentRange]of [['bytes=0-3','0123','bytes 0-3/16'],['bytes=12-','cdef','bytes 12-15/16'],['bytes=-4','cdef','bytes 12-15/16'],['bytes=14-99','ef','bytes 14-15/16']])test('preserves completed range '+range,()=>fixture(async(url,state)=>{
 const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),contentRange);assert.equal(await r.text(),text);assert.deepEqual(state(),{hits:1,accepted:1});
}));
for(const range of ['bytes=16-20','bytes=0-1,4-5','bytes=-0','bytes=8-2','bytes=999999999999999999999-'])test('rejects an unsafe or unsatisfiable range '+range,()=>fixture(async(url,state)=>{
 const r=await fetch(url,{headers:{Range:range}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */16');await r.arrayBuffer();assert.deepEqual(state(),{hits:0,accepted:0});
}));
test('does not follow an unsafe upstream redirect or count the failure',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(r.status,503);await r.text();assert.deepEqual(state(),{hits:1,accepted:0});
},{upstream:(_req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();}}));
test('rejects a mismatched upstream range before delivering a successful response',()=>fixture(async(url,state)=>{
 const r=await fetch(url,{headers:{Range:'bytes=0-3'}});assert.equal(r.status,503);await r.text();assert.equal(state().accepted,0);
},{upstream:(_req,res)=>{res.writeHead(206,{'Content-Range':'bytes 4-7/16','Content-Length':4});res.end('4567');}}));
test('never counts an upstream body that is truncated',()=>fixture(async(url,state)=>{
 await assert.rejects(async()=>{const r=await fetch(url);if(r.status>=500)throw Error('upstream failed');await r.arrayBuffer();});assert.equal(state().accepted,0);
},{upstream:(_req,res)=>{res.writeHead(200,{'Content-Length':16});res.write('0123');res.destroy();}}));
test('never counts a same-size APK with the wrong full-file checksum',()=>fixture(async(url,state)=>{
 await assert.rejects(async()=>{const r=await fetch(url);if(r.status>=500)throw Error('integrity failed');await r.arrayBuffer();});assert.equal(state().accepted,0);
},{override:{sha256:'f'.repeat(64)}}));
test('an accounting exception never breaks an accepted file transfer',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(await r.text(),'0123456789abcdef');assert.equal(state().accepted,1);
},{onAccepted:()=>{throw Error('analytics unavailable');}}));
test('an idle upstream expires without counting or hanging delivery',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(r.status,503);await r.text();assert.equal(state().accepted,0);
},{upstream:()=>{},timeoutMs:30}));
test('the existing download handler streams an activated release and preserves accounting',()=>fixture(async(url,state)=>{
 const r=await fetch(url+'?download_id=11111111-1111-4111-8111-111111111111');assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'16');assert.equal(await r.text(),'0123456789abcdef');assert.deepEqual(state(),{hits:1,accepted:1});
},{useHandler:true}));
test('an unavailable activated source never silently serves an old local APK',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(r.status,503);await r.text();assert.deepEqual(state(),{hits:0,accepted:0});
},{useHandler:true,available:false}));
test('the activated handler HEAD returns release metadata without counting it',()=>fixture(async(url,state)=>{
 const r=await fetch(url,{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'16');assert.deepEqual(state(),{hits:0,accepted:0});
},{useHandler:true}));
test('accepts a full response when the upstream correctly ignores a range',()=>fixture(async(url,state)=>{
 const r=await fetch(url,{headers:{Range:'bytes=0-3'}});assert.equal(r.status,200);assert.equal(r.headers.get('content-range'),null);assert.equal(await r.text(),'0123456789abcdef');assert.equal(state().accepted,1);
},{upstream:(_req,res)=>{res.writeHead(200,{'Content-Length':16});res.end(bytes);}}));
test('rejects an incorrect upstream content length before streaming',()=>fixture(async(url,state)=>{
 const r=await fetch(url);assert.equal(r.status,503);await r.text();assert.equal(state().accepted,0);
},{upstream:(_req,res)=>{res.writeHead(200,{'Content-Length':17});res.end('0123456789abcdefg');}}));
test('rejects an oversized chunked APK without counting it',()=>fixture(async(url,state)=>{
 await assert.rejects(async()=>{const r=await fetch(url);if(r.status>=500)throw Error('upstream rejected');await r.arrayBuffer();});assert.equal(state().accepted,0);
},{upstream:(_req,res)=>{res.writeHead(200,{'Transfer-Encoding':'chunked'});res.write('0123456789abcdef');res.end('g');}}));
test('client cancellation cancels upstream work without incrementing accounting',()=>fixture(async(url,state)=>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50);
 try{await assert.rejects(fetch(url,{signal:controller.signal}));assert.equal(state().accepted,0);}finally{clearTimeout(timer);}
},{upstream:(_req,res)=>{res.writeHead(200,{'Content-Length':16});res.write('0123');}}));
