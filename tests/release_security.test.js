import test from 'node:test';import assert from 'node:assert/strict';import proxyaddr from 'proxy-addr';

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
