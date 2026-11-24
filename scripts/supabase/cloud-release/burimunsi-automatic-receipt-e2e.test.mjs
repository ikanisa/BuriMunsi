// One isolated database owns the stable Android receipt, canonical transaction,
// credit, payment notice and scoped Admin outcome. No payer or carrier is called.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {startPayerFixture} from './fixtures/burimunsi-payer-postgres.mjs';
import {openFixturePayerWorker} from './fixtures/burimunsi-payer-delivery.mjs';
import pg from '../node_modules/pg/lib/index.js';
import {installNativeChain,installHandsetInventory,nativeRuntime,nativeActor,uuid,sha,testProfile} from './fixtures/burimunsi-native-chain.mjs';
import {assignPayment,readPaymentAnalysisRows,PAYMENT_ANALYSIS_LIMIT} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payments.js';
import {lockCollectMutation} from '../../../supabase/functions/_shared/postgres-mutation-lock.js';
import {body as stripFraming} from './migrations.mjs';
import {readPaymentSmsEvidence} from '../../../supabase/functions/_shared/domain/admin_burimunsi_observations.js';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';
import {validateProviderProfile,MOMO_SCHEMA_VERSION} from '../../../supabase/functions/_shared/domain/momo_pipeline.js';
import {decrypt} from '../../../supabase/functions/_shared/domain/encryption.js';
import {canonicalJson} from '../../../supabase/functions/_shared/domain/burimunsi/values.js';
import {createPhonePinRequestGate,PIN_CONTEXT_SQL} from '../../../supabase/functions/_shared/domain/burimunsi/phone-pin-request.js';
import {createNativeHandler} from '../../../supabase/functions/_shared/domain/burimunsi/http.js';
import {validateObservationInput} from '../../../supabase/functions/_shared/domain/burimunsi/observation-evidence.js';
import {PostgresNativeObservations} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-observations.js';
import {PostgresNativeAutoWorker} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-native-auto-worker.js';
import {NATIVE_AUTO_SCHEMA_VERSION} from '../../../supabase/functions/_shared/domain/burimunsi/native-auto-parser.js';
import {PostgresNativeSmsLedger} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-native-sms-ledger.js';
import {PostgresPostingCustody} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-posting-custody.js';
import {PostgresStorageWitnesses} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-storage-witnesses.js';

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
function receiptFixture(f,a=nativeActor(group),{standalone=false,runtime=nativeRuntime(f.client,group)}={}){
 const {run,journal,objects}=runtime,env={...runtime.env},work={assert:async()=>{}};
 const actor={id:a.accountId,sessionId:a.sessionId,principalUserId:a.principalUserId,installationId:a.installationId,
  groupId:group,role:'admin',installationProfile:'internal_receiver',capabilities:['records.read','sms.read','gateway.manage'],
  active:true,revoked:false,expiresAt:Date.now()+1800000};
 const pinRow={collection_id:group,principal_user_id:a.principalUserId,native_session_id:a.sessionId,account_id:a.accountId,installation_id:a.installationId,
  profile:actor.installationProfile,role:actor.role,capabilities:actor.capabilities,created_at:Date.now()-1000,expires_at:actor.expiresAt};
 const db={applicationWork:work,setClaims(){},context:async()=>{},readContext:async()=>{},transaction:fn=>fn({unsafe:async(sql)=>{
  if(sql===PIN_CONTEXT_SQL)return [pinRow];assert.ok(sql.startsWith('SET TRANSACTION'));return [];
 }})};
 env.DB=db;env.BURIMUNSI_PAYMENT_SMS_ENABLED="true";env.BURIMUNSI_PAYMENT_SMS_COLLECTION_ID=group;
 if(standalone)env.BURIMUNSI_PRODUCT_MODE='standalone';
 const routeTest={lock:false,revoked:false,sqlState:null};
 const authority={db,groupId:group,read:run('http_collect',{readOnly:true}),
  write:fn=>run('http_collect')(async tx=>{
   if(routeTest.lock){
    await tx.unsafe("SET LOCAL lock_timeout='250ms'");
    try{await lockCollectMutation(tx);}catch(error){routeTest.sqlState=error.code;throw error;}
   }
   return fn(tx);
  }),session:async()=>({...actor,revoked:routeTest.revoked}),assertOwned:work.assert};
 const custody={namespace:env.PRIVATE_MEDIA.namespace,journal,sameJournal:(x,y)=>canonicalJson(x)===canonicalJson(y),decrypt:(sealed,aad)=>decrypt(env,sealed,aad)};
 const pageCustody=new PostgresPostingCustody({db,groupId:group,namespace:custody.namespace,decrypt:custody.decrypt,
  storageWitnesses:new PostgresStorageWitnesses({db,groupId:group,namespace:custody.namespace,media:env.PRIVATE_MEDIA,
   applicationWorkTuple:()=>[uuid(888),1,'a'.repeat(64)]})});
 custody.keyedObservationJournal=pageCustody.keyedObservationJournal.bind(pageCustody);
 custody.keyedObservationJournals=pageCustody.keyedObservationJournals.bind(pageCustody);
 let externalFetches=0,providerCalls=0;
 const witnesses={stage:async(_binding,targets)=>targets,prefetch:async targets=>{externalFetches++;for(const target of targets)assert.ok(objects.has(target.key));},
  sealed:async(_binding,key)=>{assert.ok(objects.has(key));return objects.get(key).sealed;},forget(){}};
 const authGate=createPhonePinRequestGate({origin,secrets:{pinPepper:new Uint8Array(32),pinPepperId:'fixture'},networkBucket:async()=>sha('network')});
 const unused=()=>assert.fail('unexpected command');
 const route=async(path,payload,expected=200)=>{
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
   const response=await handler(request),reply=await response.json();assert.equal(response.status,expected,JSON.stringify(reply));return expected===200?reply.data:reply;
  });
 };
 const jobAuthority={write:run('jobs')};
 let output;
 const parser=Object.assign(Object.create(PostgresNativeAutoWorker.prototype),{
  env:{...env,MOMO_AI_ENABLED:'true',MOMO_AI_MODEL:'synthetic-provider',AI:{run:async()=>{providerCalls++;return {response:output};}}},
  authority:jobAuthority,custody,witnesses,
  // Production plan checks the journal digest calculated on encrypted admission.
  groupId:group
 });
 const ledger=Object.assign(Object.create(PostgresNativeSmsLedger.prototype),{worker:parser,authority:jobAuthority,env,groupId:group,
  db:{prepare:sql=>({bind:(...values)=>({sql,values})}),statement:async(tx,statement)=>{
   const {text,values}=compileSql(statement.sql,statement.values);return tx.unsafe(text,values);
  }}});
 return {route,routeTest,parser,ledger,pageCustody,provider:(body)=>{output=typeof body==='string'?providerOutput(body):body;},
  counts:()=>({providerCalls,externalFetches})};
}

