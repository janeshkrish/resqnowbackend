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
 return router;
}
