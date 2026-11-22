// One isolated database owns the stable Android receipt, canonical transaction,
// credit, payment notice and scoped Admin outcome. No payer or carrier is called.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import test from 'node:test';
import {startPayerFixture} from './fixtures/burimunsi-payer-postgres.mjs';
import {openFixturePayerWorker} from './fixtures/burimunsi-payer-delivery.mjs';
import {installNativeChain,nativeRuntime,nativeActor,uuid,sha} from './fixtures/burimunsi-native-chain.mjs';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';
import {validateProviderProfile,MOMO_SCHEMA_VERSION} from '../../../supabase/functions/_shared/domain/momo_pipeline.js';
import {decrypt} from '../../../supabase/functions/_shared/domain/encryption.js';
import {canonicalJson} from '../../../supabase/functions/_shared/domain/burimunsi/values.js';
import {createPhonePinRequestGate,PIN_CONTEXT_SQL} from '../../../supabase/functions/_shared/domain/burimunsi/phone-pin-request.js';
import {createNativeHandler} from '../../../supabase/functions/_shared/domain/burimunsi/http.js';
import {validateObservationInput} from '../../../supabase/functions/_shared/domain/burimunsi/observation-evidence.js';
import {PostgresNativeObservations} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-observations.js';
import {PostgresNativeAutoWorker} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-native-auto-worker.js';
import {PostgresNativeSmsLedger} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-native-sms-ledger.js';

const group=uuid(15),member=uuid(16),phone='+250780000001',origin='https://fixture.invalid';
const masked={requestId:'a6d27d6d-62a7-4573-bae9-cd8c6fd5982f',rawSender:'+15555219877',
 rawBody:'You have received 1000 RWF from EXAMPLE (*****001) at 2026-11-22 15:00:00. Balance: 2000 RWF. FT Id: 987654321.',
 sourceMode:'catch_up',complete:false,capturedAt:'2026-11-22T15:08:13.317Z',serviceCentreAt:'2026-11-22T15:07:22Z',
 inboxReceivedAt:'2026-11-22T15:07:22.825Z',subscriptionId:1,sourceKey:'b8f86207e8aa135a0171f8a1e0bc69a7d7cd2ad3c74fda971223dbdaaf25d4a2'};
