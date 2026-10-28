import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
const OFFSET=330*60000, DAY=86400000;
const error=(status,message)=>Object.assign(new Error(message),{status});
const sqlDate=ms=>new Date(ms).toISOString().slice(0,23).replace('T',' ');
export const reportDay=ms=>new Date(ms+OFFSET).toISOString().slice(0,10);
export function reportWindow(days,now=Date.now()){
  if(![7,30,90].includes(Number(days)))throw error(400,'Invalid report period');
  const midnight=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
  return {start:new Date(midnight-(Number(days)-1)*DAY),end:new Date(now)};
}
const hash=secret=>createHash('sha256').update(secret).digest('hex');
function verify(row,proof){if(!row||!timingSafeEqual(Buffer.from(row.proof_hash),Buffer.from(hash(proof))))throw error(403,'Invalid installation proof');}
async function transaction(pool,fn){
  const c=await pool.getConnection();try{await c.beginTransaction();const result=await fn(c);await c.commit();return result;}catch(e){await c.rollback();throw e;}finally{c.release();}
}
async function daily(c,metric,now){await c.query('INSERT INTO android_app_analytics_daily (id,day,metric,total) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE total=total+1',[randomUUID(),reportDay(now),metric]);}
async function lock(c,id,proof,create=false){
  // ON DUPLICATE acquires an exclusive lock immediately. INSERT IGNORE followed
  // by FOR UPDATE upgrades shared duplicate-key locks and deadlocks under retry races.
  if(create)await c.query('INSERT INTO android_app_installations (id,proof_hash) VALUES (?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)',[id,hash(proof)]);
  const [rows]=await c.query('SELECT * FROM android_app_installations WHERE id=? FOR UPDATE',[id]);verify(rows[0],proof);return rows[0];
}
function active(row,revision){if(!row.consent_granted||Number(row.consent_revision)!==revision)throw error(409,'Consent revision is no longer active');}
export async function registerInstallation({pool,report:r,now=Date.now()}){
  return transaction(pool,async c=>{
    const row=await lock(c,r.installationId,r.installationSecret,true);
    if(r.consentRevision<Number(row.consent_revision)||(r.consentRevision===Number(row.consent_revision)&&!row.consent_granted))throw error(409,'Stale consent revision');
    const created=!row.first_seen_day;
    const firstDay=row.first_seen_day||reportDay(now);
    const firstAt=row.first_seen_at||(created?sqlDate(now):`${String(firstDay).slice(0,10)} 00:00:00.000`);
    await c.query('UPDATE android_app_installations SET consent_revision=?,consent_granted=TRUE,consent_policy_version=?,app_id=?,version_name=?,version_code=?,first_seen_at=?,first_seen_day=?,last_seen_at=? WHERE id=?',[r.consentRevision,r.consentPolicyVersion,r.appId,r.versionName,r.versionCode,firstAt,firstDay,sqlDate(now),r.installationId]);
    if(created)await daily(c,'first_open',now);
    return {created,installationId:r.installationId,firstSeenAt:firstAt};
  });
}
export async function touchInstallation({pool,report:r,now=Date.now()}){
  return transaction(pool,async c=>{const row=await lock(c,r.installationId,r.installationSecret);active(row,r.consentRevision);await c.query('UPDATE android_app_installations SET last_seen_at=?,app_id=?,version_name=?,version_code=? WHERE id=?',[sqlDate(now),r.appId,r.versionName,r.versionCode,r.installationId]);});
}
export async function linkInstallationAccount({pool,installationId,proof,consentRevision,account,now=Date.now()}){
  if(!['user','technician'].includes(account.kind))throw error(400,'Invalid account kind');
  return transaction(pool,async c=>{
    const row=await lock(c,installationId,proof);active(row,consentRevision);
    const [accounts]=await c.query(`SELECT id FROM ${account.kind==='user'?'users':'technicians'} WHERE id=? FOR UPDATE`,[account.id]);
    if(!accounts.length)throw error(403,'Account no longer exists');
    await c.query('INSERT INTO android_app_installation_accounts (id,installation_id,account_id,account_type,first_authenticated_at,last_authenticated_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE last_authenticated_at=VALUES(last_authenticated_at)',[randomUUID(),installationId,account.id,account.kind,sqlDate(now),sqlDate(now)]);
    await c.query('UPDATE android_app_installations SET ever_linked=TRUE WHERE id=?',[installationId]);
  });
}
export async function withdrawInstallation({pool,installationId,proof,consentRevision}){
  try { return await transaction(pool,async c=>{
    const row=await lock(c,installationId,proof,true);
    if(consentRevision<Number(row.consent_revision)||(consentRevision===Number(row.consent_revision)&&row.consent_granted))throw error(409,'Stale withdrawal revision');
    await c.query('DELETE FROM android_app_installation_accounts WHERE installation_id=?',[installationId]);
    await c.query('UPDATE android_app_installations SET consent_revision=?,consent_granted=FALSE,consent_policy_version=NULL,app_id=NULL,version_name=NULL,version_code=NULL,first_seen_at=NULL,last_seen_at=NULL WHERE id=?',[consentRevision,installationId]);
  }); } catch(e) { if(e.code==='ER_NO_SUCH_TABLE')return {noRecord:true};throw e; }
}
export async function deleteInstallationAccountLinks({connection,kind,accountId}){
  if(!['user','technician'].includes(kind))throw error(400,'Invalid account kind');
  // Share the link writer's parent lock before removing links. Range/gap locks
  // cannot serialize this on TiDB or MySQL READ COMMITTED; the caller owns the
  // account-deletion transaction and keeps this lock until account deletion.
  await connection.query(`SELECT id FROM ${kind==='user'?'users':'technicians'} WHERE id=? FOR UPDATE`,[accountId]);
  try{await connection.query('DELETE FROM android_app_installation_accounts WHERE account_type=? AND account_id=?',[kind,accountId]);}catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
}
export async function recordDownloadSession({pool,downloadId,releaseKey,now=Date.now()}){
  return transaction(pool,async c=>{
    if(!downloadId){await daily(c,'unattributed_download',now);return {created:true};}
    const [result]=await c.query('INSERT IGNORE INTO android_apk_download_sessions (id,release_key,accepted_at) VALUES (?,?,?)',[downloadId,releaseKey,sqlDate(now)]);
    if(result.affectedRows)await daily(c,'download_session',now);
    return {created:Boolean(result.affectedRows)};
  });
}
export async function purgeDownloadSessions({pool,now=Date.now()}){const [result]=await pool.query('DELETE FROM android_apk_download_sessions WHERE accepted_at < ? LIMIT 1000',[sqlDate(now-30*DAY)]);return result.affectedRows;}
const number=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v||0)]));
export async function getInstallSummary({pool,days=30,now=Date.now()}){
  const w=reportWindow(days,now),start=sqlDate(w.start.getTime()),end=sqlDate(now);
  const [all]=await pool.query('SELECT metric,SUM(total) n FROM android_app_analytics_daily GROUP BY metric');
  const totals={installations:0,downloads:0,unattributedDownloads:0,customers:0,technicians:0};
  const metricMap={first_open:'installations',download_session:'downloads',unattributed_download:'unattributedDownloads'};
  for(const r of all)totals[metricMap[r.metric]]=Number(r.n);
  const [dailyRows]=await pool.query('SELECT day,metric,total FROM android_app_analytics_daily WHERE day>=? AND day<=? ORDER BY day',[reportDay(w.start.getTime()),reportDay(now)]);
  const period={installations:0,downloads:0,unattributedDownloads:0,customers:0,technicians:0,active:0};
  const byDay=new Map();
  for(let time=w.start.getTime();time<=now;time+=DAY){const day=reportDay(time);byDay.set(day,{date:day,installations:0,downloads:0,unattributedDownloads:0});}
  for(const r of dailyRows){const key=metricMap[r.metric];period[key]+=Number(r.total);if(byDay.has(String(r.day).slice(0,10)))byDay.get(String(r.day).slice(0,10))[key]+=Number(r.total);}
  const [linked]=await pool.query(`SELECT COUNT(DISTINCT CASE WHEN a.account_type='user' THEN a.account_id END) customers,COUNT(DISTINCT CASE WHEN a.account_type='technician' THEN a.account_id END) technicians FROM android_app_installation_accounts a JOIN android_app_installations i ON i.id=a.installation_id WHERE i.consent_granted=TRUE`);
  Object.assign(totals,number(linked[0]));
  const [recent]=await pool.query(`SELECT COUNT(DISTINCT CASE WHEN a.account_type='user' THEN a.account_id END) customers,COUNT(DISTINCT CASE WHEN a.account_type='technician' THEN a.account_id END) technicians FROM android_app_installation_accounts a JOIN android_app_installations i ON i.id=a.installation_id WHERE i.consent_granted=TRUE AND a.last_authenticated_at>=? AND a.last_authenticated_at<=?`,[start,end]);
  Object.assign(period,number(recent[0]));
  const [versions]=await pool.query('SELECT version_name version,version_code build,COUNT(*) installations FROM android_app_installations WHERE consent_granted=TRUE AND last_seen_at>=? AND last_seen_at<=? GROUP BY version_name,version_code ORDER BY installations DESC',[start,end]);
  period.active=versions.reduce((n,r)=>n+Number(r.installations),0);
  return {state:'ready',days:Number(days),timezone:'Asia/Kolkata',totals,period,perDay:[...byDay.values()],versions:versions.map(r=>({...r,build:Number(r.build),installations:Number(r.installations)}))};
}
export async function listInstallations({pool,days=30,role='all',version='',page=1,limit=25,now=Date.now()}){
  const w=reportWindow(days,now);const params=[sqlDate(w.start.getTime()),sqlDate(now)];
  let where='i.consent_granted=TRUE AND i.last_seen_at>=? AND i.last_seen_at<=?';
  if(version){where+=' AND i.version_name=?';params.push(version);}
  if(['customer','technician'].includes(role)){where+=' AND EXISTS (SELECT 1 FROM android_app_installation_accounts a WHERE a.installation_id=i.id AND a.account_type=?)';params.push(role==='customer'?'user':'technician');}
  if(role==='never-linked')where+=' AND i.ever_linked=FALSE';
  if(role==='formerly-linked')where+=' AND i.ever_linked=TRUE AND NOT EXISTS (SELECT 1 FROM android_app_installation_accounts a WHERE a.installation_id=i.id)';
  const [[count]]=await pool.query(`SELECT COUNT(*) total FROM android_app_installations i WHERE ${where}`,params);
  const size=Math.min(100,Math.max(1,Number(limit))),offset=(Math.max(1,Number(page))-1)*size;
  const [rows]=await pool.query(`SELECT i.id,i.first_seen_day firstSeenDay,i.last_seen_at lastActiveAt,i.version_name version,i.version_code build,i.ever_linked everLinked,(SELECT COUNT(*) FROM android_app_installation_accounts a WHERE a.installation_id=i.id AND a.account_type='user') customerLinks,(SELECT COUNT(*) FROM android_app_installation_accounts a WHERE a.installation_id=i.id AND a.account_type='technician') technicianLinks FROM android_app_installations i WHERE ${where} ORDER BY i.last_seen_at DESC,i.id LIMIT ${size} OFFSET ${offset}`,params);
  return {state:'ready',rows,total:Number(count.total),page:Number(page),limit:size};
}
