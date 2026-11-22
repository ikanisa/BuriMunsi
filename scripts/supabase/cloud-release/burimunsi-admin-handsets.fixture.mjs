// Synthetic PG17 phone/PIN sessions in the actual managed-schema predecessor.
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import '../../../supabase/functions/_shared/tests/helpers/node-postgres-import.mjs';
import {ownedFixturePool} from '../../../supabase/tests/burimunsi/postgres-fixture-pool.mjs';
import {PostgresDatabase} from '../../../supabase/functions/_shared/postgres.js';
import {sqlFenceBackend,openApplicationWork} from '../../../supabase/functions/_shared/application-fence.js';
import {createPhonePinRequestGate,applyPhonePinContext,claimPhonePinReadSnapshot} from '../../../supabase/functions/_shared/domain/burimunsi/phone-pin-request.js';
import {testProfile} from './fixtures/burimunsi-native-chain.mjs';
import {handleAdmin} from '../../../supabase/functions/_shared/domain/admin_bridge.js';

const group='browser-fixture-group',origin='https://burimunsi-admin.ikanisa.com',pin='8237';
const sha=value=>createHash('sha256').update(value).digest('hex');
const file=name=>readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');
const newPhone=(number,profile='internal_receiver')=>({number,profile,install:randomUUID(),device:randomBytes(32).toString('hex')});

