const fields=['schemaVersion','channel','applicationId','versionCode','versionName','minSdk','targetSdk','sizeBytes','sha256','signingCertificateSha256','apkUrl','sourceCommit','publishedAt'];
const digest=/^[a-f0-9]{64}$/;
export function validateReleaseRepository(value){
 if(typeof value!=='string'||!/^[-a-zA-Z0-9]{1,39}\/[.a-zA-Z0-9_-]{1,100}$/.test(value)||['.','..'].includes(value.split('/')[1]))throw Error('Invalid Android release repository');
 return value;
}
export function releaseAssetUrl(repository,tag,name){
 validateReleaseRepository(repository);
 if(!/^android-v[1-9]\d{0,9}$/.test(tag)||!['resqnow.apk','android-release.json'].includes(name))throw Error('Invalid Android release asset');
 return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}
export function parseAndroidRelease(value,{repository,tag}={}){
 validateReleaseRepository(repository);
 const invalid=()=>{throw Error('Invalid Android release manifest');};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k)))invalid();
 const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
 if(value.schemaVersion!==1||value.channel!=='stable'||value.applicationId!=='com.resqnow1.app'||!integer(value.versionCode,1,2147483647)||tag!==`android-v${value.versionCode}`)invalid();
 if(typeof value.versionName!=='string'||!value.versionName.trim()||value.versionName.length>60||/[\u0000-\u001f\u007f]/.test(value.versionName))invalid();
 if(!integer(value.minSdk,24,100)||!integer(value.targetSdk,value.minSdk,100)||!integer(value.sizeBytes,1,200*1024*1024))invalid();
 if(!digest.test(value.sha256)||!digest.test(value.signingCertificateSha256)||typeof value.sourceCommit!=='string'||!/^[a-f0-9]{40}$/.test(value.sourceCommit))invalid();
 if(value.apkUrl!==releaseAssetUrl(repository,tag,'resqnow.apk'))invalid();
 if(typeof value.publishedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.publishedAt))invalid();
 const date=new Date(value.publishedAt);
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,19)!==value.publishedAt.slice(0,19))invalid();
 return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
