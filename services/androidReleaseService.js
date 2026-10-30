import {parseAndroidRelease,releaseAssetUrl,validateReleaseRepository} from './androidReleaseManifest.js';
import {fetchReleaseResource,readReleaseJson} from './androidReleaseHttp.js';

export function createAndroidReleaseService({env=process.env,fetch:fetcher=globalThis.fetch,now=Date.now,timeoutMs=5000}={}){
 let cached=null,expires=0,pending=null;
 const repository=env.ANDROID_RELEASES_REPOSITORY??'janeshkrish/resqnowfrontend';
 async function load(){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(Error('Android release deadline')),Math.min(Math.max(timeoutMs,1),5000));
  try{
   validateReleaseRepository(repository);
   const options={fetch:fetcher,signal:controller.signal};
   const info=await readReleaseJson(await fetchReleaseResource(`https://api.github.com/repos/${repository}/releases/latest`,{...options,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}}),{limit:128*1024,signal:controller.signal});
   if(info.draft!==false||info.prerelease!==false||typeof info.tag_name!=='string'||!/^android-v[1-9]\d{0,9}$/.test(info.tag_name)||!Array.isArray(info.assets))throw Error('Invalid stable Android release');
   const asset=name=>{const found=info.assets.filter(x=>x?.name===name);if(found.length!==1||found[0].browser_download_url!==releaseAssetUrl(repository,info.tag_name,name)||(found[0].state&&found[0].state!=='uploaded'))throw Error('Invalid Android release asset');return found[0];};
   const metadata=asset('android-release.json'),apk=asset('resqnow.apk');
   if(!Number.isSafeInteger(metadata.size)||metadata.size<1||metadata.size>16384)throw Error('Invalid Android manifest size');
   const value=await readReleaseJson(await fetchReleaseResource(metadata.browser_download_url,options),{limit:16384,signal:controller.signal});
   const release=parseAndroidRelease(value,{repository,tag:info.tag_name});
   if(apk.size!==release.sizeBytes||(apk.digest!=null&&apk.digest!==`sha256:${release.sha256}`))throw Error('Android APK metadata mismatch');
   return {state:'ready',release};
  }catch{return {state:'unavailable'};}
  finally{clearTimeout(timer);}
 }
 return {async getRelease({purpose='update'}={}){
  if(!['update','website'].includes(purpose))throw Error('Invalid Android release purpose');
  const flag=purpose==='website'?'ANDROID_RELEASE_DOWNLOADS_ENABLED':'ANDROID_UPDATES_ENABLED';
  if(env[flag]!=='true')return {state:'disabled'};
  if(cached&&now()<expires)return structuredClone(cached);
  if(!pending)pending=load().then(result=>{cached=result;expires=now()+(result.state==='ready'?300000:30000);return result;}).finally(()=>{pending=null;});
  return structuredClone(await pending);
 }};
}
export const androidReleaseService=createAndroidReleaseService();
