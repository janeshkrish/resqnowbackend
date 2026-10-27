// Explicit additive migration. No dotenv or deployment/full-copy imports.
import mysql from 'mysql2/promise';
import {migrateAppAnalytics} from '../models/migrations/appAnalyticsMigration.js';
const mode=process.argv.includes('--apply')?'apply':process.argv.includes('--check')?'check':'plan';
if(mode==='plan'){console.log(JSON.stringify(await migrateAppAnalytics({mode}),null,2));}
else {
 const database=process.argv.find(a=>a.startsWith('--database='))?.slice(11);
 if(!database||!/^[a-zA-Z0-9_]+$/.test(database))throw Error('Specify the reviewed resolved database using --database=NAME');
 const pool=mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||4000),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database,connectionLimit:1,...(['1','true'].includes(process.env.DB_SSL)?{ssl:{rejectUnauthorized:process.env.DB_SSL_STRICT==='true'}}:{})});
 try{console.log(JSON.stringify(await migrateAppAnalytics({pool,mode})));}finally{await pool.end();}
}
