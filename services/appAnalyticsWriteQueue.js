// Analytics has a separate resource budget. A deadline rejects its caller but
// NEVER frees a slot until the underlying operation has actually settled.
export function createAppAnalyticsWriteQueue({now=Date.now,maxPending=500,concurrency=2,timeoutMs=2000,failureThreshold=5,openMs=30000}={}) {
  let active=0, dropped=0, timeouts=0, failures=0, openUntil=0;
  const pending=[];
  const unavailable=()=>Object.assign(new Error('App analytics temporarily unavailable'),{status:503,code:'ANALYTICS_UNAVAILABLE'});
  const health=()=>({active,pending:pending.length,dropped,timeouts,circuitOpen:now()<openUntil});
  function failed(){ if(++failures>=failureThreshold) openUntil=now()+openMs; }
  function drain(){
    while(active<concurrency && pending.length){
      const job=pending.shift();
      if(job.expired)continue;
      if(now()<openUntil){clearTimeout(job.timer);dropped++;job.reject(unavailable());continue;}
      active++;
      Promise.resolve().then(job.run).then(value=>{if(!job.expired){failures=0;openUntil=0;job.resolve(value);}},error=>{const clientError=error?.status>=400&&error?.status<500;if(!clientError)failed();if(!job.expired)job.reject(clientError?error:unavailable());}).finally(()=>{clearTimeout(job.timer);active--;drain();});
    }
  }
  function submit(run){
    if(typeof run!=='function')return Promise.reject(new TypeError('Analytics operation must be a function'));
    if(now()<openUntil || pending.length>=maxPending){dropped++;return Promise.reject(unavailable());}
    return new Promise((resolve,reject)=>{
      const job={run,resolve,reject,expired:false};
      job.timer=setTimeout(()=>{job.expired=true;timeouts++;dropped++;const index=pending.indexOf(job);if(index>=0)pending.splice(index,1);else failed();reject(unavailable());},timeoutMs);
      pending.push(job);drain();
    });
  }
  return {submit,enqueue(run){submit(run).catch(()=>{});},health};
}
