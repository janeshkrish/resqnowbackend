import * as schema from '../schema/appAnalytics.js';
export const APP_ANALYTICS_SCHEMA_VERSION=1;
const indexes={
 android_app_installations:{PRIMARY:['id'],idx_android_active:['consent_granted','last_seen_at'],idx_android_version:['version_name']},
 android_app_installation_accounts:{PRIMARY:['id'],uq_android_install_account:['installation_id','account_type','account_id'],idx_android_account:['account_type','account_id'],idx_android_authenticated:['last_authenticated_at']},
 android_apk_download_sessions:{PRIMARY:['id'],idx_android_download_retention:['accepted_at']},
 android_app_analytics_daily:{PRIMARY:['id'],uq_android_day_metric:['day','metric']},
};
export async function migrateAppAnalytics({pool,mode='plan'}){
  if(!['plan','check','apply'].includes(mode))throw Error('Expected plan, check or apply');
  const statements=Object.values(schema);
  if(mode==='plan')return {version:APP_ANALYTICS_SCHEMA_VERSION,statements};
  if(mode==='apply')for(const sql of statements)await pool.query(sql);
  const tables=[];
  for(const name of Object.keys(schema)){
    const [columns]=await pool.query(`SHOW COLUMNS FROM ${name}`);
    if(!columns.some(c=>c.Field==='id'&&/^char\(36\)$/i.test(c.Type)&&c.Key==='PRI'))throw Error('Analytics schema requires UUID primary keys');
    const required=[...schema[name].matchAll(/(?:\(|,)\s*([a-z_]+)\s+(?:CHAR|VARCHAR|INT|BIGINT|BOOLEAN|DATETIME|DATE|ENUM)/gi)].map(m=>m[1]);
    if(required.some(field=>!columns.some(c=>c.Field===field)))throw Error('Incomplete analytics schema; run the reviewed additive migration');
    const [actualIndexes]=await pool.query(`SHOW INDEX FROM ${name}`);
    for(const [key,fields] of Object.entries(indexes[name])){
      const actual=actualIndexes.filter(i=>i.Key_name===key).sort((a,b)=>a.Seq_in_index-b.Seq_in_index);
      if(actual.map(i=>i.Column_name).join(',')!==fields.join(',')||((key==='PRIMARY'||key.startsWith('uq_'))&&actual.some(i=>Number(i.Non_unique)!==0)))throw Error(`Missing or incompatible analytics index: ${name}.${key}`);
    }
    tables.push(name);
  }
  return {version:APP_ANALYTICS_SCHEMA_VERSION,tables};
}
