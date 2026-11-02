import test from 'node:test';import assert from 'node:assert/strict';import proxyaddr from 'proxy-addr';
import http from 'node:http';import vm from 'node:vm';import redirects from 'follow-redirects';

test('cross-realm sensitive header lists strip custom credentials on cross-origin redirects',async()=>{
  const target=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.headers));});let destination;
  const origin=http.createServer((_req,res)=>{res.writeHead(302,{Location:destination});res.end();});
  const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{await listen(target);destination=`http://127.0.0.1:${target.address().port}/synthetic-target`;await listen(origin);
    for(const sensitiveHeaders of [['X-API-Key'],vm.runInNewContext("['X-API-Key']")]){
      const received=await new Promise((resolve,reject)=>{const request=redirects.http.get(`http://127.0.0.1:${origin.address().port}/`,{headers:{'X-API-Key':'synthetic-only-not-a-real-key','X-Harmless':'retained'},sensitiveHeaders},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.once('end',()=>{try{resolve(JSON.parse(text));}catch(error){reject(error);}});});request.setTimeout(5000,()=>request.destroy(Error('Synthetic redirect timeout')));request.once('error',reject);});
      assert.equal(received['x-api-key'],undefined,'A custom credential must never follow a cross-origin redirect');assert.equal(received['x-harmless'],'retained');
    }
  }finally{for(const server of [origin,target]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});

test('short IPv6 trust subnets cannot trust arbitrary IPv4 clients or spoof forwarded identity',()=>{
  for(const subnet of ['::ffff:10.0.0.0/8','::/1']){
    const trust=proxyaddr.compile(subnet);assert.equal(trust('203.0.113.7',0),false,subnet+' must not trust an unrelated IPv4 client');
  }
});
test('valid explicit IPv4 and mapped subnet trust still recognizes the intended proxy block',()=>{
  for(const subnet of ['10.0.0.0/8','::ffff:10.0.0.0/104']){const trust=proxyaddr.compile(subnet);assert.equal(trust('10.1.2.3',0),true);assert.equal(trust('203.0.113.7',0),false);}
});
test('existing email delivery contract uses the real Resend adapter without SMTP dependencies',async()=>{
  const previousKey=process.env.RESEND_API_KEY;const previousFetch=globalThis.fetch;const calls=[];
  process.env.RESEND_API_KEY='synthetic-resend-test-key';
  globalThis.fetch=async(input,options)=>{assert.equal(String(input),'https://api.resend.com/emails');calls.push({headers:options.headers,body:JSON.parse(options.body)});return Response.json({id:'synthetic-email-id'});};
  try{
    const {sendMailViaResend}=await import('../utils/mailer.js');
    const result=await sendMailViaResend({from:'ResQNow <sender@example.test>',to:'customer@example.test',subject:'Synthetic receipt',text:'Synthetic only'});
    assert.deepEqual(result,{messageId:'synthetic-email-id',accepted:['customer@example.test'],rejected:[]});assert.equal(calls.length,1);
    assert.deepEqual(calls[0].body,{from:'ResQNow <sender@example.test>',to:['customer@example.test'],subject:'Synthetic receipt',text:'Synthetic only'});
  }finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=previousKey;}
});
