import express,{Router} from 'express';
import rateLimit from 'express-rate-limit';
import {verifyUser,verifyTechnician,verifyAdmin} from '../middleware/auth.js';
import {appAnalyticsEnabled,appAnalyticsService} from '../services/appAnalyticsService.js';
import {validateAnalyticsReport,validateAnalyticsQuery} from '../services/appAnalyticsValidation.js';
const failure=(res,e)=>res.status([400,403,409,413,429].includes(e?.status)?e.status:503).json({state:'unavailable',error:e?.status===400?'Invalid analytics report':e?.status===413?'Analytics report too large':'App analytics temporarily unavailable'});
export function createAppAnalyticsRouter({store=appAnalyticsService,customerGuard=verifyUser,technicianGuard=verifyTechnician,enabled=appAnalyticsEnabled,now=Date.now,limits={registrations:30,telemetry:6}}={}){
 const router=Router();
 router.use(express.json({limit:'2kb'}));
 const registrations=rateLimit({windowMs:60000,limit:limits.registrations,standardHeaders:true,legacyHeaders:false});
 const telemetry=rateLimit({windowMs:60000,limit:limits.telemetry,keyGenerator:req=>req.analytics.installationId,standardHeaders:true,legacyHeaders:false});
 const collection=(req,res,next)=>enabled()?next():res.status(204).end();
 const validate=kind=>(req,res,next)=>{try{req.analytics=validateAnalyticsReport(req.body,kind);next();}catch(e){failure(res,e);}};
 const call=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){failure(res,e);}};
 router.post('/installations/register',collection,validate('report'),registrations,telemetry,call(async(req,res)=>{const r=await store.registerInstallation({report:req.analytics,now:now()});res.status(r.created?201:200).json(r);}));
 router.post('/installations/heartbeat',collection,validate('report'),telemetry,call(async(req,res)=>{await store.touchInstallation({report:req.analytics,now:now()});res.json({ok:true});}));
 router.post('/installations/withdraw',validate('proof'),telemetry,call(async(req,res)=>{const r=req.analytics;try{await store.withdrawInstallation({installationId:r.installationId,proof:r.installationSecret,consentRevision:r.consentRevision,now:now()});}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}res.json({ok:true});}));
 const rejectAdmin=(req,res,next)=>String(req.user?.role||req.user?.type||'').toLowerCase()==='admin'?res.status(403).json({error:'Forbidden'}):next();
 function link(kind){return call(async(req,res)=>{const r=req.analytics;const id=kind==='user'?(req.user.userId||req.user.id):req.technicianId;await store.linkInstallationAccount({installationId:r.installationId,proof:r.installationSecret,consentRevision:r.consentRevision,account:{kind,id},now:now()});res.json({ok:true});});}
 router.post('/accounts/customer/link',collection,validate('proof'),customerGuard,rejectAdmin,telemetry,link('user'));
 router.post('/accounts/technician/link',collection,validate('proof'),technicianGuard,telemetry,link('technician'));
 router.use((e,_req,res,_next)=>failure(res,{status:e.status===413?413:400}));
 return router;
}
export function createAppAnalyticsAdminRouter({store=appAnalyticsService,guard=verifyAdmin,enabled=appAnalyticsEnabled,now=Date.now}={}){
 const router=Router();router.use(guard);
 const read=method=>async(req,res)=>{
  if(!enabled())return res.json({state:'disabled'});
  try{const q=validateAnalyticsQuery(req.query);const result=await store[method]({...q,now:now()});res.json({...result,health:store.health?.()});}catch(e){failure(res,e);}
 };
 router.get('/summary',read('getInstallSummary'));router.get('/',read('listInstallations'));return router;
}
