import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {fetchReleaseResource} from './androidReleaseHttp.js';

let active=0;
function requestedRange(value,size){
 if(value==null)return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(value);
 if(!match||(!match[1]&&!match[2]))throw Error('Invalid APK range');
 const number=text=>{const n=Number(text);if(!Number.isSafeInteger(n))throw Error('Invalid APK range');return n;};
 let start,end;
 if(!match[1]){const suffix=number(match[2]);if(suffix<1)throw Error('Invalid APK range');start=Math.max(size-suffix,0);end=size-1;}
 else{start=number(match[1]);end=match[2]?Math.min(number(match[2]),size-1):size-1;}
 if(start>=size||end<start)throw Error('Unsatisfiable APK range');
 return {start,end,length:end-start+1};
}
function headers(res,size,status=200,range=null){
 res.statusCode=status;res.setHeader('Content-Type','application/vnd.android.package-archive');
 res.setHeader('Content-Disposition','attachment; filename="resqnow.apk"');res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',String(range?.length??size));
 if(range)res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${size}`);
}
export async function streamAndroidRelease(req,res,{release,headOnly=false,fetch:fetcher=globalThis.fetch,onAccepted,timeoutMs=30000}={}){
 const size=release?.sizeBytes;
 if(!Number.isSafeInteger(size)||size<1||size>200*1024*1024)throw Error('Validated Android release required');
 let range;
 try{range=headOnly?null:requestedRange(req.headers.range,size);}
 catch{res.statusCode=416;res.setHeader('Content-Range',`bytes */${size}`);res.setHeader('Cache-Control','no-store');res.end();return;}
 if(headOnly){headers(res,size);res.end();return;}
 if(active>=4){res.statusCode=503;res.setHeader('Retry-After','15');res.setHeader('Cache-Control','no-store');res.end();return;}
 active++;
 const controller=new AbortController();let idle;
 const arm=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(Error('Android APK idle deadline')),Math.max(1,Math.min(timeoutMs,30000)));};
 const total=setTimeout(()=>controller.abort(Error('Android APK transfer deadline')),300000);
 const abort=()=>controller.abort(Error('Android APK client disconnected'));
 const close=()=>{if(!res.writableFinished)abort();};req.once('aborted',abort);res.once('close',close);arm();
 try{
  const upstream=await fetchReleaseResource(release.apkUrl,{fetch:fetcher,signal:controller.signal,headers:range?{Range:`bytes=${range.start}-${range.end}`}:{}});
  if(upstream.status!==200&&!(range&&upstream.status===206)){await upstream.body?.cancel();throw Error('Android APK upstream unavailable');}
  const partial=upstream.status===206;
  if(partial&&upstream.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${size}`){await upstream.body?.cancel();throw Error('Android APK range mismatch');}
  const expected=partial?range.length:size;
  const length=upstream.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==expected)){await upstream.body?.cancel();throw Error('Android APK length mismatch');}
  if(!upstream.body)throw Error('Empty Android APK response');
  headers(res,size,partial?206:200,partial?range:null);
  let count=0,tail=Buffer.alloc(0),verified=false;const hash=createHash('sha256');
  const check=new Transform({
   transform(chunk,_encoding,done){
    arm();count+=chunk.length;if(count>expected){done(Error('Oversized Android APK'));return;}
    if(!partial)hash.update(chunk);
    // Withhold a bounded final chunk so a bad checksum cannot look complete.
    if(tail.length)this.push(tail);
    if(chunk.length>65536){this.push(chunk.subarray(0,chunk.length-65536));tail=chunk.subarray(chunk.length-65536);}
    else tail=chunk;
    done();
   },
   flush(done){
    if(count!==expected||(!partial&&hash.digest('hex')!==release.sha256)){done(Error('Android APK integrity mismatch'));return;}
    verified=true;if(tail.length)this.push(tail);done();
   },
  });
  res.once('finish',()=>{if(verified&&!req.aborted){try{Promise.resolve(onAccepted?.()).catch(()=>{});}catch{/* analytics never blocks delivery */}}});
  await pipeline(Readable.fromWeb(upstream.body),check,res,{signal:controller.signal});
 }catch{
  if(!res.headersSent&&!res.destroyed){res.statusCode=503;res.removeHeader('Content-Length');res.removeHeader('Content-Range');res.removeHeader('Content-Disposition');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Android app package temporarily unavailable'}));}
  else if(!res.destroyed)res.destroy();
 }finally{clearTimeout(idle);clearTimeout(total);req.removeListener('aborted',abort);res.removeListener('close',close);active--;}
}
