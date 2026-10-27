import mysql from 'mysql2/promise';
// Analytics supplies validated native UUIDs explicitly; do not use the business
// adapter, which intentionally generates IDs itself and rejects explicit keys.
// Pool isolation protects login/dispatch from telemetry. Every borrowed analytics
// connection is physically destroyed at its deadline, not just Promise.raced.
export function createAnalyticsPool(config,{timeoutMs=2000}={}){
  const raw=mysql.createPool({...config,connectionLimit:2,queueLimit:2,waitForConnections:true,connectTimeout:2000,timezone:'Z',dateStrings:true});
  async function getConnection(){
    const c=await raw.getConnection();
    const timer=setTimeout(()=>c.destroy(),timeoutMs);
    return new Proxy(c,{get(target,key){
      if(key==='release')return ()=>{clearTimeout(timer);target.release();};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }
  async function call(method,sql,params){const c=await getConnection();try{return await c[method](sql,params);}finally{c.release();}}
  return {getConnection,query:(...args)=>call('query',...args),execute:(...args)=>call('execute',...args),end:()=>raw.end()};
}
