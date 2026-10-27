import {isUuid} from '../models/identifiers.js';
export function recordAcceptedApkDownload({req,res,releaseKey,enqueue}){
 // Best effort: neither validation nor a full queue can break file delivery.
 try{
  if(req.method!=='GET'||![200,206].includes(res.statusCode)||!res.writableFinished||req.aborted)return;
  const candidate=req.query?.download_id;
  enqueue({downloadId:isUuid(candidate)?candidate.toLowerCase():null,releaseKey});
 }catch{/* aggregate queue health is reported separately; never log identity */}
}
