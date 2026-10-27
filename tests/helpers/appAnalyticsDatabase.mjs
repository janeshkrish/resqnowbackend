import mysql from 'mysql2/promise';
import {randomUUID} from 'node:crypto';
export async function createDisposableDatabase(){
  // Deliberately never consumes DB_* or .env; no production bootstrap import.
  const host='127.0.0.1', port=Number(process.env.APP_ANALYTICS_TEST_PORT||13307);
  if(port<1024||port>65535)throw Error('Unsafe test port');
  const config={host,port,user:'root',password:process.env.APP_ANALYTICS_TEST_PASSWORD||'analytics-test-only',timezone:'Z',dateStrings:true};
  const name=`resqnow_analytics_test_${process.pid}_${randomUUID().slice(0,8)}`;
  if(!/^resqnow_analytics_test_[a-z0-9_]+$/.test(name))throw Error('Unsafe disposable database');
  const owner=await mysql.createConnection(config);
  await owner.query(`CREATE DATABASE \`${name}\``);
  const pool=mysql.createPool({...config,database:name,connectionLimit:4});
  for(const table of ['users','technicians']) await pool.query(`CREATE TABLE ${table} (id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, full_name VARCHAR(100))`);
  return {pool,config:{...config,database:name},name,async close(){await pool.end();await owner.query(`DROP DATABASE \`${name}\``);await owner.end();}};
}
