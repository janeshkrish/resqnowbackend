import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { transporter } from '../utils/mailer.js';
import { sendEmail } from '../utils/emailService.js';

test('sensitive recovery mail suppresses provider errors and propagates privacy to transport',async()=>{
  const rawToken='do-not-log-this-recovery-token';let sensitive=false;
  const send=mock.method(transporter,'sendMail',async payload=>{sensitive=payload.sensitive;throw new Error(`Provider echoed ${rawToken}`);});
  const logs=[];const output=mock.method(console,'error',(...args)=>logs.push(args));
  try {
    await assert.rejects(sendEmail({to:'owner@example.test',subject:'Recovery',text:rawToken,sensitive:true,from:'ResQNow <mail@example.test>'}));
    assert.equal(sensitive,true);assert.equal(JSON.stringify(logs).includes(rawToken),false);
  } finally {send.mock.restore();output.mock.restore();}
});
