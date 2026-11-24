import {ApiError} from './core.js';
import {accountReadDatabase} from './admin_accounts.js';
import {activePhoneOperator} from './admin_email_policy.js';
import {reservationMatches} from './admin_burimunsi_observations.js';
import {payerStates,payerReasons} from './burimunsi/payer-outcomes.js';
import {paymentActivitySql} from './admin_payment_activity_sql.js';

const keyPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const statusPattern=/^[a-z][a-z_0-9]{0,63}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const control=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const scopes=new Set(['all','payments','momo','sms','android','captures','attention']);
const filters=new Set(['limit','offset','group','account','search','status','scope','from','to']);
const invalid=()=>{throw new ApiError(400,'invalid_filter','Choose a valid payment activity filter.');};
const denied=()=>{throw new ApiError(403,'permission_required','Payment activity is unavailable for this account.');};
const bad=()=>{throw new ApiError(503,'invalid_source_data','Payment activity could not be verified.');};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeText=v=>typeof v==='string'&&v.trim().length>0&&v.length<=200&&!control.test(v);
const utc=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const numeric=(value,min,max)=>{
 if(!/^(0|[1-9][0-9]*)$/.test(value))invalid();
 const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)invalid();return n;
};
function dayBound(value,nextDay=false) {
 if(value===null)return null;
 if(!/^\d{4}-\d\d-\d\d$/.test(value)||!utc(value+'T00:00:00.000Z'))invalid();
 const time=Date.parse(value+'T00:00:00+02:00')+(nextDay?86400000:0);
 return new Date(time).toISOString();
}
export function activityAccess(account,actor,url) {
 const proof=activePhoneOperator(account);
 if(!proof||actor.userId!==account.principal_id||actor.sessionId!==account.auth_session_id)denied();
 const allowed=permission=>actor.permissions.has(permission);
 const financial=allowed('payments.read'),sms=proof.operatorRole==='admin'&&allowed('sms.read'),reconcile=allowed('reconciliations.read');
 const reconciliationDetail=reconcile&&allowed('users.read'),reveal=sms&&allowed('sms.reveal');
 if(!financial&&!sms&&!reconciliationDetail)denied();
 const p=url.searchParams;
 for(const key of p.keys())if(!filters.has(key)||p.getAll(key).length!==1)invalid();
 const scope=p.get('scope')??'all',status=p.get('status'),term=p.get('search'),wallet=p.get('account'),group=p.get('group');
 if(!scopes.has(scope)||status!==null&&!statusPattern.test(status)||term!==null&&(term.length>200||control.test(term)))invalid();
 if(group!==null&&!keyPattern.test(group)||wallet!==null&&!keyPattern.test(wallet))invalid();
 if(group!==null&&(!allowed('collections.read')||group!==proof.collectionId)||wallet!==null&&!allowed('receivers.read'))denied();
 if(['momo','payments'].includes(scope)&&!financial||['sms','android','captures'].includes(scope)&&!sms||scope==='attention'&&!reconcile)denied();
 const limit=numeric(p.get('limit')??'25',1,100),offset=numeric(p.get('offset')??'0',0,2147483647);
 const from=dayBound(p.get('from')),to=dayBound(p.get('to'),true);
 if(from&&to&&Date.parse(from)>=Date.parse(to))invalid();
 const access={financial,sms,reconciliationDetail,reveal};
 // Re-assert every capability that changed the projection in the transaction
 // that reads it, including permission-specific deep links and filters.
 const grants=[];
 if(financial)grants.push('payments.read');
 if(sms)grants.push('sms.read');
 if(reconcile&&(reconciliationDetail||scope==='attention'))grants.push('reconciliations.read');
 if(reconciliationDetail)grants.push('users.read');
 if(reveal)grants.push('sms.reveal');
 if(group!==null)grants.push('collections.read');
 if(wallet!==null)grants.push('receivers.read');
 return {access,grants,collection:proof.collectionId,limit,offset,args:[proof.collectionId,scope,status==='all'?null:status,
   term?.trim()||null,wallet,from,to,limit,offset]};
}