export async function verifyAdminHandsets({owner,admin,database,fixtureRoot}){
 const {host:socket,port}=owner.connectionParameters;
 const target=(await owner.query("SELECT current_database() db,inet_server_addr() IS NULL AS local,current_setting('cluster_name') cluster")).rows[0];
 assert.equal(target.local,true);assert.equal(target.db,database);assert.equal(target.cluster,'collect_archive_next_fixture');
 const control=(await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
 const source=control.source_sha256,args=[randomUUID(),control.epoch,source];
 await owner.query('SELECT private.collect_fence_begin_quiesce($1,$2,$3)',args);
 await owner.query('SELECT private.collect_fence_drain($1,$2,$3)',args);
 for(const name of ['20261117180000_burimunsi_observation_reconcile_status.sql','20261117190000_burimunsi_legacy_reconcile.sql',
  '20261122191000_burimunsi_sms_completeness.sql','20261122191200_burimunsi_known_device_login_budget.sql','20261122200000_burimunsi_admin_handset_intake.sql']){
  await owner.query(await file(name));
 }
 await owner.query('SELECT private.collect_fence_release_v3($1,$2,$3)',[randomUUID(),control.epoch,source]);
 const pool=await ownedFixturePool({root:fixtureRoot,socket,port:Number(port),database,user:'postgres',clusterName:target.cluster});
 const backend=sqlFenceBackend(pool,pool);
 const trustedGate=createPhonePinRequestGate({origin,secrets:{pinPepper:Buffer.alloc(32,29),pinPepperId:'fixture'},networkBucket:async()=>sha('local fixture network')});
 const envBase={BURIMUNSI_COLLECTION_ID:group,BURIMUNSI_PRODUCT_MODE:'standalone',ADMIN_ORIGINS:origin,
  BURIMUNSI_DEFAULT_STAFF_PIN:pin,BURIMUNSI_PIN_PEPPER_ID:'fixture',BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32,29).toString('base64')};
 async function frame(kind,fn){
  const work=await openApplicationWork({backend,sourceSha256:source,kind});let failed=true;
  try{const value=await fn(new PostgresDatabase(pool,{},work));failed=false;return value;}
  finally{assert.equal((await work.finish({failed})).state,'settled');}
 }
 async function browser(path,body,auth={}){
  return frame('http_admin',async db=>{
   const headers=new Headers({Origin:origin});if(auth.cookie)headers.set('cookie','__Host-collect_admin='+auth.cookie);
   if(auth.csrf)headers.set('X-Collect-CSRF',auth.csrf);
   if(body){headers.set('Content-Type','application/json');headers.set('X-Collect-Requested-With','collect-admin');}
   const res=await handleAdmin(new Request(origin+'/api/admin/'+path,{method:body?'POST':'GET',headers,body:body&&JSON.stringify(body)}),{...envBase,DB:db});
   const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));
   return {data,cookie:res.headers.get('set-cookie')?.match(/^__Host-collect_admin=([a-f0-9]{64});/)?.[1]};
  });
 }
 async function native(phone,path,body,sql,params=[]){
  return frame('http_collect',async db=>{
   const headers={'x-burimunsi-auth':'phone_pin','x-burimunsi-installation':phone.install,'x-burimunsi-profile':phone.profile,
    'x-burimunsi-device':phone.device,'x-burimunsi-contract':'burimunsi.native.v1','x-burimunsi-request':randomUUID(),'x-burimunsi-generation':'1'};
   if(path!=='/session/login'){headers.authorization='Bearer '+phone.token;headers['x-burimunsi-group']=group;}
   if(body)headers['content-type']='application/json';
   const request=new Request(origin+'/v1/burimunsi'+path,{headers,method:body?'POST':'GET',body:body&&JSON.stringify(body)});
   const answer=await trustedGate({request,env:{...envBase,DB:db}},async()=>{
    if(path.startsWith('/session')&&!body){
     const snapshot=claimPhonePinReadSnapshot(db,group);
     assert.ok(snapshot);return Response.json({value:(await snapshot.unsafe(sql,params))[0]?.v});
    }
    const readSession=body==null;
    const transaction=readSession?db.withNativeReadSnapshot.bind(db):db.transaction.bind(db);
    const value=await transaction(async tx=>{
     if(!readSession)await db.context(tx);await applyPhonePinContext(db,tx,group);
     try{return (await tx.unsafe(sql,params))[0]?.v;} catch(error){if(process.env.BURIMUNSI_FIXTURE_DEBUG)console.error(path,error.message,error.where);throw error;}
    });return Response.json({value});
   });
   const result=await answer.json();assert.equal(answer.status,200,JSON.stringify(result));return sql?result.value:result.data;
  });
 }
 const sign=async device=>{const v=await native(device,'/session/login',{phone:device.number,pin});device.token=v.token;return v;};
 const consent=device=>native(device,'/sms/observation-consent',null,'SELECT private.burimunsi_observation_consent_current() v');
 const treasury=async()=>{await owner.query('BEGIN');try{await owner.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
  return (await owner.query('SELECT collection_id,receiving_account_id,enabled,active_binding_id,binding_version,version FROM private.burimunsi_scopes ORDER BY collection_id')).rows;
 }finally{await owner.query('ROLLBACK');}};
 try{
  await admin.query("UPDATE app.momo_receiving_accounts SET status='active',profile_status='approved',profile_version=$1,profile_json=$2 WHERE id='browser-fixture-wallet'",[testProfile.profile_version,testProfile.profile_json]);
  const before=await treasury(),A=newPhone('+250780000058'),B=newPhone('+250780000070','staff'),staff=newPhone('+250780000059');
  const login=await browser('auth/phone-passcode',{phone:A.number,pin});const session=await browser('auth/session',null,login);
  const auth={cookie:login.cookie,csrf:session.data.csrfToken};
  const created=await browser('team/accounts',{requestId:randomUUID(),displayName:'Second handset Admin',phone:B.number,role:'admin'},auth);
  assert.ok(created.data.id);
  // Configure a valid reduced native capability set in the synthetic account.
  // Team's approval remains authoritative and no installation has been created.
  await admin.query('BEGIN');
  try{
   await admin.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
   await admin.query("UPDATE private.burimunsi_accounts SET capabilities=ARRAY['records.read'],version=version+1,credential_version=credential_version+1 WHERE id=$1",[created.data.id]);
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
  assert.deepEqual((await admin.query('SELECT id FROM private.burimunsi_device_grants WHERE installation_id=ANY($1::uuid[])',[[A.install,B.install]])).rows,[]);
  const signed=await Promise.all([sign(A),sign(B),sign(staff)]);assert.equal(signed[0].profile.role,'admin');assert.equal(signed[1].profile.role,'admin');assert.deepEqual(signed[1].profile.capabilities,['records.read']);
  assert.notEqual(signed[0].profile.id,signed[1].profile.id);assert.equal(signed[2].profile.role,'staff');
  for(const device of [A,B])assert.deepEqual(await consent(device),{enabled:true,generation:1});
  await assert.rejects(()=>consent(staff),e=>e.code==='42501'||e.status===403);
  const original=(await admin.query('SELECT id,installation_id,custodian_account_id FROM private.burimunsi_device_grants WHERE installation_id=ANY($1::uuid[])',[[A.install,B.install]])).rows;
  assert.equal(original.length,2);assert.ok(original.every(x=>x.custodian_account_id===null));
  const disabled=await native(B,'/sms/observation-consent',{enabled:false,generation:2},'SELECT private.burimunsi_observation_set_consent(false,2) v');
  assert.deepEqual(disabled,{enabled:false,generation:2});await sign(B);
  assert.deepEqual(await consent(B),disabled);assert.deepEqual(await consent(A),{enabled:true,generation:1});
  B.device=randomBytes(32).toString('hex');
  await admin.query('UPDATE private.burimunsi_device_grants SET token_hash=$2,version=version+1 WHERE installation_id=$1',[B.install,sha(B.device)]);
  await sign(B);assert.deepEqual(await consent(B),{enabled:false,generation:3});
  await native(B,'/sms/observation-consent',{enabled:true,generation:4},'SELECT private.burimunsi_observation_set_consent(true,4) v');
  const renewed=await native(B,'/session?include=home',null,"SELECT installation_id v FROM private.burimunsi_pin_context()");
  assert.equal(renewed,B.install);
  const inventory=device=>native(device,'/sms/observations/reconcile-verified-status?scope=installation',null,'SELECT private.burimunsi_observation_reconcile_verified_status() v');
  const emptyA=await inventory(A),emptyB=await inventory(B);
  assert.equal(emptyA.recordedCount,0);assert.equal(emptyB.recordedCount,0);assert.notEqual(emptyA.revision,emptyB.revision);
  const run=randomUUID();
  const report={runId:run,state:'checking',expectedConsentGeneration:1,candidateCount:0,missingCount:0,pendingCount:0,phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null};
  const checkpoint=(device,p)=>native(device,'/sms/observations/inbox-check',p,'SELECT private.burimunsi_observation_inbox_check($1::jsonb) v',[JSON.stringify(p)]);
  await checkpoint(A,report);
  assert.equal((await checkpoint(A,{...report,state:'verified',collectionRevision:emptyA.revision})).state,'verified');
  const originB=await native(B,'/sms/observation-profile',null,'SELECT private.burimunsi_observation_context() v');
  const request=randomUUID(),hash=sha(['collect.storage.entity.v1','burimunsi.native.observation.v1',originB.principalUserId,request].join('\n'));
  const source=[hash.slice(0,8),hash.slice(8,12),'5'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20,32)].join('-');
  const key=sha('synthetic B-only row'),body=sha('synthetic B-only SMS'),content=sha('synthetic B-only content');
  const prepared=await native(B,'/sms/observations',{requestId:request},'SELECT private.burimunsi_observation_key_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9) v',
   [key,content,body,request,sha('request fingerprint'),source,originB.profile_version,originB.profile_sha256,originB.consentGeneration]);
  assert.equal(prepared.kind,'new');assert.equal(prepared.context.sourceId,source);
  assert.equal((await inventory(B)).hasPending,true);assert.deepEqual(await inventory(A),emptyA);
  assert.equal(await native(A,'/sms/observations/reconcile',{sourceKey:key},'SELECT private.burimunsi_observation_key_lookup($1,$2,$3) v',[key,content,body]),null);
  assert.equal((await native(A,'/sms/observations/processing-status',{sourceIds:[source]},'SELECT private.burimunsi_observation_processing_status($1::jsonb) v',[JSON.stringify([source])])).statuses[0].status,'unknown');
  const stopped=await browser('team/accounts/'+created.data.id+'/access',{requestId:randomUUID(),expectedVersion:2,active:false},auth);
  assert.equal(stopped.data.applied,true);
  await assert.rejects(()=>consent(B),e=>e.code==='session_unavailable'||e.status===401||e.code==='42501');
  assert.deepEqual(await inventory(A),emptyA);
  assert.deepEqual(await treasury(),before);
  return {arbitraryAdminInstalls:2,normalPhonePinSessions:true,staffDenied:true,revokedAdminDenied:true,scopedInventory:true,explicitRefusalPreserved:true,treasuryUnchanged:true};
 }finally{await pool.end();}
}
