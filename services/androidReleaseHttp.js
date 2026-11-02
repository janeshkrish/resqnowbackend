const hosts=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
export function validateReleaseUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||!hosts.has(url.hostname))throw Error('Disallowed Android release origin');
 return url;
}
export async function fetchReleaseResource(value,{fetch:fetcher=globalThis.fetch,signal,headers={}}={}){
 let url=validateReleaseUrl(value);
 for(let redirects=0;redirects<=3;redirects++){
  signal?.throwIfAborted();
  const response=await fetcher(url.href,{signal,redirect:'manual',headers:{Accept:'application/octet-stream',...headers}});
  if(![301,302,303,307,308].includes(response.status))return response;
  await response.body?.cancel();
  const location=response.headers.get('location');
  if(!location||redirects===3)throw Error('Invalid Android release redirect');
  url=validateReleaseUrl(new URL(location,url).href);
 }
 throw Error('Android release redirect limit');
}
export async function readReleaseJson(response,{limit,signal}){
 if(response.status!==200){await response.body?.cancel();throw Error('Android release unavailable');}
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)){await response.body?.cancel();throw Error('Android release response too large');}
 if(!response.body)throw Error('Empty Android release response');
 const reader=response.body.getReader();let size=0;const chunks=[];
 let onAbort;const aborted=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason??Error('Android release deadline'));signal.addEventListener('abort',onAbort,{once:true});});
 try{
  signal.throwIfAborted();
  for(;;){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;size+=value.byteLength;if(size>limit)throw Error('Android release response too large');chunks.push(Buffer.from(value));}
  return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{signal.removeEventListener('abort',onAbort);reader.releaseLock();}
}