async function activityReceipt(raw,access,collection) {
 if(!object(raw)||!['capture','receiver_sms'].includes(raw.kind)||!keyPattern.test(raw.id)||!statusPattern.test(raw.status)||
   raw.collectionId!==collection||!(raw.paymentReference===null||access.financial&&/^[0-9]{12}$/.test(raw.paymentReference))||
   !(raw.payerStatus===null||access.financial&&payerStates.has(raw.payerStatus))||
   !(raw.payerReason===null||access.financial&&payerReasons.has(raw.payerReason)))bad();
 const proof=raw.reservation;
 const digest=access.reveal&&raw.kind==='receiver_sms'&&object(proof)&&proof.sourceId===raw.id&&
  digestPattern.test(proof.bodySha256)&&await reservationMatches(proof)?proof.bodySha256:null;
 return {kind:raw.kind,id:raw.id,status:raw.status,collectionId:collection,bodySha256:digest,
   paymentReference:raw.paymentReference,payerStatus:raw.payerStatus,payerReason:raw.payerReason};
}

export async function activityPage(row,{access,limit,offset,collection}) {
 if(!object(row)||!utc(row.as_of)||!Number.isSafeInteger(row.total)||row.total<0||!Array.isArray(row.items)||
   row.items.length!==Math.min(limit,Math.max(0,row.total-offset)))bad();
 const seen=new Set(),sources=new Set(),transfers=new Set();
 function unique(set,key){if(set.has(key))bad();set.add(key);}
 const items=[];
 for(const raw of row.items) {
  if(!object(raw)||!['payment','momo','receiver_sms','capture'].includes(raw.kind)||!keyPattern.test(raw.id)||!utc(raw.occurredAt)||
   !(raw.reference===null||safeText(raw.reference))||!(raw.payer===null||safeText(raw.payer))||
   !(raw.amountRwf===null||Number.isSafeInteger(raw.amountRwf))||!statusPattern.test(raw.status)||typeof raw.attention!=='boolean'||
   !(raw.paymentId===null||access.financial&&raw.kind==='payment'&&raw.paymentId===raw.id)||
   !(raw.reconciliationId===null||access.reconciliationDetail&&raw.kind==='payment'&&raw.reconciliationId===raw.id)||
   !Array.isArray(raw.momoIds)||!Array.isArray(raw.receipts)||!access.sms&&raw.receipts.length||
   !access.financial&&raw.momoIds.length||raw.kind==='payment'&&!access.financial&&!access.reconciliationDetail||
   raw.kind==='momo'&&(!access.financial||!raw.momoIds.includes(raw.id))||
   ['receiver_sms','capture'].includes(raw.kind)&&(!access.sms||raw.receipts.length!==1||
     raw.receipts[0]?.kind!==raw.kind||raw.receipts[0]?.id!==raw.id))bad();
  unique(seen,raw.kind+':'+raw.id);
  for(const id of raw.momoIds){if(!keyPattern.test(id))bad();unique(transfers,id);}
  const receipts=[];
  for(const value of raw.receipts){
   const receipt=await activityReceipt(value,access,collection);unique(sources,receipt.kind+':'+receipt.id);receipts.push(receipt);
  }
  items.push({kind:raw.kind,id:raw.id,occurredAt:raw.occurredAt,reference:raw.reference,payer:raw.payer,amountRwf:raw.amountRwf,
   status:raw.status,attention:raw.attention,paymentId:raw.paymentId,reconciliationId:raw.reconciliationId,momoIds:raw.momoIds,receipts});
 }
 return {contractVersion:1,asOf:row.as_of,limit,offset,total:row.total,items};
}

export async function adminPaymentActivity(env,account,actor,url) {
 const config=activityAccess(account,actor,url),scoped=accountReadDatabase(env,account,config.grants);
 try {
  const [page]=await scoped.DB.batch([scoped.DB.prepare(paymentActivitySql(env,config.access)).bind(...config.args)]);
  if(!Array.isArray(page?.results)||page.results.length!==1)bad();
  return await activityPage(page.results[0],config);
 }catch(error){
  if(error?.code==='42501')denied();
  throw error;
 }
}
