import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const api=await import('../scripts/verify-test-report.mjs').catch(()=>({}));
const report='# tests 616\n# suites 0\n# pass 616\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function verify(text){
  assert.equal(typeof api.assertCompleteTestReport,'function','complete test report verifier must exist');
  return api.assertCompleteTestReport(text);
}
test('accepts a complete test run without skipped or cancelled database cases',()=>{
  assert.equal(verify(report).tests,616);
});
for(const [name,broken] of [
  ['zero tests',report.replaceAll('616','0')],
  ['missing summary',report.replace('# skipped 0\n','')],
  ['duplicate summary',report+'# pass 616\n'],
  ['failures',report.replace('# fail 0','# fail 1')],
  ['cancellation',report.replace('# cancelled 0','# cancelled 1')],
  ['skipped database cases',report.replace('# skipped 0','# skipped 1')],
  ['todo cases',report.replace('# todo 0','# todo 1')],
  ['inconsistent totals',report.replace('# pass 616','# pass 615')],
  ['malformed report','looks successful'],
])test('rejects '+name+' even when the process reported exit zero',()=>{
  assert.throws(()=>verify(broken),/required test report/i);
});
test('the command exits nonzero for a skipped test without printing report contents',async()=>{
  const base=await fs.realpath(os.tmpdir());
  const dir=await fs.mkdtemp(path.join(base,'resqnow-report-'));
  try{
    const file=path.join(dir,'result.tap');
    await fs.writeFile(file,report.replace('# skipped 0','# skipped 1')+'PRIVATE_SENTINEL_DO_NOT_PRINT');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/verify-test-report.mjs',import.meta.url)),file],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/required test report/i);
    assert.ok(!result.stderr.includes('PRIVATE_SENTINEL'));
  }finally{
    const target=await fs.realpath(dir);
    assert.equal(path.dirname(target),base);assert.ok(path.basename(target).startsWith('resqnow-report-'));
    await fs.rm(target,{recursive:true,force:true});
  }
});
