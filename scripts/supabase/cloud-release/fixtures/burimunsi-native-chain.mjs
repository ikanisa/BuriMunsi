// Private PG17 fixture for the native receipt. Only the authenticated actor,
// fenced jobs admission, approved test wallet and object store are simulated.
// Receipt, parse, transaction, credit and notice SQL come from the migrations.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonicalJson} from '../../../../supabase/functions/_shared/domain/burimunsi/values.js';

export const sha=value=>createHash('sha256').update(value).digest('hex');
export const nativePrincipal='fixture-receiver';
export const uuid=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const testProfile={provider:'mtn_momo',status:'active',profile_status:'approved',profile_version:'synthetic-v1',currency:'RWF',timezone:'Africa/Kigali',
 profile_json:JSON.stringify({sender_allowlist:['+15555219877'],currency_aliases:['RWF'],incoming_prefixes:['You have received'],
  transaction_id_prefixes:['FT Id:'],date_format:'YMD_HMS',utc_offset_minutes:120})};
export function nativeActor(group){
 return {collectionId:group,accountId:uuid(1),principalUserId:nativePrincipal,installationId:uuid(2),grantId:uuid(3),grantVersion:1,sessionId:uuid(4)};
}
const migrations=new URL('../../../../supabase/migrations/',import.meta.url);
const file=async name=>readFile(new URL(name,migrations),'utf8');
function routine(sql,name){
 const start=sql.indexOf('CREATE FUNCTION private.'+name+'('),end=sql.indexOf('$fn$;',sql.indexOf('AS $fn$',start)+8);
 assert.ok(start>=0&&end>start,name);return sql.slice(start,end+6);
}
function block(sql,name){
 const tag='$'+name+'$',start=sql.indexOf('DO '+tag),end=sql.indexOf('END;'+tag+';',start);
 assert.ok(start>=0&&end>start,name);return sql.slice(start,end+5+tag.length);
}
export async function installNativeChain(client,group){
 const q=(sql,args)=>client.query(sql,args);
 const [base,obs,dedup,auto,posting,identity,review,completion,processing,reconcile]=await Promise.all([
  '20261020134444_collect_curated_platform_baseline.sql','20261111121000_burimunsi_private_observations.sql',
  '20261113130000_burimunsi_native_observation_dedup.sql','20261112200100_burimunsi_native_auto_transactions.sql',
  '20261113130900_burimunsi_native_sms_posting.sql','20261114102000_burimunsi_native_event_identity.sql',
  '20261117090952_burimunsi_native_parse_review.sql','20261122191000_burimunsi_sms_completeness.sql',
  '20261117134954_burimunsi_observation_processing_status.sql','20261117180000_burimunsi_observation_reconcile_status.sql'].map(file));
 await q("SET search_path=app,pg_catalog");
 await q(base.slice(base.indexOf('CREATE FUNCTION app.json_valid'),base.indexOf('CREATE TABLE users ')));
 const appTables=['payment_evidence','payment_intents','momo_parse_attempts','momo_transaction_sources','sms_receipts','admin_bridge_guards','audit_log',
  'momo_gateway_bindings','momo_gateway_captures','momo_gateway_credentials','momo_processing_jobs'];
 for(const table of appTables){
  const definition=base.split('\n').find(line=>line.startsWith('CREATE TABLE '+table+' '));
  assert.ok(definition,table);await q(definition.replace('CREATE TABLE ','CREATE TABLE app.'));
 }
 await q(`
 ALTER TABLE app.users ADD COLUMN full_name text;
 ALTER TABLE app.collections ADD COLUMN title text DEFAULT 'BuriMunsi QA', ADD COLUMN receiver_display_label text DEFAULT 'Test receiving wallet';
 ALTER TABLE app.payments ADD COLUMN intent_id text,ADD COLUMN revision bigint,ADD COLUMN payer_display_name text,ADD COLUMN created_at text;
 ALTER TABLE app.ledger_entries ADD COLUMN actor_user_id text,ADD COLUMN request_id text,ALTER COLUMN currency SET DEFAULT 'RWF';
 CREATE UNIQUE INDEX fixture_contribution_once ON app.ledger_entries(payment_id) WHERE kind='contribution';
 ALTER TABLE app.contribution_posting_snapshots ADD COLUMN group_balance_after_minor bigint,ADD UNIQUE(payment_id);
 ALTER TABLE app.momo_transactions ADD COLUMN provider text,ADD COLUMN currency_scale bigint,ADD COLUMN payer_name text,ADD COLUMN payer_last3 text,
  ADD COLUMN transaction_datetime_raw text,ADD COLUMN transaction_timezone text,ADD COLUMN fee_minor bigint,ADD COLUMN wallet_balance_after_minor bigint,
  ADD COLUMN parse_attempt_id text,ADD COLUMN created_at text,ADD COLUMN updated_at text,ADD COLUMN version bigint NOT NULL DEFAULT 1,
  ALTER COLUMN has_conflict SET DEFAULT 0,ADD UNIQUE(receiving_account_id,provider,event_kind,provider_transaction_id);
 ALTER TABLE app.momo_financial_links ADD COLUMN linked_by text,ADD COLUMN reason text,ADD COLUMN created_at text,ADD UNIQUE(transaction_id),ADD UNIQUE(payment_id);
 ALTER TABLE app.notification_events ADD COLUMN title text,ADD COLUMN body text,ADD COLUMN status text;
 ALTER TABLE app.sms_receipts ALTER COLUMN originating_session_id DROP NOT NULL,ALTER COLUMN receiver_hash DROP NOT NULL;
 CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY,provider text,public_code text,status text,timezone text);
 CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY,receiving_account_id text,active_binding_id text);
 CREATE TABLE private.burimunsi_observation_requests(source_id text PRIMARY KEY,collection_id text,account_id uuid,principal_user_id text,installation_id uuid,
   grant_id uuid,grant_version bigint,native_session_id uuid,request_id uuid,fingerprint text,initial_profile_version text,initial_profile_sha256 text,
   initial_profile_tuple_sha256 text,initial_consent_generation bigint,created_at bigint,UNIQUE(collection_id,account_id,request_id));
 ALTER TABLE private.burimunsi_unresolved_observations ADD PRIMARY KEY(source_id),ADD COLUMN account_id uuid,ADD COLUMN principal_user_id text,
   ADD COLUMN installation_id uuid,ADD COLUMN grant_id uuid,ADD COLUMN grant_version bigint,ADD COLUMN native_session_id uuid,ADD COLUMN request_id uuid,
   ADD COLUMN fingerprint text,ADD COLUMN body_sha256 text,ADD COLUMN object_key text,ADD COLUMN object_sha256 text,ADD COLUMN size_bytes bigint,
   ADD COLUMN profile_version text,ADD COLUMN profile_sha256 text,ADD COLUMN profile_tuple_sha256 text,ADD COLUMN consent_generation bigint;
 CREATE TABLE private.burimunsi_native_receipt_origins(source_id text PRIMARY KEY,collection_id text,account_id uuid,principal_user_id text,installation_id uuid,
   grant_id uuid,grant_version bigint,capture_session_id uuid,admitting_session_id uuid,admission_kind text,request_id uuid,fingerprint text,body_sha256 text,object_sha256 text);
 ALTER TABLE private.burimunsi_auto_sms_jobs ADD PRIMARY KEY(source_id),ADD COLUMN receiving_account_id text,ADD COLUMN source_fingerprint text,ADD COLUMN profile_sha256 text,
   ADD COLUMN phase text,ADD COLUMN lease_token uuid,ADD COLUMN lease_until bigint,ADD COLUMN dispatched_at bigint,ADD COLUMN dispatch_count integer DEFAULT 0,
   ADD COLUMN next_attempt_at bigint,ADD COLUMN last_error text,ADD COLUMN retry_lease uuid,ADD COLUMN attempt_id uuid,ADD COLUMN facts_sha256 text,
   ADD COLUMN payment_outcome text,ADD COLUMN updated_at bigint,ADD COLUMN event_identity_sha256 text,ADD COLUMN event_inbox_sha256 text,ADD COLUMN event_has_service_time boolean DEFAULT false,
   ADD COLUMN invalid_output_count bigint DEFAULT 0,ADD COLUMN posting_facts jsonb,ADD COLUMN posting_output jsonb,ADD COLUMN posting_last_error text,
   ALTER COLUMN posting_next_attempt_at SET DEFAULT 0,ALTER COLUMN attempt_count SET DEFAULT 1,ALTER COLUMN posting_failure_count SET DEFAULT 0;
 ALTER TABLE private.burimunsi_transaction_scopes ADD COLUMN source_binding_id text,ADD COLUMN source_binding_version bigint,ADD COLUMN created_at bigint,ADD UNIQUE(transaction_id);
 CREATE TABLE private.burimunsi_observation_consents(collection_id text,account_id uuid,installation_id uuid,grant_id uuid,grant_version bigint,generation bigint,enabled boolean);
 CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,active boolean,removed boolean,role text,PRIMARY KEY(id,collection_id));
 CREATE TABLE private.burimunsi_device_grants(id uuid,collection_id text,version bigint,installation_id uuid,active boolean,profile text,PRIMARY KEY(id,collection_id));
 CREATE TABLE private.burimunsi_device_accounts(account_id uuid,grant_id uuid,collection_id text);
 CREATE FUNCTION private._collect_fence_no_erasure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE insufficient_privilege;END$$;
 CREATE FUNCTION private.burimunsi_observation_history_rows(text) RETURNS SETOF private.burimunsi_unresolved_observations LANGUAGE sql SECURITY DEFINER AS $$
  SELECT * FROM private.burimunsi_unresolved_observations WHERE source_id=$1 AND collection_id=current_setting('burimunsi.collection_id')$$;
 CREATE FUNCTION private.collect_imported_native_job_transaction(text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE TABLE private.collect_imported_native_history(source_id text,collection_id text,request_id uuid,body_sha256 text,object_sha256 text,source_fingerprint text,transaction_id text);
 CREATE FUNCTION private.collect_imported_native_source(text) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM private.collect_imported_native_history WHERE source_id=$1)$$;
 CREATE FUNCTION private.burimunsi_auto_candidates(p_collection text) RETURNS SETOF text LANGUAGE sql AS $$
 SELECT o.source_id FROM private.burimunsi_unresolved_observations o
 WHERE NOT private.collect_imported_native_source(o.source_id) AND o.collection_id=p_collection$$;

 CREATE TABLE private.burimunsi_sms_source_scopes(source_id text,collection_id text,owner_user_id text,source_body_sha256 text,object_sha256 text,binding_id text,
   binding_version bigint,installation_id uuid,custodian_account_id uuid,grant_id uuid,grant_version bigint,associated_at timestamptz,receiving_account_id text,provenance text,proof_id text,credential_id text);
 CREATE TABLE private.storage_namespace(singleton boolean,origin text,bucket text);
 INSERT INTO private.storage_namespace VALUES(true,'https://fixture.invalid','private-evidence');
 CREATE TABLE private.storage_put_intents(object_key text PRIMARY KEY,operation_id text,sha256 text,size bigint,scope jsonb,http_metadata jsonb,custom_metadata jsonb,
   state text,active_attempt text,upload_unresolved boolean,delete_tombstone boolean,fingerprint text);
 CREATE TABLE private.storage_objects(LIKE private.storage_put_intents INCLUDING ALL);
 CREATE TABLE private.storage_payload_reservations(object_key text PRIMARY KEY,scope jsonb,aad text,key_id text,plaintext_sha256 text,source_fingerprint text,sealed_body text,cleared_at text);
 CREATE TABLE private.storage_delete_intents(object_key text PRIMARY KEY);
 CREATE FUNCTION private.burimunsi_setup_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('role',true)<>'collect_runtime' OR current_setting('collect.edge_verified',true)<>'true' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION private.burimunsi_observation_actor(boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT current_setting('fixture.native_actor')::jsonb$$;
 CREATE FUNCTION private.burimunsi_observation_context() RETURNS jsonb LANGUAGE sql AS $$SELECT current_setting('fixture.native_context')::jsonb$$;
 CREATE FUNCTION private.burimunsi_observation_consent_current() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"enabled":true,"generation":1}'::jsonb$$;
 CREATE FUNCTION private.burimunsi_auto_snapshot(p_source text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
 DECLARE a jsonb:=private.burimunsi_observation_actor(false);proof jsonb;
 BEGIN
  PERFORM private.burimunsi_setup_fence();
  IF current_setting('test.work_kind',true) IS DISTINCT FROM 'jobs' THEN RAISE insufficient_privilege;END IF;
  proof:=private.burimunsi_observation_own(p_source,false);
  IF proof IS NULL THEN RAISE insufficient_privilege;END IF;
 IF private.collect_imported_native_source(p_source) OR private.collect_imported_native_job_transaction(p_source) THEN RAISE insufficient_privilege;END IF;
  RETURN jsonb_build_object('kind','jobs','actor',a||'{"sessionId":null}'::jsonb,'proof',proof||'{"sessionId":null}'::jsonb,
   'profile',jsonb_build_object('profileSha256',current_setting('fixture.native_context')::jsonb->>'profile_sha256','profile',current_setting('fixture.native_profile')::jsonb));END$$;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO collect_runtime;
 GRANT SELECT ON private.storage_namespace,private.storage_put_intents,private.storage_objects,private.storage_payload_reservations,private.storage_delete_intents TO collect_runtime;
 GRANT UPDATE ON private.storage_put_intents,private.storage_namespace TO collect_runtime;
 `);
 const actor=nativeActor(group),profileHash=sha(testProfile.profile_json);
 await q('INSERT INTO private.burimunsi_observation_consents VALUES($1,$2,$3,$4,1,1,true)',[group,actor.accountId,actor.installationId,actor.grantId]);
 await q("INSERT INTO private.burimunsi_accounts VALUES($1,$2,true,false,'admin')",[actor.accountId,group]);
 await q("INSERT INTO private.burimunsi_device_grants VALUES($1,$2,1,$3,true,'internal_receiver')",[actor.grantId,group,actor.installationId]);
 await q("INSERT INTO private.burimunsi_device_accounts VALUES($1,$2,$3)",[actor.accountId,actor.grantId,group]);
 const context={...actor,...testProfile,consentGeneration:1,profile_sha256:profileHash,profile_tuple_sha256:sha(canonicalJson(testProfile))};
 await q("SELECT set_config('fixture.native_actor',$1,false),set_config('fixture.native_context',$2,false),set_config('fixture.native_profile',$3,false),set_config('burimunsi.collection_id',$4,false)",
  [JSON.stringify(actor),JSON.stringify(context),JSON.stringify(testProfile),group]);
 await q("INSERT INTO app.momo_receiving_accounts VALUES('wallet','mtn_momo','0788000002','active','Africa/Kigali')");
 await q("INSERT INTO private.burimunsi_scopes VALUES($1,'wallet',NULL)",[group]);
 for(const fn of ['burimunsi_observation_prepare','burimunsi_observation_storage_matches','burimunsi_observation_own','burimunsi_observation_lookup','burimunsi_observation_commit','burimunsi_observation_page']){
  await q(routine(obs,fn));
 }
 await q(dedup);
 for(const fn of ['burimunsi_auto_plan','burimunsi_auto_begin','burimunsi_auto_dispatch','burimunsi_auto_finish'])await q(routine(auto,fn));
 for(const fn of ['burimunsi_native_sms_post_candidates','burimunsi_native_sms_post_snapshot','burimunsi_native_sms_post_facts'])await q(routine(posting,fn));
 await q(block(posting,'finish'));await q(routine(identity,'burimunsi_auto_event_bind'));await q(block(identity,'finish'));
 await q(block(review,'finish'));await q(block(review,'facts'));
 await q(routine(processing,'burimunsi_observation_processing_status'));await q(routine(reconcile,'burimunsi_observation_reconcile_status'));
 await q('DROP FUNCTION private._burimunsi_inbox_outcome(text,text)');await q(completion);
}

