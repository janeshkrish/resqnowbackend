import test from 'node:test';
import assert from 'node:assert/strict';
const {parseAndroidRelease}=await import('../services/androidReleaseManifest.js').catch(()=>({}));
export const repository='janeshkrish/resqnowfrontend';
export const manifest={schemaVersion:1,channel:'stable',applicationId:'com.resqnow1.app',versionCode:12,versionName:'1.4.12',minSdk:24,targetSdk:36,sizeBytes:16,sha256:'a'.repeat(64),signingCertificateSha256:'b'.repeat(64),apkUrl:'https://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/resqnow.apk',sourceCommit:'c'.repeat(40),publishedAt:'2026-10-30T12:00:00Z'};
test('accepts and copies the complete stable APK manifest',()=>{
 assert.equal(typeof parseAndroidRelease,'function');
 const result=parseAndroidRelease(manifest,{repository,tag:'android-v12'});
 assert.deepEqual(result,manifest);assert.notEqual(result,manifest);
});
for(const [name,changes] of [
 ['another app',{applicationId:'other.app'}],['prerelease channel',{channel:'beta'}],['unsupported schema',{schemaVersion:2}],
 ['noninteger version',{versionCode:12.5}],['overflowing version',{versionCode:2147483648}],['zero version',{versionCode:0}],
 ['empty version label',{versionName:''}],['invalid SDK order',{minSdk:37,targetSdk:36}],['unsupported legacy SDK',{minSdk:23}],
 ['oversized APK',{sizeBytes:209715201}],['empty APK',{sizeBytes:0}],['invalid digest',{sha256:'not-a-hash'}],
 ['invalid certificate',{signingCertificateSha256:'b'.repeat(63)}],['invalid source commit',{sourceCommit:'main'}],
 ['invalid date',{publishedAt:'2026-02-30T12:00:00Z'}],['a credential',{accessToken:'must-not-be-accepted'}],
 ['HTTP download',{apkUrl:'http://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/resqnow.apk'}],
 ['another repository',{apkUrl:'https://github.com/attacker/repo/releases/download/android-v12/resqnow.apk'}],
 ['encoded path trick',{apkUrl:'https://github.com/janeshkrish/resqnowfrontend/releases/download/android-v12/%72esqnow.apk'}],
 ['URL query',{apkUrl:manifest.apkUrl+'?redirect=https://attacker.test'}],
])test('rejects '+name,()=>{assert.equal(typeof parseAndroidRelease,'function');assert.throws(()=>parseAndroidRelease({...manifest,...changes},{repository,tag:'android-v12'}));});
test('binds version to the exact release tag and repository',()=>{
 assert.equal(typeof parseAndroidRelease,'function');
 for(const options of [{repository,tag:'android-v13'},{repository:'../repo',tag:'android-v12'},{repository:'janeshkrish/..',tag:'android-v12'}])assert.throws(()=>parseAndroidRelease(manifest,options));
});
