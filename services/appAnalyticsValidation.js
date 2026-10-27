import {isUuid} from '../models/identifiers.js';
const invalid=()=>Object.assign(new Error('Invalid analytics report'),{status:400});
export function validateAnalyticsReport(body,kind){
 if(!body||typeof body!=='object'||Array.isArray(body))throw invalid();
 if(Buffer.byteLength(JSON.stringify(body))>2048)throw Object.assign(invalid(),{status:413});
 const keys=['installationId','installationSecret','consentRevision'];
 if(kind==='report')keys.push('consentPolicyVersion','appId','versionName','versionCode');
 if(Object.keys(body).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(body,k)))throw invalid();
 if(!isUuid(body.installationId)||typeof body.installationSecret!=='string'||!/^[a-f0-9]{64}$/.test(body.installationSecret)||!Number.isSafeInteger(body.consentRevision)||body.consentRevision<1||body.consentRevision>2147483647)throw invalid();
 if(kind==='report'&&(body.appId!=='com.resqnow1.app'||typeof body.versionName!=='string'||body.versionName.length<1||body.versionName.length>40||!Number.isSafeInteger(body.versionCode)||body.versionCode<1||body.versionCode>2147483647||typeof body.consentPolicyVersion!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(body.consentPolicyVersion)))throw invalid();
 return {...body,installationId:body.installationId.toLowerCase()};
}
export function validateAnalyticsQuery(q={}){
 const days=Number(q.days??30),page=Number(q.page??1),limit=Number(q.limit??25),role=q.role??'all',version=q.version??'';
 if(![7,30,90].includes(days)||!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(limit)||limit<1||limit>100||!['all','customer','technician','never-linked','formerly-linked'].includes(role)||typeof version!=='string'||version.length>40)throw invalid();
 return {days,page,limit,role,version};
}