export function nativeRuntime(client,group){
 const objects=new Map();
 const env={DATA_KEY_ID:'fixture-key',DATA_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};
 const tx={unsafe:async(sql,args)=>{
   try{return (await client.query(sql,args)).rows;}
   catch(error){if(process.env.BURIMUNSI_FIXTURE_DEBUG)process.stderr.write(sql+' '+error.message+' '+(error.where??'')+'\n');throw error;}
 }};
 const run=(kind,{readOnly=false}={})=>async fn=>{
  await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
  try{
   await client.query("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'; SET LOCAL search_path=app,pg_catalog");
   await client.query("SELECT set_config('test.work_kind',$1,true),set_config('burimunsi.collection_id',$2,true)",[kind,group]);
   const result=await fn(tx);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');if(process.env.BURIMUNSI_FIXTURE_DEBUG)process.stderr.write(error.stack+' '+(error.where??'')+'\n');throw error;}
 };
 const media={
  namespace:{origin:'https://fixture.invalid',bucket:'private-evidence'},
  async get(key){const value=objects.get(key);return value?{text:async()=>value.sealed}:null;},
  async put(key,sealed,options){
   const descriptor={scope:options.scope,aad:options.aad,keyId:env.DATA_KEY_ID,plaintextSha256:options.customMetadata.sha256,
    requestDigest:options.sourceDigest,httpMetadata:options.httpMetadata,customMetadata:options.customMetadata};
   const sourceHash=sha(canonicalJson(descriptor)),prior=objects.get(key);
   if(prior){assert.equal(prior.sourceHash,sourceHash);return {key,stored:true,metadataCommitted:true};}
   const operation=sha('collect.storage.put.v1\n'+key),cipherHash=sha(sealed),custom={...options.customMetadata,source_fingerprint:sourceHash},size=Buffer.byteLength(sealed);
   const fingerprint=sha(canonicalJson({key,size,sha256:cipherHash,scope:options.scope,httpMetadata:options.httpMetadata,customMetadata:custom}));
   await client.query('BEGIN');
   try{
    await client.query("INSERT INTO private.storage_put_intents VALUES($1,$2,$3,$4,$5,$6,$7,'committed',NULL,false,false,$8)",
      [key,operation,cipherHash,size,options.scope,options.httpMetadata,custom,fingerprint]);
    await client.query('INSERT INTO private.storage_objects SELECT * FROM private.storage_put_intents WHERE object_key=$1',[key]);
    await client.query('INSERT INTO private.storage_payload_reservations VALUES($1,$2,$3,$4,$5,$6,$7,NULL)',
      [key,options.scope,options.aad,env.DATA_KEY_ID,descriptor.plaintextSha256,sourceHash,sealed]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');if(process.env.BURIMUNSI_FIXTURE_DEBUG)process.stderr.write(error.stack+' '+(error.where??'')+'\n');throw error;}
   objects.set(key,{sealed,sourceHash});return {key,stored:true,metadataCommitted:true};
  }
 };
 env.PRIVATE_MEDIA=media;
 const journal=async(tx,key)=>{
  const rows=await tx.unsafe('SELECT key_id,source_fingerprint FROM private.storage_payload_reservations WHERE object_key=$1',[key]);
  assert.equal(rows.length,1);return {reservation:rows[0],put:{object_key:key}};
 };
 return {env,objects,run,tx,journal};
}

// The managed-schema fixture runs the complete forward migration. The ledger
// fixture has only transaction/storage tables, so load the same inventory and
// witness routines against its small predecessors.
export async function installHandsetInventory(client){
 const migration=await file('20261122200000_burimunsi_admin_handset_intake.sql');
 const part=(from,to)=>{
  const start=migration.indexOf(from),end=migration.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start,from);return migration.slice(start,end);
 };
 await client.query(`ALTER TABLE app.momo_receiving_accounts ADD COLUMN profile_status text DEFAULT 'approved',
  ADD COLUMN profile_version text,ADD COLUMN profile_json text,ADD COLUMN currency text DEFAULT 'RWF';
  CREATE TABLE private.burimunsi_detection_profiles(collection_id text,expected_receiving_account_id text,revision bigint,enabled boolean,
   profile_version text,profile_json text,evidence_sha256 text);
  CREATE TABLE private.collect_migration_actor_lineage(source_actor_id text,cloud_primary_id text);
  ALTER TABLE private.collect_imported_native_history ADD UNIQUE(source_id);
  ALTER TABLE private.burimunsi_accounts ADD COLUMN principal_user_id text;`);
 await client.query('UPDATE private.burimunsi_accounts SET principal_user_id=$1',[nativePrincipal]);
 await client.query('UPDATE app.momo_receiving_accounts SET profile_version=$1,profile_json=$2',[testProfile.profile_version,testProfile.profile_json]);
 await client.query(routine(await file('20261117190000_burimunsi_legacy_reconcile.sql'),'burimunsi_observation_legacy_candidates'));
 await client.query(part('CREATE FUNCTION pg_temp.buri_handset_patch','-- Called only after normal PIN'));
 await client.query(part('CREATE TABLE private.burimunsi_handset_legacy_matches','DO $retention$'));
 await client.query(part('ALTER TABLE private.burimunsi_observation_requests DROP CONSTRAINT','-- Imported history is eligible'));
 await client.query(await file('20261122201000_burimunsi_admin_inbox_coverage.sql'));
}
