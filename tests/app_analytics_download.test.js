import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const m=await import('../services/appAnalyticsDownloads.js').catch(()=>({}));
test('only accepted, non-aborted APK GET responses count; hooks never prevent delivery',()=>{
 assert.equal(typeof m.recordAcceptedApkDownload,'function');const calls=[];
 const req={method:'GET',query:{download_id:randomUUID()}},response={statusCode:206,writableFinished:true,destroyed:false};
 m.recordAcceptedApkDownload({req,res:response,releaseKey:'fixture:1',enqueue:r=>calls.push(r)});
 assert.equal(calls.length,1);assert.equal(calls[0].downloadId,req.query.download_id);
 for(const status of [304,404,500])m.recordAcceptedApkDownload({req,res:{...response,statusCode:status},releaseKey:'fixture',enqueue:r=>calls.push(r)});
 m.recordAcceptedApkDownload({req:{...req,method:'HEAD'},res:response,enqueue:r=>calls.push(r)});
 m.recordAcceptedApkDownload({req,res:{...response,writableFinished:false},enqueue:r=>calls.push(r)});assert.equal(calls.length,1);
 assert.doesNotThrow(()=>m.recordAcceptedApkDownload({req,res:response,enqueue:()=>{throw Error('queue full');}}));
 m.recordAcceptedApkDownload({req:{...req,query:{download_id:'bad'}},res:response,releaseKey:'fixture',enqueue:r=>calls.push(r)});assert.equal(calls.at(-1).downloadId,null);
});