test('standalone capture commits encrypted SMS and records incoming and outgoing once without financial side effects',async t=>{
 const f=await startPayerFixture(t,{groupId:group,memberId:member,phoneNumber:phone,
  beforeNoticeMigration:client=>installNativeChain(client,group)});
 const load=name=>readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');
 const [oldJobs,wakes,idle,central,record,allocation,live,review]=await Promise.all([
  '20261112200100_burimunsi_native_auto_transactions.sql','20261122191300_burimunsi_event_driven_jobs.sql',
  '20261124091329_burimunsi_idle_native_jobs.sql','20261124114500_burimunsi_payments.sql',
  '20261124114501_burimunsi_record_payments.sql','20261124114502_burimunsi_allocation_receipts.sql',
  '20261122191400_burimunsi_admin_realtime.sql'].map(load)
  .concat(readFile(new URL('./native-parser-review-preimage.sql',import.meta.url),'utf8')));
 const stateCheck=oldJobs.slice(oldJobs.indexOf(" CHECK((state='processing'"),oldJobs.indexOf('\n);\nALTER TABLE private.burimunsi_auto_sms_jobs')).trim();
 const wakeBody=wakes.slice(wakes.indexOf('CREATE FUNCTION private._burimunsi_wake_sms_worker'),wakes.indexOf('CREATE OR REPLACE FUNCTION collect_ops.tick_jobs()'));
 const idleBody=idle.slice(idle.indexOf('CREATE FUNCTION private.burimunsi_native_job_candidates'),idle.indexOf('COMMIT;'));
 await f.client.query(`
  SET SESSION AUTHORIZATION postgres;
  CREATE ROLE collect_sms_runtime;
  ALTER TABLE app.memberships ADD UNIQUE(collection_id,user_id);
  UPDATE collect_ops.jobs_config SET enabled=false; UPDATE cron.job SET active=false;
  CREATE TABLE private.burimunsi_sms_wakes(event_xid xid8,wake_class smallint DEFAULT 0,
    due_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(event_xid,wake_class));
  CREATE TABLE private.collect_fence_admissions(admission_id uuid,kind text,epoch bigint,source_sha256 text);
  CREATE OR REPLACE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('role',true) IS DISTINCT FROM 'collect_runtime' OR current_setting('collect.edge_verified',true) IS DISTINCT FROM 'true'
      THEN RAISE insufficient_privilege; END IF; END $$;
  CREATE FUNCTION private._collect_fence_admission(uuid,bigint,text) RETURNS private.collect_fence_admissions LANGUAGE sql AS $$
    SELECT $1,current_setting('test.work_kind',true),$2,$3 WHERE $1 IS NOT NULL AND $2=1 AND $3=repeat('a',64) $$;
  CREATE FUNCTION private.collect_fence_assert_write(uuid,bigint,text) RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN IF $1 IS NULL OR $2 IS DISTINCT FROM 1 OR $3 IS DISTINCT FROM repeat('a',64) THEN RAISE insufficient_privilege; END IF;
    RETURN '{}'::jsonb; END $$;
  ALTER TABLE private.burimunsi_auto_sms_jobs ADD CONSTRAINT burimunsi_auto_sms_jobs_state_check
    CHECK (state IN ('processing','retry','failed','completed','security_message'));
  ALTER TABLE private.burimunsi_auto_sms_jobs ADD CONSTRAINT fixture_auto_job_shape ${stateCheck};
  CREATE FUNCTION private.burimunsi_native_sms_post_defer(text,integer) RETURNS boolean LANGUAGE sql AS $$SELECT true$$;
  CREATE FUNCTION private.burimunsi_native_sms_post_retry(text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
  REVOKE EXECUTE ON FUNCTION private.burimunsi_native_sms_post_defer(text,integer),
    private.burimunsi_native_sms_post_retry(text,text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.burimunsi_native_sms_post_defer(text,integer),
    private.burimunsi_native_sms_post_retry(text,text) TO collect_runtime;
 `);
 await f.client.query(wakeBody);
 await f.client.query(idleBody);
 await f.client.query(review.slice(review.indexOf('CREATE OR REPLACE FUNCTION collect_ops.reconcile_jobs()')));
 const runtime=nativeRuntime(f.client,group);
 const archivedFlow=receiptFixture(f,undefined,{runtime});
 const archivedInput={...masked,requestId:uuid(799),sourceKey:sha('archived original receipt'),
  rawBody:masked.rawBody.replace('987654321','987654320')};
 const archived=await archivedFlow.route('',archivedInput);
 archivedFlow.provider(archivedInput.rawBody);
 assert.deepEqual(await archivedFlow.parser.process(archived.sourceId),{state:'completed',relation:'accepted'});
 const [{transaction_id:archivedPayment}]=(await f.client.query('SELECT transaction_id FROM private.burimunsi_auto_sms_jobs WHERE source_id=$1',
  [archived.sourceId])).rows;
 await f.client.query("UPDATE private.burimunsi_auto_sms_jobs SET posting_last_error='legacy posting issue' WHERE source_id=$1",[archived.sourceId]);
 const versionOne='20261124114500',versionTwo='20261124114501';
 await f.client.query('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,name text,statements text[])');
 const journal=async(version,name,sql)=>f.client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)',[version,name,[sql]]);
 const state=async (client)=>(await client.query(`SELECT
   to_regclass('burimunsi.payments') IS NOT NULL AS payments,
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='app.ledger_entries'::regclass AND tgname='burimunsi_payments_only') AS legacy_block,
   EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='private.burimunsi_auto_sms_jobs'::regclass AND attname='payment_id' AND NOT attisdropped) AS new_writer,
   (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS journal_rows,
   (SELECT count(*)::int FROM app.ledger_entries) AS credits,
   (SELECT count(*)::int FROM private.burimunsi_auto_sms_jobs) AS work`)).rows[0];
 const legacyProbe=client=>client.query('INSERT INTO app.ledger_entries(id,collection_id) VALUES($1,$2)',[uuid(990),group]);
 const pre=await state(f.client);
 assert.deepEqual(pre,{payments:false,legacy_block:false,new_writer:false,journal_rows:0,credits:pre.credits,work:pre.work});
 await f.client.query('BEGIN');
 try{
  await legacyProbe(f.client);
  await f.client.query('ROLLBACK');
 }catch(e){await f.client.query('ROLLBACK');throw e;}
 await f.client.query('BEGIN');
 try{
  await f.client.query(central);
  await journal(versionOne,'burimunsi_payments',central);
  await f.client.query('UPDATE collect_ops.jobs_config SET singleton=true, enabled=true');
  await assert.rejects(f.client.query(stripFraming(record)),{code:'55000',message:'burimunsi_payment_record_requires_fence'});
 }finally{await f.client.query('ROLLBACK');}
 assert.deepEqual(await state(f.client),pre);
 const cutoverPeer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await cutoverPeer.connect();await cutoverPeer.query('SET ROLE postgres');
 try{
  if(process.env.BURI_F03_SPLIT_FIXTURE==='1'){
   await f.client.query('BEGIN');await f.client.query(central);await journal(versionOne,'burimunsi_payments',central);await f.client.query('COMMIT');
   const split={...pre,payments:true,legacy_block:true,journal_rows:1};
   assert.deepEqual(await state(cutoverPeer),split);
   await assert.rejects(legacyProbe(cutoverPeer),{code:'55000',message:'burimunsi_payments_only'});
   await f.client.query('UPDATE collect_ops.jobs_config SET singleton=true,enabled=true');
   await assert.rejects(f.client.query(record),{code:'55000',message:'burimunsi_payment_record_requires_fence'});
   await f.client.query('ROLLBACK');
   assert.deepEqual(await state(cutoverPeer),split);
   await f.client.query('UPDATE collect_ops.jobs_config SET enabled=false');
  }
  await f.client.query('BEGIN');
  if(process.env.BURI_F03_SPLIT_FIXTURE!=='1'){
   await f.client.query(central);await journal(versionOne,'burimunsi_payments',central);
  }
  await f.client.query(stripFraming(record));await journal(versionTwo,'burimunsi_record_payments',record);
  assert.equal((await cutoverPeer.query(
   "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='private.burimunsi_auto_sms_jobs'::regclass AND attname='payment_id' AND NOT attisdropped) AS visible")).rows[0].visible,false);
  await f.client.query('COMMIT');
  assert.deepEqual(await state(cutoverPeer),{...pre,payments:true,legacy_block:true,new_writer:true,journal_rows:2});
  await assert.rejects(legacyProbe(cutoverPeer),{code:'55000',message:'burimunsi_payments_only'});
  const entries=(await f.client.query('SELECT version,cardinality(statements) n,statements[1] AS original FROM supabase_migrations.schema_migrations ORDER BY version')).rows;
  assert.deepEqual(entries,[{version:versionOne,n:1,original:central},{version:versionTwo,n:1,original:record}]);
 }finally{await f.client.query('ROLLBACK');await cutoverPeer.end();}
 t.diagnostic(process.env.BURI_F03_SPLIT_FIXTURE==='1'?'F03: committed half-cutover blocked an older ledger writer while replacement recovery remained gated.':'F03: failed cohort rolled back history/DDL; successful cohort published both together.');
 // Use the production change trigger. The external Realtime transport is inert in this database.
 await f.client.query("CREATE FUNCTION private._burimunsi_admin_live_publish(text) RETURNS void LANGUAGE sql AS 'SELECT'");
 await f.client.query(live.slice(live.indexOf('CREATE FUNCTION private._burimunsi_admin_live_change()'),
   live.indexOf('REVOKE ALL ON FUNCTION private._burimunsi_admin_live_publish')));
 const flow=receiptFixture(f,undefined,{standalone:true,runtime});
 const outgoingClause='Your payment of RWF 250 to Example Shop has been completed';
 const outgoingBody=outgoingClause+'. FT Id: 12345007.';
 const outgoing={...providerOutput(masked.rawBody),schema_version:NATIVE_AUTO_SCHEMA_VERSION,wallet_effect:'debit',
  event_kind:'outgoing',transaction_id_raw:'12345007',transaction_datetime_raw:null,principal_amount_raw:'250',
  payer_name_raw:'Example Shop',payer_identifier_raw:null,wallet_balance_after_raw:null,
  evidence:{incoming_success:outgoingClause,principal:'Your payment of RWF 250',transaction_id:'FT Id: 12345007',
   transaction_datetime:null,payer:'to Example Shop',fee:null,wallet_balance_after:null}};
 const notice={...outgoing,event_kind:'other',wallet_effect:'none',payment_outcome:'unknown',transaction_id_raw:null,
  principal_amount_raw:null,currency_raw:null,payer_name_raw:null,
  evidence:{incoming_success:null,principal:null,transaction_id:null,transaction_datetime:null,payer:null,fee:null,wallet_balance_after:null}};
 const samples=[
  [masked.rawBody,{...providerOutput(masked.rawBody),schema_version:NATIVE_AUTO_SCHEMA_VERSION,wallet_effect:'credit'},{state:'completed',relation:'accepted'}],
  [outgoingBody,outgoing,{state:'completed',relation:'accepted'}],
  [outgoingBody+' Thank you.',outgoing,{state:'completed',relation:'duplicate'}],
  ['Our services are available today.',notice,{state:'non_payment'}],
 ];
 const saved=[],captured=[archivedInput];
 for(const [index,[body,output,result]] of samples.entries()){
  const input={...masked,requestId:uuid(800+index),sourceKey:sha('receipt:'+index),rawBody:body};
  captured.push(input);
  const source=await flow.route('',input);saved.push(source.sourceId);
  assert.deepEqual(await flow.route('',input),source);
  const [row]=(await f.client.query(`SELECT r.object_sha256,encode(sha256(r.ciphertext),'hex') AS encrypted_sha256,
     o.sha256 AS storage_sha256,convert_from(r.ciphertext,'UTF8') AS envelope
    FROM burimunsi.raw_sms r JOIN private.storage_objects o ON o.object_key='sms/'||r.id WHERE r.id=$1`,[source.sourceId])).rows;
  assert.ok(row);assert.equal(row.encrypted_sha256,row.storage_sha256);
  assert.equal(row.envelope.includes(body),false);
  const plaintext=await decrypt({DATA_KEY_ID:'fixture-key',DATA_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},
   row.envelope,`sms:${source.sourceId}:${row.object_sha256}`);
  assert.equal(JSON.parse(Buffer.from(plaintext)).raw_body,body);
  flow.provider(output);
  assert.deepEqual(await flow.parser.process(source.sourceId),result);
  assert.deepEqual(await flow.parser.process(source.sourceId),result);
 }
 assert.deepEqual(flow.counts(),{providerCalls:4,externalFetches:0});
 const {rows:payments}=await f.client.query(`SELECT id,direction,amount_rwf::int,provider_reference,allocation_state
  FROM burimunsi.payments ORDER BY direction,provider_reference`);
 assert.deepEqual(payments,[
  {id:archivedPayment,direction:'incoming',amount_rwf:1000,provider_reference:'987654320',allocation_state:'unallocated'},
  {id:saved[0],direction:'incoming',amount_rwf:1000,provider_reference:'987654321',allocation_state:'unallocated'},
  {id:saved[1],direction:'outgoing',amount_rwf:250,provider_reference:'12345007',allocation_state:'unallocated'},
 ]);
 const {rows:jobs}=await f.client.query(`SELECT state,payment_id,transaction_id FROM private.burimunsi_auto_sms_jobs
  WHERE source_id=ANY($1::text[]) ORDER BY array_position($1::text[],source_id)`,[saved]);
 assert.deepEqual(jobs,[
  {state:'completed',payment_id:saved[0],transaction_id:null},{state:'completed',payment_id:saved[1],transaction_id:null},
  {state:'completed',payment_id:saved[1],transaction_id:null},{state:'non_payment',payment_id:null,transaction_id:null},
 ]);
 assert.deepEqual((await f.client.query(`SELECT (SELECT count(*) FROM app.ledger_entries)::int ledger,
  (SELECT count(*) FROM app.payments)::int legacy,(SELECT count(*) FROM app.momo_transactions)::int canon,
  (SELECT count(*) FROM private.burimunsi_payment_sms_obligations)::int notices`)).rows,
  [{ledger:0,legacy:0,canon:1,notices:0}]);
 const ids=[archived.sourceId,...saved],statuses=['parsed','parsed','parsed','duplicate','parsed'];
 const statusesResponse=await flow.route('/processing-status',{sourceIds:ids});
 assert.deepEqual(statusesResponse.statuses,ids.map((sourceId,i)=>({sourceId,status:statuses[i],canRetry:false})));
 await f.client.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
 const admin=async (collection=group)=>f.rpc('burimunsi_admin_payment_observation_outcomes',[collection,ids],['text','text[]'],'http_admin');
 assert.deepEqual(await admin(),ids.map((sourceId,i)=>({sourceId,processing:i===4?'non_payment':statuses[i],
  paymentReference:null,payerStatus:null,payerReason:null})));
 await assert.rejects(admin('another-group'),/scope denied/);
 const proof=captured.map(input=>({sourceKey:input.sourceKey,bodySha256:sha(input.rawBody),rawSender:input.rawSender,
  serviceCentreAt:input.serviceCentreAt,inboxReceivedAt:input.inboxReceivedAt,subscriptionId:input.subscriptionId}));
 const runId=randomUUID(),check={runId,expectedConsentGeneration:1,state:'checking',candidateCount:0,missingCount:0,pendingCount:0,
  phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null};
 await flow.route('/inbox-check',check);
 const reconcile={runId,items:proof,includeProcessing:true};
 const totals=async()=>(await f.client.query(`SELECT
  (SELECT count(*)::int FROM private.burimunsi_inbox_check_items) AS page_rows,
  (SELECT coalesce(sum(page_items),0)::int FROM private.burimunsi_inbox_checks) AS page_counter,
  (SELECT count(*)::int FROM burimunsi.payments) AS payments,
  (SELECT count(*)::int FROM app.ledger_entries) AS credits`)).rows[0];
 const original=await totals();
 assert.equal(original.page_rows,0);
 assert.equal(original.page_counter,0);
 const blocker=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await blocker.connect();
 flow.routeTest.lock=true;
 try{
  await blocker.query('BEGIN');
  await lockCollectMutation({unsafe:sql=>blocker.query(sql)});
  const rejected=await flow.route('/reconcile-batch',reconcile,503);
  assert.equal(flow.routeTest.sqlState,'55P03');
  assert.equal(rejected.ok,false);
  assert.equal(rejected.data,undefined);
  assert.deepEqual(await totals(),original);
 }finally{await blocker.query('ROLLBACK');await blocker.end();}
 flow.routeTest.revoked=true;
 await flow.route('/reconcile-batch',reconcile,403);
 flow.routeTest.revoked=false;
 await flow.route('/reconcile-batch',{...reconcile,runId:randomUUID()},409);
 const changed={...reconcile,items:[{...proof[0],bodySha256:'0'.repeat(64)},...proof.slice(1)]};
 await flow.route('/reconcile-batch',changed,409);
 assert.deepEqual(await totals(),original);
 const verified=await flow.route('/reconcile-batch',reconcile);
 assert.deepEqual(await totals(),{...original,page_rows:proof.length,page_counter:proof.length});
 assert.deepEqual(await flow.route('/reconcile-batch',reconcile),verified);
 assert.deepEqual(await totals(),{...original,page_rows:proof.length,page_counter:proof.length});
 flow.routeTest.lock=false;
 t.diagnostic('F02: exact run/page retried after real 55P03; no page/credit on timeout or denied proof; exactly one page after replay.');
 assert.deepEqual(verified.items,proof.map(({sourceKey},i)=>({sourceKey,state:'matched',sourceId:ids[i],processingStatus:statuses[i]})));
 const census=await flow.route('/reconcile-verified-status');
 assert.equal(census.recordedCount,ids.length);
 const latest=proof.at(-1).sourceKey;
 await flow.route('/inbox-check',{...check,state:'verified',candidateCount:ids.length,phoneLatestKey:latest,
  parsedLatestKey:latest,collectionRevision:census.revision});
 assert.equal((await f.rpc('burimunsi_observation_admin_inbox_check',[group],['text'],'http_admin')).state,'verified');
 for(const invalidate of [
  "UPDATE burimunsi.raw_sms SET ciphertext=convert_to('invalid envelope','UTF8') WHERE id=$1",
  "UPDATE app.momo_parse_attempts SET source_body_sha256=repeat('0',64) WHERE raw_sms_id=$1",
 ]){
  await f.client.query('BEGIN');
  try{
   await f.client.query(invalidate,[saved[0]]);
   await f.client.query("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'; SET LOCAL test.work_kind='http_admin'");
   const [{result}]=(await f.client.query('SELECT private.burimunsi_admin_payment_observation_outcomes($1,$2::text[]) AS result',
    [group,[saved[0]]])).rows;
   assert.equal(result[0].processing,'blocked');
   const [{health}]=(await f.client.query('SELECT private.burimunsi_observation_admin_inbox_check($1) AS health',[group])).rows;
   assert.equal(health.state,'incomplete');
  }finally{await f.client.query('ROLLBACK');}
 }
 // An unrelated member receives the allocation. Only the full payer number in the original SMS may receive the confirmation.
 const differentMember=uuid(940);
 await f.client.query("INSERT INTO app.users(id,access_status,member_type,momo_number) VALUES($1,'active','direct','+250780000099')",[differentMember]);
 await f.client.query('INSERT INTO app.memberships VALUES($1,$2,1)',[group,differentMember]);
 const incoming=fullWire();const source=await flow.route('',incoming);
 flow.provider({...providerOutput(incoming.rawBody),schema_version:NATIVE_AUTO_SCHEMA_VERSION,wallet_effect:'credit'});
 assert.deepEqual(await flow.parser.process(source.sourceId),{state:'completed',relation:'accepted'});
 const count=async()=>Number((await f.client.query('SELECT count(*) FROM private.burimunsi_allocation_receipts')).rows[0].count);
 const allocate=(sql,paymentId)=>assignPayment(sql,{groupId:group,paymentId,memberId:differentMember,expectedVersion:1});
 const owner=runtime.run('http_collect');
 await owner(sql=>allocate(sql,archivedPayment)); // already assigned before the allocation notification feature
 await f.client.query(allocation);
 assert.equal(await count(),0);
 await assert.rejects(owner(async sql=>{await allocate(sql,source.sourceId);throw Error('rolled back allocation');}),/rolled back allocation/);
 assert.equal(await count(),0);
 await owner(sql=>allocate(sql,saved[1])); // outgoing
 assert.equal(await count(),0);
 const worker=await openFixturePayerWorker({client:f.client,collectionId:group,enabledAt:f.enabledAt,allocation:true,lostReply:true,lostClaimReply:true});
 assert.deepEqual(await worker.drain(),{status:'complete',processed:0});
 await owner(sql=>allocate(sql,saved[0])); // masked
 assert.deepEqual(await worker.drain(),{status:'complete',processed:0});
 const receiptStatus=async(id)=>(await f.client.query('SELECT status,reason FROM private.burimunsi_allocation_receipts WHERE payment_id=$1',[id])).rows[0];
 assert.deepEqual(await receiptStatus(saved[0]),{status:'suppressed',reason:'unverified_destination'});
 const peer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await peer.connect();
 try {
  await peer.query('SET ROLE postgres');
  const other=nativeRuntime(peer,group).run('http_admin');
  const allocations=await Promise.allSettled([owner(sql=>allocate(sql,source.sourceId)), other(sql=>allocate(sql,source.sourceId))]);
  assert.equal(allocations.filter(a=>a.status==='fulfilled').length,1);
  assert.deepEqual(allocations.filter(a=>a.status==='rejected').map(a=>a.reason.code),['payment_changed']);
 } finally {await peer.end();}
 await assert.rejects(owner(sql=>allocate(sql,source.sourceId)),error=>error.code==='payment_changed');
 assert.equal(await count(),2);
 assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'unknown'});
 assert.deepEqual(worker.requests,['POST']);
 assert.equal(worker.submitted.to,phone);
 assert.ok(worker.submitted.text.includes('1,000 RWF'));
 assert.ok(!worker.submitted.text.includes('2,000'));
 assert.deepEqual(await receiptStatus(source.sourceId),{status:'unknown',reason:'gateway_unconfirmed'});
 await worker.carrierDelivered();
 assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'accepted',gateway_state:'delivered'});
 assert.deepEqual(await worker.drain(),{status:'complete',processed:0});
 assert.deepEqual(worker.requests,['POST','GET']);
 assert.deepEqual(await receiptStatus(source.sourceId),{status:'delivered',reason:null});
 await worker.complete();
 const adminStatus=withPayer=>f.rpc('burimunsi_admin_payment_observation_outcomes',[group,[source.sourceId],withPayer],['text','text[]','boolean'],'http_admin');
 assert.equal((await adminStatus(false))[0].payerStatus,null);
 await f.client.query("DELETE FROM app.admin_grants WHERE permission='payments.read'");
 await assert.rejects(adminStatus(true),/permission denied/);
 await f.client.query("INSERT INTO app.admin_grants VALUES('principal','payments.read')");
 assert.equal((await adminStatus(true))[0].payerStatus,'delivered');
 await t.test('one indexed payment/source metadata lookup keeps custody and RLS without writes',async()=>{
  const lookup=await load('20261124151857_burimunsi_payment_sms_evidence.sql');
  // The production browser identity resolver is qualified separately. The
  // owned native-chain fixture provides only this live-grant seam for SQL.
  await f.client.query(`CREATE FUNCTION private.burimunsi_browser_pin_assert_actor(text,text,text,bigint,bigint)
    RETURNS text LANGUAGE plpgsql AS $$BEGIN
     IF $1<>'payments.read' OR $2 IS DISTINCT FROM current_setting('burimunsi.collection_id',true)
      OR $3<>'admin' OR $4<>1 OR $5 IS NOT NULL THEN RAISE insufficient_privilege;END IF;
     RETURN private.assert_actor($1,NULL,NULL,$4,$5);
    END$$`);
  await f.client.query(lookup);
  const old=await load('20261111121100_burimunsi_admin_observations.sql');
  const oldStart=old.indexOf('CREATE FUNCTION private.burimunsi_observation_admin_rows(p_collection text)');
  const oldEnd=old.indexOf('CREATE FUNCTION private.burimunsi_observation_admin_page(',oldStart);
  assert.ok(oldStart>=0&&oldEnd>oldStart);
  await f.client.query(old.slice(oldStart,oldEnd));
  await f.client.query('GRANT EXECUTE ON FUNCTION private.burimunsi_observation_admin_rows(text) TO collect_runtime');

  const inspect=sql=>f.client.query(sql).then(r=>r.rows[0]);
  const counters=()=>inspect(`SELECT
   (SELECT count(*)::int FROM burimunsi.payments) AS payments,
   (SELECT count(*)::int FROM app.ledger_entries) AS credits,
   (SELECT count(*)::int FROM private.burimunsi_observation_requests) AS sources,
   (SELECT count(*)::int FROM private.burimunsi_allocation_receipts) AS delivery`);
  const original=await counters(), run=runtime.run('http_admin');
  let statement,bindings,reads=0;
  const fetch=(id=source.sourceId,scope=group)=>run(tx=>readPaymentSmsEvidence({unsafe:(sql,args)=>{
   reads++;statement=sql;bindings=args;return tx.unsafe(sql,args);
  }},scope,id));
  // The media double keeps reservation bytes after committing metadata;
  // model the maintained Storage worker's separate reservation purge.
  const oldProof=async()=>(await run(tx=>tx.unsafe(`SELECT retention_state,body_sha256
   FROM private.burimunsi_observation_admin_rows($1) WHERE source_id=$2`,[group,source.sourceId])))[0];
  assert.deepEqual(await oldProof(),{retention_state:'unresolved',body_sha256:null});
  const uncleared=await fetch();assert.equal(uncleared.retentionState,'unresolved');assert.equal(uncleared.bodySha256,null);
  reads=0;
  const evidenceKey='sms/'+source.sourceId;
  const {sealed_body:fixtureSealed}=(await f.client.query(
   'SELECT sealed_body FROM private.storage_payload_reservations WHERE object_key=$1',[evidenceKey])).rows[0];
  await f.client.query("UPDATE private.storage_payload_reservations SET sealed_body=NULL,cleared_at='fixture verified' WHERE object_key=$1",[evidenceKey]);
  const detail=await fetch();
  assert.equal(reads,1);
  assert.equal(detail.sourceId,source.sourceId);assert.equal(detail.retentionState,'retained');
  assert.equal(detail.payerStatus,'delivered');assert.match(detail.bodySha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(await oldProof(),{retention_state:detail.retentionState,body_sha256:detail.bodySha256});
  assert.doesNotMatch(JSON.stringify(detail),/rawBody|ciphertext|objectKey|sourceFingerprint/);
  // Verify the ordinary planner at a scope where the key is selective.
  await f.client.query(`INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf)
   SELECT 'f06-index-plan-'||n,$1,'wallet','mtn_momo','incoming',1 FROM generate_series(1,1024) n`,[group]);
  await f.client.query('ANALYZE burimunsi.payments');
  const explain=await run(tx=>tx.unsafe('EXPLAIN (FORMAT JSON) '+statement,bindings));
  assert.match(JSON.stringify(explain),/payments_pkey/);
  await f.client.query("DELETE FROM burimunsi.payments WHERE collection_id=$1 AND id LIKE 'f06-index-plan-%'",[group]);
  assert.equal(await fetch('absent-payment'),null);
  assert.equal(await fetch(source.sourceId,'another-group'),null);
  assert.deepEqual(await run(tx=>tx.unsafe('SELECT * FROM private.burimunsi_payment_sms_evidence_rows($1,$2,$3)',
   [group,source.sourceId,saved[1]])),[]);
  await f.client.query("DELETE FROM app.admin_grants WHERE permission='payments.read'");
  await assert.rejects(fetch(),{code:'42501'});
  await f.client.query("INSERT INTO app.admin_grants VALUES('principal','payments.read')");
  for(const role of ['anon','authenticated','service_role','collect_importer']){
   assert.equal((await f.client.query("SELECT has_function_privilege($1,'private.burimunsi_payment_sms_evidence_rows(text,text,text)','EXECUTE') AS allowed",[role])).rows[0].allowed,false);
  }
  await f.client.query("INSERT INTO private.storage_delete_intents(object_key) VALUES($1)",['sms/'+source.sourceId]);
  const deleted=await fetch();
  assert.equal(deleted.retentionState,'unresolved');assert.equal(deleted.bodySha256,null);
  await f.client.query('DELETE FROM private.storage_delete_intents WHERE object_key=$1',['sms/'+source.sourceId]);
  await f.client.query('UPDATE private.storage_payload_reservations SET sealed_body=$2,cleared_at=NULL WHERE object_key=$1',[evidenceKey,fixtureSealed]);
  assert.deepEqual(await counters(),original);
 });

 await f.client.query("BEGIN; SET LOCAL ROLE collect_runtime; SET LOCAL burimunsi.collection_id='another-group'");
 assert.equal((await f.client.query('SELECT count(*)::int n FROM burimunsi.raw_sms')).rows[0].n,0);
 await f.client.query('ROLLBACK');
 await t.test('scoped analysis SQL masks SMS and bounds scans before matching, preserving each exact integer',async()=>{
  const foreign='analysis-other-group';
  await f.client.query("INSERT INTO private.burimunsi_scopes VALUES($1,'wallet',NULL)",[foreign]);
  const seed=async(groupId,id,amount)=>{
   await f.client.query(`INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf,counterparty_name)
     VALUES($1,$2,'wallet','mtn_momo','incoming',$3::bigint,'Analysis fixture')`,[id,groupId,amount]);
  };
  await seed(group,'analysis-large-one','9007199254740991');
  await seed(group,'analysis-large-two','9007199254740991');
  await seed(foreign,'analysis-foreign','9007199254740991');
  const rune=runtime.run('http_collect',{readOnly:true});
  const scoped=(options={},id=group)=>rune(tx=>readPaymentAnalysisRows(tx,id,{q:'',showSms:false,...options}));
  const maskedRead=await scoped();
  assert.equal(maskedRead.rows.every(row=>row.sourceId===null),true);
  assert.ok((await scoped({showSms:true})).rows.some(row=>row.sourceId!==null));
  const matches=await scoped({q:'Analysis fixture'});
  assert.equal(matches.rows.length,2);
  assert.equal([...matches.amounts.values()].reduce((s,v)=>s+v,0n).toString(),'18014398509481982');
  assert.deepEqual((await scoped({q:'Analysis fixture'},foreign)).rows,[]);

  // The standalone Payments schema records only incoming/outgoing; a
  // genuine reversal notice is not silently projected as a signed payment.
  const reversalClause='Transaction reversed for RWF 5';
  const reversalBody=reversalClause+'. FT Id: 1234567891.';
  const reversalSource=await flow.route('',{...masked,requestId:uuid(997),sourceKey:sha('analysis-reversal'),rawBody:reversalBody});
  flow.provider({...outgoing,event_kind:'reversal',wallet_effect:'credit',transaction_id_raw:'1234567891',
    principal_amount_raw:'5',payer_name_raw:null,evidence:{...outgoing.evidence,incoming_success:reversalClause,principal:reversalClause,
      transaction_id:'FT Id: 1234567891',payer:null}});
  const identity=(await f.client.query(`SELECT pg_backend_pid() AS pid,current_setting('fixture.native_actor',true) AS actor,
   current_setting('fixture.native_context',true) AS context,current_setting('fixture.native_profile',true) AS profile`)).rows[0];
  const pgId=identity.pid;
  const writer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
  await writer.connect();
  const reversalWorker=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
  await reversalWorker.connect();
  await reversalWorker.query('SET ROLE postgres');
  await reversalWorker.query(`SELECT set_config('fixture.native_actor',$1,false),
    set_config('fixture.native_context',$2,false),set_config('fixture.native_profile',$3,false)`,[identity.actor,identity.context,identity.profile]);
  const parallelParser=Object.assign(Object.create(Object.getPrototypeOf(flow.parser)),flow.parser,
    {authority:{write:nativeRuntime(reversalWorker,group).run('jobs')}});
  let frozen;
  try{
   await writer.query('SET ROLE postgres; BEGIN; SELECT pg_advisory_xact_lock(552711::bigint)');
   // Test-only barrier after the reader's repeatable snapshot is established.
   frozen=rune(tx=>readPaymentAnalysisRows({unsafe:(sql,args)=>tx.unsafe(
     sql.replace('WITH candidate AS','WITH wait_barrier AS MATERIALIZED (SELECT pg_advisory_xact_lock_shared(552711::bigint)),candidate AS')
       .replace('FROM checked','FROM checked CROSS JOIN wait_barrier'),args)},group,{q:'Analysis fixture',showSms:false}));
   const deadline=performance.now()+3000;
   while(!(await writer.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked',[pgId])).rows[0].blocked){
    assert.ok(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.deepEqual(await parallelParser.process(reversalSource.sourceId),{state:'non_payment'});
   assert.equal((await reversalWorker.query('SELECT count(*)::int n FROM burimunsi.payments WHERE id=$1',[reversalSource.sourceId])).rows[0].n,0);
   await writer.query(`INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf,counterparty_name)
    VALUES ('analysis-in-addition',$1,'wallet','mtn_momo','incoming',13,'Analysis fixture'),
     ('analysis-recorded-return',$1,'wallet','mtn_momo','outgoing',5,'Analysis fixture')`,[group]);
   await writer.query('COMMIT');
   const summarize=({rows,amounts})=>Object.fromEntries(['incoming','outgoing'].map(direction=>[direction,
    rows.filter(row=>row.direction===direction).reduce((total,row)=>total+amounts.get(row.id),0n).toString()]));
   const whileWriting=await frozen;
   assert.equal(whileWriting.rows.length,2);
   assert.deepEqual(summarize(whileWriting),{incoming:'18014398509481982',outgoing:'0'});
   const next=await scoped({q:'Analysis fixture'});
   assert.equal(next.rows.length,4);
   const independently=(await f.client.query(`SELECT
    coalesce(sum(amount_rwf) FILTER (WHERE direction='incoming'),0)::text AS incoming,
    coalesce(sum(amount_rwf) FILTER (WHERE direction='outgoing'),0)::text AS outgoing
    FROM burimunsi.payments WHERE collection_id=$1 AND counterparty_name='Analysis fixture'`,[group])).rows[0];
   assert.deepEqual(summarize(next),independently);
   assert.deepEqual(independently,{incoming:'18014398509481995',outgoing:'5'});
  }finally{await reversalWorker.end();await writer.query('ROLLBACK');await writer.end();if(frozen)await frozen;}
  const before=(await f.client.query('SELECT count(*)::int AS n FROM burimunsi.payments WHERE collection_id=$1',[group])).rows[0].n;
  await f.client.query(`INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf)
    SELECT 'analysis-benchmark-'||n,$1,'wallet','mtn_momo','incoming',1 FROM generate_series(1,$2::int) n`,
    [group,PAYMENT_ANALYSIS_LIMIT-before]);
  await f.client.query(`INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf)
    SELECT 'analysis-outside-benchmark-'||n,$1,'wallet','mtn_momo','incoming',1 FROM generate_series(1,15000) n`,[foreign]);
  await f.client.query('ANALYZE burimunsi.payments');
  let statement,bindings;
  const start=performance.now();
  const cap=await rune(tx=>readPaymentAnalysisRows({unsafe:(sql,args)=>{
    statement=sql;bindings=args;return tx.unsafe(sql,args);
  }},group,{q:'',showSms:false}));
  const ms=Math.round(performance.now()-start);
  const plan=await rune(tx=>tx.unsafe('EXPLAIN (FORMAT JSON) '+statement,bindings));
  const indexes=[...JSON.stringify(plan).matchAll(/"Index Name":"(burimunsi_payments_(?:recent|member))"/g)].map(x=>x[1]);
  assert.ok(indexes.length,'analysis scan did not use an indexed collection prefix in the reviewed fixture');
  t.diagnostic('Default PG indexed collection plan: '+indexes.join(',')+'; '+ms+'ms at '+cap.rows.length+' visible rows and 15001 other-group rows');

  assert.equal(cap.rows.length,PAYMENT_ANALYSIS_LIMIT);
  t.diagnostic('Co-located PG capped reader including row decode: '+Math.round(performance.now()-start)+'ms at '+cap.rows.length+' rows');
  await seed(group,'analysis-over-limit','1');
  await assert.rejects(scoped({q:'No existing match'}),{status:503,code:'payment_analysis_scope_too_large'});
 });


 await t.test('a verified original inbox page adopts an exact earlier payment and parses a new held receipt once', async () => {
  await f.client.query(await load('20261124114504_burimunsi_verified_inbox_recovery.sql'));
  const duplicate = {...archivedInput,requestId:randomUUID(),sourceKey:sha('held archive row')};
  const fresh = {...masked,requestId:randomUUID(),sourceKey:sha('held fresh row'),
    rawBody:masked.rawBody.replace('987654321','987654345')};
  const ambiguous = {...masked,requestId:randomUUID(),sourceKey:sha('held different original time'),
    inboxReceivedAt:'2026-11-22T18:07:22Z'};
  const deliveredCopy={...incoming,sourceMode:'catch_up',complete:false,requestId:randomUUID(),sourceKey:sha('verified copy of delivered receipt')};
  const items=[duplicate,fresh,ambiguous,deliveredCopy],sources=[];
  for(const input of items) {
   const saved=await flow.route('/recover-held',{...input,expectedConsentGeneration:1});
   assert.equal(saved.autoProcessing,'held');
   sources.push(saved.sourceId);
  }
  const summary=async()=> (await f.client.query(`SELECT
    (SELECT count(*)::int FROM burimunsi.payments) AS payments,
    (SELECT count(*)::int FROM private.burimunsi_verified_inbox_recoveries) AS recovered,
    (SELECT count(*)::int FROM private.burimunsi_allocation_receipts) AS notices,
    (SELECT count(*)::int FROM app.ledger_entries) AS credits`)).rows[0];
  const before=await summary();
  const pageRun={...check,runId:randomUUID()};
  await flow.route('/inbox-check',pageRun);
  const page={runId:pageRun.runId,includeProcessing:true,items:items.map(input=>({
    sourceKey:input.sourceKey,bodySha256:sha(input.rawBody),rawSender:input.rawSender,
    inboxReceivedAt:input.inboxReceivedAt,serviceCentreAt:input.serviceCentreAt,subscriptionId:input.subscriptionId
  }))};
  const reconciled=await flow.route('/reconcile-batch',page);
  assert.deepEqual(reconciled.items.map(row=>row.processingStatus),['duplicate','pending','needs_review','duplicate']);
  assert.deepEqual((await flow.route('/reconcile-batch',page)).items,reconciled.items);
  assert.deepEqual(await summary(),{...before,recovered:3});
  const [withPayer]=await f.rpc('burimunsi_admin_payment_observation_outcomes',[group,[sources[3]],true],['text','text[]','boolean'],'http_admin');
  assert.equal(withPayer.processing,'duplicate');
  assert.equal(withPayer.payerStatus,'delivered');
  const recovered=new Map((await f.client.query('SELECT source_id,prior_source_id FROM private.burimunsi_verified_inbox_recoveries')).rows
    .map(row=>[row.source_id,row.prior_source_id]));
  assert.deepEqual(recovered,new Map([[sources[1],null],[sources[0],archived.sourceId],[sources[3],source.sourceId]]));
  await f.client.query("SELECT set_config('collect.fence_admission_id',$1,false),set_config('collect.fence_source_sha256',repeat('a',64),false),set_config('collect.fence_epoch','1',false)",[uuid(888)]);
  await f.client.query('UPDATE private.burimunsi_observation_consents SET enabled=false');
  await assert.rejects(flow.parser.process(sources[1]));
  await f.client.query('UPDATE private.burimunsi_observation_consents SET enabled=true');
  const priorCalls=flow.counts().providerCalls;
  await assert.rejects(flow.parser.process(sources[0]));
  await assert.rejects(flow.parser.process(sources[2]));
  assert.equal(flow.counts().providerCalls,priorCalls);
  flow.provider({...providerOutput(fresh.rawBody),schema_version:NATIVE_AUTO_SCHEMA_VERSION,wallet_effect:'credit'});
  const result={state:'completed',relation:'accepted'};
  assert.deepEqual(await flow.parser.process(sources[1]),result);
  assert.deepEqual(await flow.parser.process(sources[1]),result);
  assert.equal(flow.counts().providerCalls,priorCalls+1);
  assert.deepEqual(await summary(),{...before,payments:before.payments+1,recovered:3});
  assert.deepEqual((await flow.route('/reconcile-batch',page)).items.map(row=>row.processingStatus),['duplicate','parsed','needs_review','duplicate']);
  assert.deepEqual((await f.client.query('SELECT direction,allocation_state,member_id FROM burimunsi.payments WHERE sms_source_id=$1',[sources[1]])).rows,
    [{direction:'incoming',allocation_state:'unallocated',member_id:null}]);
  await f.client.query('BEGIN');
  try {
   await f.client.query("UPDATE app.momo_parse_attempts SET source_body_sha256=repeat('0',64) WHERE raw_sms_id=$1",[archived.sourceId]);
   await f.client.query("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'; SET LOCAL test.work_kind='http_admin'");
   const [{result}]=(await f.client.query('SELECT private.burimunsi_admin_payment_observation_outcomes($1,$2::text[],true) AS result',[group,[sources[0]]])).rows;
   assert.notEqual(result[0].processing,'duplicate');
  } finally {await f.client.query('ROLLBACK');}
  const publicAccess=(await f.client.query("SELECT has_function_privilege('collect_runtime','private._burimunsi_reconcile_held_payment_page(uuid,jsonb,jsonb)','EXECUTE') AS allowed")).rows[0];
  assert.equal(publicAccess.allowed,false);
 });
});

test('keyed inbox custody returns the original journal under both advisory and all three row locks',async t=>{
 let peer;t.after(async()=>{if(peer)await peer.end();});
 const f=await startPayerFixture(t,{groupId:group,memberId:member,phoneNumber:phone,beforeNoticeMigration:client=>installNativeChain(client,group)});
 const flow=receiptFixture(f),saved=await flow.route('',fullWire()),custody=flow.pageCustody;
 const {object_key:key,object_sha256:hash,principal_user_id:ownerId}=(await f.client.query(
  'SELECT object_key,object_sha256,principal_user_id FROM private.burimunsi_unresolved_observations WHERE source_id=$1',[saved.sourceId])).rows[0];
 const expect={ownerId,purpose:'sms_receipt',entityId:saved.sourceId,plaintextSha256:hash,aad:'sms:'+saved.sourceId+':'+hash};
 const run=nativeRuntime(f.client,group).run('http_collect');
 peer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await peer.connect();await peer.query('SET ROLE postgres');
 const tables=['storage_put_intents','storage_objects','storage_payload_reservations'];
 let assertions=0;custody.work.assert=async()=>{assertions++;};
 async function measured(method){
  let queries=0;assertions=0;
  const proof=await run(async tx=>{
   const result=await custody[method]({unsafe:(sql,args)=>{queries++;return tx.unsafe(sql,args);}},key,expect);
   for(const table of tables)await assert.rejects(peer.query('SELECT object_key FROM private.'+table+' WHERE object_key=$1 FOR UPDATE NOWAIT',[key]),{code:'55P03'});
   const locks=(await peer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7346369)) AS key, pg_try_advisory_xact_lock(hashtextextended($2,7346370)) AS owner',[key,ownerId])).rows;
   assert.deepEqual(locks,[{key:false,owner:false}]);
   return result;
  });
  return {proof,queries,assertions};
 }
 const prior=await measured('journal'),page=await measured('keyedObservationJournal');
 assert.deepEqual(page.proof,prior.proof);
 assert.deepEqual([prior.queries,prior.assertions,page.queries,page.assertions],[7,15,2,5]);
 const endpoint=f.cluster.socket+'/.s.PGSQL.'+f.cluster.port;
 const driver=fileURLToPath(new URL('./fixtures/burimunsi-keyed-journal-driver.mjs',import.meta.url));
 const lock=fileURLToPath(new URL('../deno.lock',import.meta.url));
 assert.equal(execFileSync('deno',['run','--frozen','--cached-only','--node-modules-dir=none','--lock='+lock,
  '--allow-read','--allow-env','--allow-net=unix:'+endpoint,'--allow-write='+endpoint,driver,f.cluster.socket,String(f.cluster.port)],
  {timeout:15000,encoding:'utf8',input:JSON.stringify({group,key,expect})}).trim(),'verified');
 await f.client.query('UPDATE private.storage_payload_reservations SET sealed_body=NULL WHERE object_key=$1',[key]);
 assert.deepEqual((await measured('keyedObservationJournal')).proof,(await measured('journal')).proof);
 for(const [change,params] of [
  ['INSERT INTO app.privacy_retention_barriers(subject_id) VALUES($1)',[ownerId]],
  ['UPDATE private.storage_objects SET sha256=$2 WHERE object_key=$1',[key,'0'.repeat(64)]],
  ['UPDATE private.storage_put_intents SET upload_unresolved=true WHERE object_key=$1',[key]],
  ['DELETE FROM private.storage_payload_reservations WHERE object_key=$1',[key]],
 ]){
  await f.client.query('BEGIN');
  try{
   await f.client.query(change,params);await f.client.query('SET LOCAL ROLE collect_runtime');
   const tx={unsafe:async(sql,args)=>(await f.client.query(sql,args)).rows};
   await assert.rejects(custody.keyedObservationJournal(tx,key,expect),{code:'posting_evidence_unavailable'});
  }finally{await f.client.query('ROLLBACK');}
 }
 const pid=(await f.client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await peer.query('BEGIN');
 let pending;
 try{
  await peer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7346369))',[key]);
  await peer.query('INSERT INTO private.storage_delete_intents(object_key) VALUES($1)',[key]);
  pending=assert.rejects(run(tx=>custody.keyedObservationJournal(tx,key,expect)),{code:'posting_evidence_unavailable'});
  const deadline=performance.now()+5000;
  while(!(await peer.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting',[pid])).rows[0].waiting){
   assert.ok(performance.now()<deadline,'the page must wait for the original object lock');
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal((await peer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7346370)) AS acquired',[ownerId])).rows[0].acquired,true);
  await peer.query('COMMIT');
 }finally{await peer.query('ROLLBACK');if(pending)await pending;}
});

test('the page custody barrier verifies all ten journals in two statements after ordered advisory acquisition',async t=>{
 let peer;t.after(async()=>{if(peer)await peer.end();});
 const f=await startPayerFixture(t,{groupId:group,memberId:member,phoneNumber:phone,beforeNoticeMigration:client=>installNativeChain(client,group)});
 const flow=receiptFixture(f),targets=[],inputs=[];
 for(let i=0;i<10;i++){
  const input={...fullWire(),rawBody:'Synthetic receipt '+i,requestId:randomUUID(),sourceKey:sha('page-key '+i)};
  inputs.push(input);
  const {sourceId}=await flow.route('',input);
  const {object_key:key,object_sha256:hash,principal_user_id:ownerId}=(await f.client.query(
   'SELECT object_key,object_sha256,principal_user_id FROM private.burimunsi_unresolved_observations WHERE source_id=$1',[sourceId])).rows[0];
  targets.push({key,expect:{ownerId,purpose:'sms_receipt',entityId:sourceId,plaintextSha256:hash,aad:'sms:'+sourceId+':'+hash}});
 }
 const run=nativeRuntime(f.client,group).run('http_collect'),custody=flow.pageCustody;
 peer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await peer.connect();await peer.query('SET ROLE postgres');
 const prior=await run(async tx=>{
  const saved=[];for(const {key,expect} of targets)saved.push(await custody.keyedObservationJournal(tx,key,expect));
  return saved;
 });
 let assertions=0,queries=0;custody.work.assert=async()=>{assertions++;};
 await run(async tx=>{
  const actual=await custody.keyedObservationJournals({unsafe:(sql,params)=>{queries++;return tx.unsafe(sql,params);}},targets);
  assert.deepEqual(actual,prior);
  for(const table of ['storage_put_intents','storage_objects','storage_payload_reservations']){
   for(const {key} of targets)await assert.rejects(peer.query('SELECT object_key FROM private.'+table+' WHERE object_key=$1 FOR UPDATE NOWAIT',[key]),{code:'55P03'});
  }
  for(const {key,expect} of targets){
   const [lock]=(await peer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7346369)) AS key,pg_try_advisory_xact_lock(hashtextextended($2,7346370)) AS owner',[key,expect.ownerId])).rows;
   assert.deepEqual(lock,{key:false,owner:false});
  }
 });
 assert.deepEqual({queries,assertions},{queries:2,assertions:14});
 const endpoint=f.cluster.socket+'/.s.PGSQL.'+f.cluster.port;
 const driver=fileURLToPath(new URL('./fixtures/burimunsi-keyed-journal-driver.mjs',import.meta.url));
 const lock=fileURLToPath(new URL('../deno.lock',import.meta.url));
 assert.equal(execFileSync('deno',['run','--frozen','--cached-only','--node-modules-dir=none','--lock='+lock,
  '--allow-read','--allow-env','--allow-net=unix:'+endpoint,'--allow-write='+endpoint,driver,f.cluster.socket,String(f.cluster.port)],
  {timeout:15000,encoding:'utf8',input:JSON.stringify({group,...targets[0],targets})}).trim(),'verified');
 const page=inputs.map(i=>({sourceKey:i.sourceKey,bodySha256:sha(i.rawBody),rawSender:i.rawSender,
  serviceCentreAt:i.serviceCentreAt,inboxReceivedAt:i.inboxReceivedAt,subscriptionId:i.subscriptionId}));
 const replay=()=>flow.route('/reconcile-batch',{items:page,includeProcessing:true});
 assert.deepEqual((await replay()).items.map(x=>x.sourceId),targets.map(t=>t.expect.entityId));
 assert.deepEqual(await replay(),await replay());
 const [{pid}]=(await f.client.query('SELECT pg_backend_pid() AS pid')).rows;
 await peer.query('BEGIN');let blocked;
 try{
  const last=targets.at(-1).key;
  await peer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7346369))',[last]);
  await peer.query('INSERT INTO private.storage_delete_intents(object_key) VALUES($1)',[last]);
  blocked=assert.rejects(run(tx=>custody.keyedObservationJournals(tx,targets)),{code:'posting_evidence_unavailable'});
  const until=performance.now()+5000;
  while(!(await peer.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting',[pid])).rows[0].waiting){
   assert.ok(performance.now()<until);await new Promise(r=>setTimeout(r,5));
  }
  assert.equal((await peer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,7346369)) AS acquired',[targets[0].key])).rows[0].acquired,false);
  await peer.query('COMMIT');
 }finally{await peer.query('ROLLBACK');if(blocked)await blocked;}
 assert.equal((await f.client.query('SELECT count(*)::int AS n FROM app.payments')).rows[0].n,0);
 t.diagnostic(JSON.stringify({items:inputs.length,oldFinalStatements:20,newFinalStatements:queries,oldFinalWorkChecks:50,newFinalWorkChecks:14}));
});

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
  const pending=await flow.route('/reconcile-batch',{items:[proof],includeProcessing:true});
  assert.equal(pending.items[0].processingStatus,'pending');
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
 const verifiedPage=await flow.route('/reconcile-batch',{runId:check.runId,items:byPhone,includeProcessing:true});
 assert.deepEqual(verifiedPage.items,byPhone.map(item=>({sourceKey:item.sourceKey,state:'matched',
  sourceId:sources[proofs.indexOf(item)].source,processingStatus:'parsed'})));
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

