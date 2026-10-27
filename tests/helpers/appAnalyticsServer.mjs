import express from 'express';import cors from 'cors';import jwt from 'jsonwebtoken';
import {randomUUID} from 'node:crypto';import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDisposableDatabase} from './appAnalyticsDatabase.mjs';
import {migrateAppAnalytics} from '../../models/migrations/appAnalyticsMigration.js';
import {createAnalyticsPool} from '../../services/appAnalyticsDatabase.js';
import {createAppAnalyticsService} from '../../services/appAnalyticsService.js';
import {createAppAnalyticsRouter,createAppAnalyticsAdminRouter} from '../../routes/appAnalytics.js';
import {handleAndroidApkDownload} from '../../routes/public.js';
export async function startAppAnalyticsTestServer({port=5192,exitOnShutdown=false}={}){
 if(process.env.APP_ANALYTICS_TEST_DB!=='1'||process.env.NODE_ENV!=='test')throw Error('Explicit disposable analytics test environment required');
 process.env.JWT_SECRET='synthetic-analytics-test-signing-key-not-production';process.env.APP_ANALYTICS_ENABLED='true';
 const db=await createDisposableDatabase();await migrateAppAnalytics({pool:db.pool,mode:'apply'});
 const fixture=await mkdtemp(join(tmpdir(),'resqnow-analytics-'));
 const apk=join(fixture,'fixture.apk');await writeFile(apk,Buffer.from('PK\u0003\u0004Synthetic HTTP-only APK fixture, NOT an installable Android package. '.repeat(30)));
 process.env.ANDROID_APK_PATH=apk;
 const customerId=randomUUID(),technicianId=randomUUID(),adminId=randomUUID();
 await db.pool.query('INSERT INTO users VALUES (?,?),(?,?)',[customerId,'Synthetic customer',adminId,'Synthetic admin']);await db.pool.query('INSERT INTO technicians VALUES (?,?)',[technicianId,'Synthetic technician']);
 const token=(id,role)=>jwt.sign({id,userId:id,role},process.env.JWT_SECRET,{expiresIn:'1h'});
 const session={customerId,technicianId,adminId,customerToken:token(customerId,'user'),technicianToken:token(technicianId,'technician'),adminToken:token(adminId,'admin')};
 let unavailable=false,closing=false;
 const analytics=createAnalyticsPool(db.config);
 const service=createAppAnalyticsService({getPool:async()=>{if(unavailable)throw Error('Simulated analytics-only storage outage');return analytics;}});
 const app=express();app.use(cors({origin:'http://127.0.0.1:5191'}));
 app.get('/health',(_req,res)=>res.json({ready:true,disposableDatabase:db.name}));
 // Compress several app lifecycles into seconds here. Default production rate
 // budgets are separately pinned by real-HTTP API tests, not weakened in index.js.
 app.use('/api/app-analytics',createAppAnalyticsRouter({store:service,limits:{registrations:1000,telemetry:1000}}));app.use('/api/admin/portal/app-installs',createAppAnalyticsAdminRouter({store:service}));
 app.head('/api/public/android-app/download',(req,res)=>handleAndroidApkDownload(req,res,{headOnly:true,analytics:service}));
 app.get('/api/public/android-app/download',(req,res)=>handleAndroidApkDownload(req,res,{analytics:service}));
 app.use('/__test',express.json({limit:'4kb'}));
 app.get('/__test/session',(_req,res)=>res.json(session));
 app.post('/__test/reset',async(_req,res)=>{unavailable=false;process.env.APP_ANALYTICS_ENABLED='true';for(const table of ['android_app_installation_accounts','android_app_installations','android_apk_download_sessions','android_app_analytics_daily'])await db.pool.query(`TRUNCATE TABLE ${table}`);res.json({ok:true});});
 app.post('/__test/availability',(req,res)=>{unavailable=Boolean(req.body.unavailable);process.env.APP_ANALYTICS_ENABLED=req.body.enabled===false?'false':'true';res.json({ok:true});});
 app.get('/__test/business',async(_req,res)=>{const [[r]]=await db.pool.query('SELECT COUNT(*) users FROM users');res.json(r);});
 app.get('/__test/counts',async(_req,res)=>{const [[r]]=await db.pool.query('SELECT COUNT(*) installations FROM android_app_installations WHERE first_seen_day IS NOT NULL');const [[a]]=await db.pool.query('SELECT COUNT(*) links FROM android_app_installation_accounts');res.json({...r,...a});});
 let server;async function close(){if(closing)return;closing=true;await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await analytics.end();await db.close();await unlink(apk);await rmdir(fixture);}
 app.post('/__test/shutdown',(_req,res)=>{res.json({ok:true});setTimeout(()=>void close().then(()=>{if(exitOnShutdown)process.exit(0);}),20);});
 server=app.listen(port,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 return {close,server};
}