async function phoneWire(path,fallback){
 if(!path)return [fallback,fallback];
 const {uploads,handset}=JSON.parse(await readFile(path,'utf8'));
 assert.equal(uploads.length,2);assert.deepEqual(uploads[0],uploads[1]);
 assert.equal(uploads[0].rawBody,handset.body);assert.equal(uploads[0].rawSender,handset.address);
 assert.equal(uploads[0].inboxReceivedAt,new Date(handset.date).toISOString());return uploads;
}
function fullWire(){
 // Run at the current test clock so future runs exercise the configured
 // recent-receipt window. A saved emulator capture can be replayed unchanged.
 const at=new Date(Date.now()-15_000),stamp=new Date(at.getTime()+7200000).toISOString().slice(0,19).replace('T',' ');
 return {...masked,requestId:uuid(12),sourceKey:sha('fresh full payer '+at),
  capturedAt:at.toISOString(),inboxReceivedAt:at.toISOString(),serviceCentreAt:at.toISOString(),
  rawBody:`You have received 1000 RWF from EXAMPLE (${phone}) at ${stamp}. Balance: 2000 RWF. FT Id: 987654322.`};
}
function providerOutput(body){
 const match=/^You have received ([\d,]+) RWF from (.+?) \(([^)]+)\) at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\. Balance: ([\d,]+) RWF\. FT Id: ([0-9]+)\.$/.exec(body);
 assert.ok(match,'the fixture provider only recognizes its two synthetic receipts');
 const [,amount,name,identifier,time,balance,reference]=match;
 return {schema_version:MOMO_SCHEMA_VERSION,event_kind:'incoming_receipt',payment_outcome:'successful',transaction_id_raw:reference,
  original_transaction_id_raw:null,transaction_datetime_raw:time,principal_amount_raw:amount,currency_raw:'RWF',payer_name_raw:name,payer_identifier_raw:identifier,
  payment_reference_raw:null,fee_amount_raw:null,wallet_balance_after_raw:balance+' RWF',issues:[],
  evidence:{incoming_success:'You have received',principal:'You have received '+amount+' RWF',transaction_id:'FT Id: '+reference,
    transaction_datetime:'at '+time,payer:'from '+name+' ('+identifier+')',fee:null,wallet_balance_after:'Balance: '+balance+' RWF'}};
}
function receiptFixture(f){
 const {run,env,journal,objects}=nativeRuntime(f.client,group),a=nativeActor(group),work={assert:async()=>{}};
 const actor={id:a.accountId,sessionId:a.sessionId,principalUserId:a.principalUserId,installationId:a.installationId,
  groupId:group,role:'admin',installationProfile:'internal_receiver',capabilities:['records.read','sms.read','gateway.manage'],
  active:true,revoked:false,expiresAt:Date.now()+1800000};
 const pinRow={collection_id:group,principal_user_id:a.principalUserId,native_session_id:a.sessionId,account_id:a.accountId,installation_id:a.installationId,
  profile:actor.installationProfile,role:actor.role,capabilities:actor.capabilities,created_at:Date.now()-1000,expires_at:actor.expiresAt};
 const db={applicationWork:work,setClaims(){},context:async()=>{},readContext:async()=>{},transaction:fn=>fn({unsafe:async(sql)=>{
  if(sql===PIN_CONTEXT_SQL)return [pinRow];assert.ok(sql.startsWith('SET TRANSACTION'));return [];
 }})};
 env.DB=db;env.BURIMUNSI_PAYMENT_SMS_ENABLED="true";env.BURIMUNSI_PAYMENT_SMS_COLLECTION_ID=group;
 const authority={db,groupId:group,read:run('http_collect'),write:run('http_collect'),session:async()=>actor,assertOwned:work.assert};
 const custody={namespace:env.PRIVATE_MEDIA.namespace,journal,sameJournal:(x,y)=>canonicalJson(x)===canonicalJson(y),decrypt:(sealed,aad)=>decrypt(env,sealed,aad)};
 const witnesses={stage:async(_binding,targets)=>targets,prefetch:async targets=>{for(const target of targets)assert.ok(objects.has(target.key));},
  sealed:async(_binding,key)=>{assert.ok(objects.has(key));return objects.get(key).sealed;},forget(){}};
 const authGate=createPhonePinRequestGate({origin,secrets:{pinPepper:new Uint8Array(32),pinPepperId:'fixture'},networkBucket:async()=>sha('network')});
 const unused=()=>assert.fail('unexpected command');
 const route=async(path,payload)=>{
  const request=new Request(origin+'/v1/burimunsi/sms/observations'+path,{method:payload===undefined?'GET':'POST',headers:{'x-burimunsi-installation':a.installationId,
   'x-burimunsi-auth':'phone_pin','x-burimunsi-device':'d'.repeat(64),'x-burimunsi-profile':'internal_receiver','x-burimunsi-group':group,
   'x-burimunsi-contract':'burimunsi.native.v1','x-burimunsi-generation':'1','x-burimunsi-request':randomUUID(),authorization:'Bearer '+'a'.repeat(64),
   'content-type':'application/json'},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
  return authGate({request,env},async()=>{
   const observations=new PostgresNativeObservations({authority,env,validateProviderProfile,custody,storageWitnesses:witnesses});
   const handler=createNativeHandler({auth:{authenticate:async()=>actor,login:unused,logout:unused,changePasscode:unused,manageStaff:unused},
    records:{home:unused,page:unused,detail:unused,exportLedger:unused,commandStatus:unused},contributions:{allocate:unused},
    members:{enroll:unused,setActive:unused},gateway:{status:unused,replace:unused},observations,origin,groupId:group,strictContract:true,
    verifiedObservationStatusEnabled:true,networkBucket:unused});
   const response=await handler(request),reply=await response.json();assert.equal(response.status,200,JSON.stringify(reply));return reply.data;
  });
 };
 const jobAuthority={write:run('jobs')};
 let output;
 const parser=Object.assign(Object.create(PostgresNativeAutoWorker.prototype),{
  env:{...env,MOMO_AI_ENABLED:'true',MOMO_AI_MODEL:'synthetic-provider',AI:{run:async()=>({response:output})}},
  authority:jobAuthority,custody,witnesses,
  // Production plan checks the journal digest calculated on encrypted admission.
  groupId:group
 });
 const ledger=Object.assign(Object.create(PostgresNativeSmsLedger.prototype),{worker:parser,authority:jobAuthority,env,groupId:group,
  db:{prepare:sql=>({bind:(...values)=>({sql,values})}),statement:async(tx,statement)=>{
   const {text,values}=compileSql(statement.sql,statement.values);return tx.unsafe(text,values);
  }}});
 return {route,parser,ledger,provider:(body)=>{output=providerOutput(body);}};
}

test('ordinary Android replay posts once, explicitly suppresses the masked payer and delivers the fully proven payer obligation to scoped Admin',async t=>{
 const maskedUploads=await phoneWire(process.env.BURIMUNSI_MASKED_WIRE,masked);
 const fullUploads=await phoneWire(process.env.BURIMUNSI_FULL_WIRE,fullWire());
 const f=await startPayerFixture(t,{groupId:group,memberId:member,phoneNumber:phone,enabledAgo:86400000,
  beforeNoticeMigration:client=>installNativeChain(client,group)});
 await f.client.query('UPDATE app.users SET full_name=$1 WHERE id=$2',['EXAMPLE',member]);
 await f.client.query("INSERT INTO app.admin_grants VALUES('principal','sms.read'),('principal','payments.read')");
 await f.client.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
 const flow=receiptFixture(f),sources=[],proofs=[],timeline=[],start=performance.now();
 const mark=(receipt,stage)=>timeline.push({receipt,stage,elapsedMs:Number((performance.now()-start).toFixed(3))});
 const startedAt=new Date().toISOString();
 for(const [uploads,ref] of [[fullUploads,'987654322'],[maskedUploads,'987654321']]){
  const [input,replay]=uploads;
  mark(ref,'receive');assert.deepEqual(validateObservationInput(input),input);mark(ref,'normalize');
  const retained=await flow.route('',input),resent=await flow.route('',replay);
  assert.equal(retained.status,'source_unresolved');assert.equal(retained.financialEffects,0);assert.deepEqual(resent,retained);mark(ref,'retain_and_replay');
  const proof={sourceKey:input.sourceKey,bodySha256:sha(input.rawBody),rawSender:input.rawSender,serviceCentreAt:input.serviceCentreAt,
   inboxReceivedAt:input.inboxReceivedAt,subscriptionId:input.subscriptionId};
  proofs.push(proof);
  const page=await flow.route('/reconcile-batch',{items:[proof]});
  assert.deepEqual(page.items,[{sourceKey:input.sourceKey,state:'matched',sourceId:retained.sourceId}]);
  const pending=await flow.route('/processing-status',{sourceIds:[retained.sourceId]});
  assert.equal(pending.statuses[0].status,'pending');
  flow.provider(input.rawBody);
  assert.deepEqual(await flow.parser.process(retained.sourceId),{state:'completed',relation:'accepted'});
  assert.deepEqual(await flow.parser.process(retained.sourceId),{state:'completed'});mark(ref,'parsed');
  assert.equal((await flow.route('/processing-status',{sourceIds:[retained.sourceId]})).statuses[0].status,'parsed');
  assert.deepEqual(await flow.ledger.process(retained.sourceId),{state:'posted'});
  mark(ref,'posted');assert.deepEqual(await flow.ledger.process(retained.sourceId),{state:'already_posted'});
  const rows=(await f.client.query(`SELECT p.id AS payment_id,l.id AS ledger_id,s.member_balance_after_minor AS balance
   FROM private.burimunsi_auto_sms_jobs j JOIN app.momo_transactions t ON t.id=j.transaction_id
   JOIN app.momo_financial_links f ON f.transaction_id=t.id JOIN app.payments p ON p.id=f.payment_id
   JOIN app.ledger_entries l ON l.payment_id=p.id AND l.kind='contribution'
   JOIN app.contribution_posting_snapshots s ON s.ledger_entry_id=l.id
   WHERE j.source_id=$1 AND t.provider_transaction_id=$2 AND p.member_id=$3 AND p.amount_minor=1000`,[retained.sourceId,ref,member])).rows;
  assert.equal(rows.length,1);sources.push({...rows[0],source:retained.sourceId,ref});
  const obligations=(await f.client.query('SELECT disposition FROM private.burimunsi_payment_sms_obligations WHERE payment_id=$1 AND ledger_entry_id=$2',[rows[0].payment_id,rows[0].ledger_id])).rows;
  assert.equal(obligations.length,1);if(ref==='987654322')assert.equal(obligations[0].disposition,'eligible');mark(ref,'notice_'+obligations[0].disposition);
 }
 const byPhone=proofs.toSorted((a,b)=>Date.parse(a.inboxReceivedAt)-Date.parse(b.inboxReceivedAt)),latest=byPhone.at(-1).sourceKey;
 const check={runId:randomUUID(),expectedConsentGeneration:1,state:'checking',candidateCount:0,missingCount:0,pendingCount:0,
  phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null};
 await flow.route('/inbox-check',check);
 for(const item of byPhone)assert.equal((await flow.route('/reconcile-batch',{runId:check.runId,items:[item]})).items[0].state,'matched');
 const census=await flow.route('/reconcile-verified-status');
 assert.equal(census.recordedCount,2);
 await flow.route('/inbox-check',{...check,state:'verified',candidateCount:2,phoneLatestKey:latest,parsedLatestKey:latest,collectionRevision:census.revision});
 const adminInbox=await f.rpc('burimunsi_observation_admin_inbox_check',[group],['text'],'http_admin');
 assert.equal(adminInbox.state,'verified');assert.equal(adminInbox.headsMatch,true);mark('both','verified_phone_and_parsed_heads');
 const worker=await openFixturePayerWorker({client:f.client,collectionId:group,enabledAt:f.enabledAt,applicationId:f.app});
 t.after(()=>worker.complete());
 const first=await worker.drain();assert.equal(first.processed,1);
 assert.equal(worker.submitted.to,phone);assert.match(worker.submitted.text,/1[ ,.\u00a0]?000/);
 assert.equal(Number(sources[0].balance),1000);assert.equal(Number(sources[1].balance),2000);
 assert.doesNotMatch(worker.submitted.text,/2[ ,.\u00a0]?000/);
 assert.deepEqual(worker.requests,['POST']);
 const attempt=(await f.client.query('SELECT attempt_id,message_id,payment_id,ledger_entry_id FROM private.burimunsi_payment_sms_deliveries')).rows;
 assert.equal(attempt.length,1);assert.equal(attempt[0].payment_id,sources[0].payment_id);assert.equal(attempt[0].ledger_entry_id,sources[0].ledger_id);
 assert.equal(attempt[0].message_id,worker.submitted.message_id);
 mark('987654322','submit_lost_response');await worker.carrierDelivered();mark('987654322','simulated_carrier_callback');
 const settled=await worker.drain();assert.equal(settled.gateway_state,'delivered');mark('987654322','provider_confirmed');assert.deepEqual(worker.requests,['POST','GET']);
 assert.equal((await worker.drain()).processed,0);
 const admin=g=>f.rpc('burimunsi_admin_observation_outcomes',[g,sources.map(s=>s.source),true],['text','text[]','boolean'],'http_admin');
 const detail=await admin(group);
 assert.equal(detail.length,2);
 for(const [i,source] of sources.entries()){
  const row=detail.find(item=>item.sourceId===source.source);assert.ok(row,source.source);assert.equal(row.processing,'posted');
  const {rows:[payment]}=await f.client.query('SELECT payment_reference::text FROM app.payments WHERE id=$1',[source.payment_id]);
  assert.equal(row.paymentReference,payment.payment_reference);
  assert.equal(row.payerStatus,i===0?'delivered':'suppressed');
 }
 await assert.rejects(()=>admin('unowned-collection'),{code:'42501'});mark('both','scoped_admin_outcomes');
 if(process.env.BURIMUNSI_CHAIN_PROOF){
  const proof={startedAt,environment:'Isolated PG17 with synthetic member and object storage, deterministic provider extraction, simulated SMS gateway and carrier multipart callback.',
   handsetInputs:process.env.BURIMUNSI_MASKED_WIRE&&process.env.BURIMUNSI_FULL_WIRE?'Two saved Android emulator inbox captures, uploaded twice each.':'Clocked synthetic regression inputs.',
   timeBasis:'Monotonic milliseconds since these saved inputs entered the isolated test. Handset acquisition and physical-network time are outside this clock.',
   receipts:sources.map(({ref,source,payment_id,ledger_id,balance},i)=>({syntheticProviderReference:ref,creditedOnce:true,
    sourceSha256:sha(source),paymentSha256:sha(payment_id),ledgerSha256:sha(ledger_id),postBalanceRwf:Number(balance),
    notice:detail.find(d=>d.sourceId===source).payerStatus})),gatewayRequests:worker.requests,adminScopeCheck:'denied other group',
   inbox:{state:adminInbox.state,headsMatch:adminInbox.headsMatch,candidateCount:adminInbox.candidateCount,missingCount:adminInbox.missingCount,pendingCount:adminInbox.pendingCount},
   stages:timeline};
  await writeFile(process.env.BURIMUNSI_CHAIN_PROOF,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 }
});
