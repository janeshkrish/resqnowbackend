import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {androidReleaseService} from '../services/androidReleaseService.js';

export function createAndroidUpdatesRouter({service=androidReleaseService}={}){
 const router=Router();
 const limiter=rateLimit({windowMs:60000,limit:60,standardHeaders:true,legacyHeaders:false,message:{state:'unavailable'}});
 router.get('/android-app/update',limiter,async(_req,res)=>{
  res.set('Cache-Control','no-store');
  try{const result=await service.getRelease();res.status(result.state==='unavailable'?503:200).json(result);}
  catch{res.status(503).json({state:'unavailable'});}
 });
 // When disabled, leave the pre-existing local-file status route untouched.
 router.get('/android-app/status',async(_req,res,next)=>{
  if(process.env.ANDROID_RELEASE_DOWNLOADS_ENABLED!=='true'){next();return;}
  res.set('Cache-Control','no-store');
  try{
   const result=await service.getRelease({purpose:'website'});
   if(result.state!=='ready'){res.status(503).json({available:false,error:'Android app package temporarily unavailable'});return;}
   const release=result.release;
   res.json({available:true,apkPath:null,fileName:'resqnow.apk',fileSize:release.sizeBytes,modifiedAt:release.publishedAt,downloadUrl:'/api/public/android-app/download',source:'github_release',releaseDir:null,error:null,versionCode:release.versionCode,versionName:release.versionName});
  }catch{res.status(503).json({available:false,error:'Android app package temporarily unavailable'});}
 });
 return router;
}
