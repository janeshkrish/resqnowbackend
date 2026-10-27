import {getResolvedDatabaseOptions} from '../db.js';
import {createAnalyticsPool} from './appAnalyticsDatabase.js';
import {createAppAnalyticsWriteQueue} from './appAnalyticsWriteQueue.js';
import * as store from './appAnalyticsStore.js';
export const appAnalyticsEnabled=()=>process.env.APP_ANALYTICS_ENABLED==='true';
let dedicated;
async function getDedicatedPool(){if(!dedicated)dedicated=getResolvedDatabaseOptions().then(createAnalyticsPool).catch(e=>{dedicated=null;throw e;});return dedicated;}
export function createAppAnalyticsService({getPool=getDedicatedPool,now=Date.now,queue=createAppAnalyticsWriteQueue()}={}){
 const result={health:queue.health};
 for(const key of ['registerInstallation','touchInstallation','linkInstallationAccount','withdrawInstallation','getInstallSummary','listInstallations'])result[key]=args=>queue.submit(async()=>store[key]({...args,pool:await getPool(),now:now()}));
 result.enqueueDownload=args=>{if(appAnalyticsEnabled())queue.enqueue(async()=>store.recordDownloadSession({...args,pool:await getPool(),now:now()}));};
 result.purge=()=>queue.submit(async()=>{const pool=await getPool(),start=Date.now();let deleted;do{deleted=await store.purgeDownloadSessions({pool,now:now()});}while(deleted===1000&&Date.now()-start<1000);});
 return result;
}
export const appAnalyticsService=createAppAnalyticsService();
// Independent of collection's kill switch: retention can continue during rollback.
export function startAppAnalyticsMaintenance({service=appAnalyticsService,enabled=()=>process.env.APP_ANALYTICS_RETENTION_ENABLED==='true'}={}){
 let inFlight=false;
 async function runNow(){if(!enabled()||inFlight)return;inFlight=true;try{await service.purge();}catch{/* queue health exposes failure without identifiers */}finally{inFlight=false;}}
 const timer=setInterval(()=>void runNow(),60000);timer.unref?.();return {runNow,stop:()=>clearInterval(timer)};
}
