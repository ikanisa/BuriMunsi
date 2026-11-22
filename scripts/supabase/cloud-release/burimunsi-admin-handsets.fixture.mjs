// Synthetic PG17 phone/PIN sessions in the actual managed-schema predecessor.
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import '../../../supabase/functions/_shared/tests/helpers/node-postgres-import.mjs';
import {ownedFixturePool} from '../../../supabase/tests/burimunsi/postgres-fixture-pool.mjs';
import {PostgresDatabase} from '../../../supabase/functions/_shared/postgres.js';
import {sqlFenceBackend,openApplicationWork} from '../../../supabase/functions/_shared/application-fence.js';
import {createPhonePinRequestGate,applyPhonePinContext,claimPhonePinReadSnapshot} from '../../../supabase/functions/_shared/domain/burimunsi/phone-pin-request.js';
import {PinHasher} from '../../../supabase/functions/_shared/domain/burimunsi/pin.js';
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
 async function migrate(names){
  const control=(await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
  const args=[randomUUID(),control.epoch,control.source_sha256];
  await owner.query('SELECT private.collect_fence_begin_quiesce($1,$2,$3)',args);
  await owner.query('SELECT private.collect_fence_drain($1,$2,$3)',args);
  const mode=(await owner.query('SELECT mode FROM private.collect_fence_control WHERE singleton')).rows[0].mode;
  assert.equal(mode,'fenced');
  for(const name of names)await owner.query(await file(name));
  await owner.query('SELECT private.collect_fence_release_v3($1,$2,$3)',[randomUUID(),control.epoch,control.source_sha256]);
  return control.source_sha256;
 }
 // These provider schemas are separate services in production. The
 // socket-only authentication fixture carries their empty monitor relations.
 await admin.query(`CREATE SCHEMA IF NOT EXISTS collect_sms;
  CREATE TABLE IF NOT EXISTS collect_sms.messages(message_id text PRIMARY KEY,application_id text,kind text,idempotency_key text,state text,text text);
  CREATE TABLE IF NOT EXISTS collect_sms.devices(last_seen_at text,ready bigint,revoked_at text,allowed_kinds text);
  ALTER TABLE collect_sms.messages OWNER TO postgres;ALTER TABLE collect_sms.devices OWNER TO postgres;
  GRANT USAGE ON SCHEMA collect_sms TO postgres`);
 const source=await migrate(['20261117180000_burimunsi_observation_reconcile_status.sql','20261117190000_burimunsi_legacy_reconcile.sql',
  '20261122191000_burimunsi_sms_completeness.sql','20261122191100_burimunsi_payment_sms_obligations.sql','20261122191200_burimunsi_known_device_login_budget.sql',
  '20261122200000_burimunsi_admin_handset_intake.sql','20261122201000_burimunsi_admin_inbox_coverage.sql']);
 const pool=await ownedFixturePool({root:fixtureRoot,socket,port:Number(port),database,user:'postgres',clusterName:target.cluster});
 const backend=sqlFenceBackend(pool,pool);
 const gateOptions={origin,secrets:{pinPepper:Buffer.alloc(32,29),pinPepperId:'fixture'},networkBucket:async()=>sha('local fixture network')};
 const trustedGate=createPhonePinRequestGate(gateOptions);
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
   const gate=phone.clock===undefined?trustedGate:createPhonePinRequestGate({...gateOptions,clock:()=>phone.clock});
   const answer=await gate({request,env:{...envBase,DB:db}},async()=>{
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
  const dashboard=(browserSession,sql,args=[])=>frame('http_admin',db=>db.transaction(async tx=>{
   await db.context(tx);
   await tx.unsafe('SELECT private.burimunsi_browser_pin_set_context($1,$2,$3)',[group,sha(browserSession.cookie),origin]);
   return (await tx.unsafe(sql,args))[0]?.v;
  }));
  let dashboardLogin;
  const coverage=()=>dashboard(dashboardLogin,'SELECT private.burimunsi_observation_admin_inbox_check($1) v',[group]);
  const created=await browser('team/accounts',{requestId:randomUUID(),displayName:'Second handset Admin',phone:B.number,role:'admin'},auth);
  assert.ok(created.data.id);
  // Configure a valid reduced native capability set in the synthetic account.
  // Team's approval remains authoritative and no installation has been created.
  await admin.query('BEGIN');
  try{
   await admin.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
   await admin.query("UPDATE private.burimunsi_accounts SET capabilities=ARRAY['records.read'],version=version+1,credential_version=credential_version+1 WHERE id=$1",[created.data.id]);
   const hash=await new PinHasher({pepper:Buffer.alloc(32,29),pepperId:'fixture'}).hash('+250780000031',pin);
   const primed=await admin.query("UPDATE private.burimunsi_accounts SET pin_hash=$1,version=version+1,credential_version=credential_version+1 WHERE collection_id=$2 AND principal_user_id='synthetic-primary' AND role='admin'",[hash,group]);
   assert.equal(primed.rowCount,1);
   await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
  const ownerLogin=await browser('auth/phone-passcode',{phone:'+250780000031',pin});
  dashboardLogin=ownerLogin;
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
  async function emptySweep(device,generation){
   const inventoryBefore=await inventory(device);assert.equal(inventoryBefore.recordedCount,0);
   const start={...report,runId:randomUUID(),expectedConsentGeneration:generation};
   await checkpoint(device,start);
   assert.equal((await checkpoint(device,{...start,state:'verified',collectionRevision:inventoryBefore.revision})).state,'verified');
  }
  // Start the independently tested account-switch scenarios in a fresh budget
  // window. All subsequent PIN attempts still pass the ordinary rate limits.
  await admin.query('UPDATE private.burimunsi_pin_login_limits SET window_start=window_start-900000 WHERE window_start=(floor(extract(epoch FROM clock_timestamp())*1000)::bigint/900000)*900000');
  const shared={...A,number:'+250780000031'},staffOnFirst={...A,number:staff.number};
  // Both old PIN sessions were genuinely created through password verification;
  // the old issue clock can legally coincide on the same physical installation.
  shared.clock=A.clock=Date.now()-100;
  await sign(shared);await sign(A);
  delete shared.clock;delete A.clock;
  await emptySweep(A,1);await emptySweep(B,4);
  // This Team operator has genuine collection approval and a browser SMS
  // grant, while no member/owner record represents them in the savings group.
  const list='SELECT private.burimunsi_observation_admin_collections() v',page='SELECT private.burimunsi_observation_admin_page($1,1,0) v';
  const denied=e=>e.code==='42501';
  assert.equal((await coverage()).state,'unknown');
  await assert.rejects(()=>dashboard(login,list),e=>denied(e)&&e.message==='group_access_denied');
  await migrate(['20261122202000_burimunsi_current_admin_inbox_authority.sql','20261122203000_burimunsi_phone_admin_sms_read_scope.sql']);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS collect_ops;CREATE SCHEMA IF NOT EXISTS cron;
   CREATE TABLE IF NOT EXISTS cron.job(jobid bigint PRIMARY KEY,active boolean,jobname text,schedule text,command text,database text);
   CREATE TABLE IF NOT EXISTS collect_ops.jobs_config(singleton boolean,enabled boolean,cron_job_id bigint);
   CREATE TABLE IF NOT EXISTS collect_ops.jobs_dispatches(id uuid PRIMARY KEY,kind text,state text,observed_at timestamptz,response_sha256 text);
   CREATE TABLE IF NOT EXISTS private.collect_managed_job_tickets(dispatch_id uuid,completed_at timestamptz,response_sha256 text);
   GRANT USAGE ON SCHEMA collect_ops,cron TO postgres;GRANT SELECT ON ALL TABLES IN SCHEMA collect_ops,cron TO postgres;
   GRANT SELECT ON private.collect_managed_job_tickets TO postgres`);
  const publicSequenceAccess=await owner.query("SELECT bool_or(has_sequence_privilege(r,'private.burimunsi_handset_signin_order','USAGE,SELECT,UPDATE')) AS granted FROM unnest(ARRAY['anon','authenticated','service_role','collect_runtime','collect_importer']) AS roles(r)");
  assert.equal(publicSequenceAccess.rows[0].granted,false);
  assert.equal((await dashboard(login,list))[0].collectionId,group);
  assert.equal((await dashboard(login,page,[group])).collectionId,group);
  await assert.rejects(()=>dashboard(login,page,['another-collection']),denied);
  assert.ok((await dashboard(login,'SELECT private.burimunsi_admin_sms_health() v')).burimunsi_sms);
  assert.ok((await dashboard(login,'SELECT private.burimunsi_admin_sms_operations() v')).payer);
  const staffBrowser=await browser('auth/phone-passcode',{phone:staff.number,pin});
  await assert.rejects(()=>dashboard(staffBrowser,list),denied);
  const teamPrincipal=await dashboard(login,"SELECT private.burimunsi_browser_pin_session($1,$2,$3)->>'principalId' v",[group,sha(login.cookie),origin]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM app.memberships WHERE user_id=$1',[teamPrincipal])).rows[0].n,0);
  await assert.rejects(()=>dashboard(login,"SELECT private.assert_actor('payments.read',$1,'admin',1,NULL) v",[group]),denied);
  const rawReceipt='SELECT private.burimunsi_observation_admin_source($1,$2) v',nonexistentSource=randomUUID();
  assert.equal(await dashboard(login,rawReceipt,[group,nonexistentSource]),null);
  assert.equal((await admin.query("DELETE FROM app.admin_grants WHERE user_id=$1 AND permission='sms.reveal'",[teamPrincipal])).rowCount,1);
  assert.equal((await dashboard(login,page,[group])).collectionId,group);
  await assert.rejects(()=>dashboard(login,rawReceipt,[group,nonexistentSource]),denied);
  assert.equal((await dashboard(ownerLogin,list))[0].collectionId,group);
  dashboardLogin=login;
  const ambiguous=await coverage();assert.equal(ambiguous.state,'unknown');assert.equal(ambiguous.candidateCount,null);
  // On the upgraded server an equally timed, serialized new sign-in selects
  // the genuine current account. A different phone's completed check survives.
  shared.clock=A.clock=Date.now()-100;
  await sign(A);await sign(shared);
  delete shared.clock;delete A.clock;
  assert.equal((await consent(shared)).enabled,true);assert.equal((await coverage()).state,'unknown');
  await emptySweep(shared,1);assert.equal((await coverage()).state,'verified');
  await sign(A);assert.equal((await coverage()).state,'unknown');
  await emptySweep(A,1);
  assert.equal((await coverage()).state,'verified');
  await sign(shared);
  await native(shared,'/sms/observation-consent',{enabled:false,generation:2},'SELECT private.burimunsi_observation_set_consent(false,2) v');
  assert.equal((await coverage()).state,'verified'); // only B remains
  await sign(shared);assert.equal((await consent(shared)).enabled,false);
  assert.equal((await coverage()).state,'verified');
  await sign(staffOnFirst);await assert.rejects(()=>consent(staffOnFirst),e=>e.code==='42501'||e.status===403);
  assert.equal((await coverage()).state,'verified');
  await sign(A);assert.equal((await coverage()).state,'unknown');await emptySweep(A,1);
  assert.equal((await coverage()).state,'verified');
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
  assert.equal((await coverage()).state,'incomplete');
  // Suspend the upstream person alone. The native account and handset still
  // carry their previous active flags, so only a current root check can see it.
  const principal=originB.principalUserId;
  const nativeFlags=()=>admin.query('SELECT a.active,c.enabled FROM private.burimunsi_accounts a JOIN private.burimunsi_observation_consents c ON c.account_id=a.id WHERE a.collection_id=$1 AND a.principal_user_id=$2 AND c.installation_id=$3',[group,principal,B.install]);
  assert.deepEqual((await nativeFlags()).rows,[{active:true,enabled:true}]);
  assert.equal((await admin.query("UPDATE app.users SET access_status='suspended',revision=revision+1 WHERE id=$1 AND access_status='active'",[principal])).rowCount,1);
  assert.deepEqual((await nativeFlags()).rows,[{active:true,enabled:true}]);
  assert.equal((await coverage()).state,'verified');
  await assert.rejects(()=>consent(B),e=>e.code==='session_unavailable'||e.status===401||e.code==='42501');
  await admin.query("UPDATE app.users SET access_status='active',revision=revision+1 WHERE id=$1",[principal]);
  assert.equal((await coverage()).state,'unknown'); // old login predates the changed upstream principal
  await sign(B);
  const reconnect={...report,runId:randomUUID(),expectedConsentGeneration:4};
  await checkpoint(B,reconnect);
  assert.equal((await coverage()).state,'checking');
  const stopped=await browser('team/accounts/'+created.data.id+'/access',{requestId:randomUUID(),expectedVersion:2,active:false},auth);
  assert.equal(stopped.data.applied,true);
  await assert.rejects(()=>consent(B),e=>e.code==='session_unavailable'||e.status===401||e.code==='42501');
  assert.deepEqual(await inventory(A),emptyA);
  const ownerSession=await browser('auth/session',null,ownerLogin);
  // A current browser cookie also fails immediately on upstream suspension.
  await admin.query("UPDATE app.users SET access_status='suspended',revision=revision+1 WHERE id=$1",[teamPrincipal]);
  await assert.rejects(()=>dashboard(login,list),denied);
  await assert.rejects(()=>dashboard(login,page,[group]),denied);
  await admin.query("UPDATE app.users SET access_status='active',revision=revision+1 WHERE id=$1",[teamPrincipal]);
  const fresh=await browser('auth/phone-passcode',{phone:A.number,pin});
  assert.equal((await dashboard(fresh,page,[group])).collectionId,group);
  const off=await browser('team/accounts/'+signed[0].profile.id+'/access',{requestId:randomUUID(),expectedVersion:1,active:false},
   {cookie:ownerLogin.cookie,csrf:ownerSession.data.csrfToken});
  assert.equal(off.data.applied,true);await assert.rejects(()=>dashboard(fresh,page,[group]),denied);
  assert.equal((await dashboard(ownerLogin,list))[0].collectionId,group);
  assert.equal(ownerSession.data.user.role,'admin');
  assert.deepEqual(await treasury(),before);
  return {arbitraryAdminInstalls:2,normalPhonePinSessions:true,staffDenied:true,revokedAdminDenied:true,scopedInventory:true,explicitRefusalPreserved:true,sharedAndTeamAdmin:true,switchedHandsetCountedOnce:true,legacyTieUnknown:true,upstreamSuspensionExcluded:true,teamScopedDashboard:true,independentSensitiveAndFinancialGrants:true,treasuryUnchanged:true};
 }finally{await pool.end();}
}
