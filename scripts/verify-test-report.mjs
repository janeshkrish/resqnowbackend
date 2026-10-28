import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// npm test can legitimately skip opt-in DB tests for local development.
// Required release verification must not silently accept that same result.
export function assertCompleteTestReport(text){
  const counts={};
  if(typeof text!=='string')throw Error('Required test report: expected TAP output');
  for(const key of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...text.matchAll(new RegExp('^# '+key+' (\\d+)\\r?$','gm'))];
    if(matches.length!==1)throw Error('Required test report: missing or duplicate '+key+' summary');
    counts[key]=Number(matches[0][1]);
  }
  if(!Number.isSafeInteger(counts.tests)||counts.tests<=0||counts.pass!==counts.tests||
    ['fail','cancelled','skipped','todo'].some(key=>counts[key]!==0)){
    throw Error('Required test report: all discovered tests must execute and pass; no skips, todo, cancellation or failure');
  }
  return counts;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    if(process.argv.length!==3)throw Error('Required test report: provide one TAP report path');
    const counts=assertCompleteTestReport(await fs.readFile(process.argv[2],'utf8'));
    console.log('[release-quality] '+counts.tests+' backend tests passed;0 skipped');
  }catch(error){
    console.error(error.message);
    process.exitCode=1;
  }
}