test('two Admin receipt sources concurrently reporting the same network transfer post one ledger credit and create one payer SMS',async t=>{
 let peer;t.after(async()=>{if(peer)await peer.end();});
 const f=await startPayerFixture(t,{groupId:group,memberId:member,phoneNumber:phone,enabledAgo:86400000,
  beforeNoticeMigration:client=>installNativeChain(client,group)});
 await installHandsetInventory(f.client);
 peer=new pg.Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
 await peer.connect();await peer.query('SET ROLE postgres');
 const first=nativeActor(group),second={...first,accountId:uuid(71),installationId:uuid(72),grantId:uuid(73),sessionId:uuid(74),principalUserId:'fixture-peer'};
 await f.client.query('UPDATE app.users SET full_name=$1 WHERE id=$2',['EXAMPLE',member]);
 await f.client.query("INSERT INTO private.burimunsi_accounts(id,collection_id,active,removed,role,principal_user_id) VALUES($1,$2,true,false,'admin',$3)",[second.accountId,group,second.principalUserId]);
 await f.client.query("INSERT INTO private.burimunsi_device_grants VALUES($1,$2,1,$3,true,'internal_receiver')",[second.grantId,group,second.installationId]);
 await f.client.query('INSERT INTO private.burimunsi_device_accounts VALUES($1,$2,$3)',[second.accountId,second.grantId,group]);
 await f.client.query('INSERT INTO private.burimunsi_observation_consents VALUES($1,$2,$3,$4,1,1,true)',[group,second.accountId,second.installationId,second.grantId]);
 // Full phone/PIN authentication is exercised by the managed-schema fixture.
 // The ledger fixture carries these two authenticated origins through posting.
 for(const actor of [first,second]){
  await f.client.query("INSERT INTO private.burimunsi_sessions VALUES($1,$2,$3,$4,1,$5,$6,1,'phone_pin',false)",
   [actor.sessionId,group,actor.installationId,actor.grantId,actor.accountId,actor.principalUserId]);
  await f.client.query('INSERT INTO private.burimunsi_pin_session_links(native_session_id,collection_id,account_id,principal_user_id,account_version,created_at) VALUES($1,$2,$3,$4,1,1)',
   [actor.sessionId,group,actor.accountId,actor.principalUserId]);
 }
 const ctx=(await f.client.query("SELECT current_setting('fixture.native_context')::jsonb ctx")).rows[0].ctx;
 await peer.query("SELECT set_config('fixture.native_actor',$1,false),set_config('fixture.native_context',$2,false),set_config('fixture.native_profile',$3,false),set_config('burimunsi.collection_id',$4,false)",
  [JSON.stringify(second),JSON.stringify({...ctx,...second}),JSON.stringify(testProfile),group]);
 const one=receiptFixture(f,first),two=receiptFixture({client:peer},second);
 const input=fullWire(),copy={...input,requestId:randomUUID(),sourceKey:sha(second.installationId+input.sourceKey)};
 const [a,b]=await Promise.all([one.route('',input),two.route('',copy)]);
 assert.notEqual(a.sourceId,b.sourceId);
 assert.deepEqual(await Promise.all([one.route('',input),two.route('',copy)]),[a,b]);
 one.provider(input.rawBody);two.provider(copy.rawBody);
 const parsed=await Promise.all([one.parser.process(a.sourceId),two.parser.process(b.sourceId)]);
 assert.deepEqual(parsed.map(x=>x.relation).sort(),['accepted','duplicate']);
 const credited=parsed[0].relation==='accepted'?[one,a]:[two,b],duplicate=parsed[0].relation==='accepted'?[two,b]:[one,a];
 assert.equal((await credited[0].ledger.process(credited[1].sourceId)).state,'posted');
 assert.equal((await credited[0].ledger.process(credited[1].sourceId)).state,'already_posted');
 assert.equal((await duplicate[0].route('/processing-status',{sourceIds:[duplicate[1].sourceId]})).statuses[0].status,'duplicate');
 const amounts=(await f.client.query(`SELECT (SELECT count(*)::int FROM app.momo_transactions) transfers,
  (SELECT count(*)::int FROM app.momo_transaction_sources) sources,(SELECT count(*)::int FROM app.payments) payments,
  (SELECT count(*)::int FROM app.ledger_entries WHERE kind='contribution') credits,
  (SELECT sum(amount_minor)::int FROM app.ledger_entries WHERE kind='contribution') credited,
  (SELECT count(*)::int FROM private.burimunsi_payment_sms_obligations WHERE disposition='eligible') notices`)).rows[0];
 assert.deepEqual(amounts,{transfers:1,sources:2,payments:1,credits:1,credited:1000,notices:1});
 const sms=await openFixturePayerWorker({client:f.client,collectionId:group,enabledAt:f.enabledAt,applicationId:f.app});
 try{
  const submitted=await sms.drain();assert.equal(submitted.processed,1);assert.deepEqual(sms.requests,['POST']);assert.equal(sms.submitted.to,phone);
  const admin=()=>f.rpc('burimunsi_admin_observation_outcomes',[group,[a.sourceId,b.sourceId],true],['text','text[]','boolean'],'http_admin');
  const checkNotice=async expected=>{
   const entry=(await admin()).find(row=>row.sourceId===credited[1].sourceId);assert.equal(entry.payerStatus,expected);
  };
  await f.client.query("INSERT INTO app.admin_grants VALUES('principal','sms.read'),('principal','payments.read')");
  await f.client.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
  await checkNotice('unknown');
  await sms.carrierDelivered();assert.equal((await sms.drain()).gateway_state,'delivered');assert.equal((await sms.drain()).processed,0);
  assert.deepEqual(sms.requests,['POST','GET']);await checkNotice('delivered');
  async function verifyInbox(flow,inputs){
   const items=inputs.map(v=>({sourceKey:v.sourceKey,bodySha256:sha(v.rawBody),rawSender:v.rawSender,
    serviceCentreAt:v.serviceCentreAt,inboxReceivedAt:v.inboxReceivedAt,subscriptionId:v.subscriptionId}));
   const run={runId:randomUUID(),expectedConsentGeneration:1,state:'checking',candidateCount:0,missingCount:0,pendingCount:0,
    phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null};
   await flow.route('/inbox-check',run);
   const page=await flow.route('/reconcile-batch',{items,runId:run.runId,includeProcessing:true});
   assert.ok(page.items.every(i=>i.state==='matched'&&['parsed','duplicate'].includes(i.processingStatus)));
   const status=await flow.route('/reconcile-verified-status?scope=installation');assert.equal(status.scope,'verified_installation');
   assert.equal(status.recordedCount,inputs.length);assert.equal(status.hasUnmatchedCanonical,false);
   const latest=inputs.at(-1).sourceKey;
   const checked=await flow.route('/inbox-check',{...run,state:'verified',candidateCount:inputs.length,phoneLatestKey:latest,
    parsedLatestKey:latest,collectionRevision:status.revision});assert.equal(checked.state,'verified');return status;
  }
  const firstHead=await verifyInbox(one,[input]);await verifyInbox(two,[copy]);
  const summary=()=>f.rpc('burimunsi_observation_admin_inbox_check',[group],['text'],'http_admin');
  const both=await summary();
  assert.deepEqual({...both,checkedAt:null},{state:'verified',checkedAt:null,candidateCount:2,missingCount:0,pendingCount:0,headsMatch:true});
  assert.ok(Number.isSafeInteger(both.checkedAt));
  const otherProof={sourceKey:copy.sourceKey,bodySha256:sha(copy.rawBody),rawSender:copy.rawSender,serviceCentreAt:copy.serviceCentreAt,
   inboxReceivedAt:copy.inboxReceivedAt,subscriptionId:copy.subscriptionId};
  assert.equal((await one.route('/reconcile-batch',{items:[otherProof],includeProcessing:true})).items[0].state,'missing');
  const foreignRun=randomUUID();
  await one.route('/inbox-check',{expectedConsentGeneration:1,runId:foreignRun,state:'checking',candidateCount:0,missingCount:0,pendingCount:0,
   phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null});
  await assert.rejects(()=>f.rpc('burimunsi_observation_inbox_page',[foreignRun,JSON.stringify([{key:copy.sourceKey,sourceId:b.sourceId,
   bodySha256:sha(copy.rawBody),inboxReceivedAt:copy.inboxReceivedAt}])],['uuid','jsonb'],'http_collect'),/inbox_source_changed/);
  const origins=(await f.client.query('SELECT account_id,installation_id,principal_user_id FROM private.burimunsi_native_receipt_origins WHERE source_id=ANY($1::text[])',[[a.sourceId,b.sourceId]])).rows;
  for(const actor of [first,second])assert.ok(origins.some(r=>r.account_id===actor.accountId&&r.installation_id===actor.installationId&&r.principal_user_id===actor.principalUserId));
  await verifyInbox(one,[input]);
  const later=new Date(Date.parse(copy.inboxReceivedAt)+1000).toISOString();
  const extra={...copy,requestId:randomUUID(),sourceKey:sha('only second handset'),inboxReceivedAt:later,capturedAt:later,serviceCentreAt:later,
   rawBody:copy.rawBody.replace('987654322','987654329')};
  const retained=await two.route('',extra);assert.equal((await summary()).state,'incomplete');
  assert.deepEqual(await one.route('/reconcile-verified-status?scope=installation'),firstHead);two.provider(extra.rawBody);
  assert.equal((await two.parser.process(retained.sourceId)).relation,'accepted');
  const secondHead=await verifyInbox(two,[copy,extra]);assert.notEqual(secondHead.revision,firstHead.revision);
  assert.deepEqual(await verifyInbox(one,[input]),firstHead);
  const complete=await summary();assert.equal(complete.state,'verified');assert.equal(complete.candidateCount,3);assert.equal(complete.headsMatch,true);
 }finally{await sms.complete();}
});
