// The release migration runs unchanged against a private PG17 Unix socket.
// Synthetic predecessor tables and actor inputs isolate the new boundaries.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const sqlSource=name=>readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const account=uuid(1),device=uuid(2),grant=uuid(3),session=uuid(4);
const group='fixture-collection',profile=hash('profile'),tuple=hash('tuple');
const actor={collectionId:group,accountId:account,principalUserId:'fixture-owner',installationId:device,grantId:grant,grantVersion:1,sessionId:session};
const source=n=>uuid(100+n),key=n=>hash('phone-row-'+n),body=n=>hash('synthetic-receipt-'+n);
const fixtureSource=(request)=>{
 const h=hash(['collect.storage.entity.v1','burimunsi.native.observation.v1','fixture-owner',request].join('\n'));
 return [h.slice(0,8),h.slice(8,12),'5'+h.slice(13,16),'8'+h.slice(17,20),h.slice(20,32)].join('-');
};

test('isolated PG17 reconciles native and gateway pages, original consent, historical parses and scoped Admin evidence',async t=>{
 const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
 const sql=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
 t.after(async()=>{try{await sql.end();}finally{assert.equal((await cluster.close()).removed,true);}});
 await sql.connect();
 const execute=(s,args)=>sql.query(s,args);
 const call=async(s,args)=>(await execute(s,args)).rows[0]?.v;
 await execute(`
 CREATE ROLE postgres NOSUPERUSER NOBYPASSRLS; CREATE ROLE collect_runtime; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE collect_importer;
 CREATE SCHEMA private AUTHORIZATION postgres; CREATE SCHEMA app AUTHORIZATION postgres; SET ROLE postgres;
 GRANT USAGE ON SCHEMA private TO collect_runtime,anon,authenticated,collect_importer,service_role;
 CREATE TABLE private.collect_fence_control(singleton boolean,mode text);INSERT INTO private.collect_fence_control VALUES(true,'fenced');
 CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_user<>'postgres' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION private.burimunsi_setup_fence() RETURNS void LANGUAGE plpgsql AS $$BEGIN IF current_setting('role',true)<>'collect_runtime' OR current_setting('collect.edge_verified',true)<>'true' THEN RAISE insufficient_privilege;END IF;END$$;
 CREATE FUNCTION private._collect_fence_statement() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM private.burimunsi_setup_fence(); RETURN NULL;END$$;
 CREATE FUNCTION private._collect_fence_no_erasure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE insufficient_privilege;END$$;
 CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY,receiving_account_id text,active_binding_id text);
 CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,active boolean,removed boolean,role text,PRIMARY KEY(id,collection_id));
 CREATE TABLE private.burimunsi_device_grants(id uuid,collection_id text,version bigint,installation_id uuid,active boolean,profile text,PRIMARY KEY(id,collection_id));
 CREATE TABLE private.burimunsi_device_accounts(account_id uuid,grant_id uuid,collection_id text);
 CREATE TABLE private.burimunsi_observation_consents(collection_id text,account_id uuid,installation_id uuid,grant_id uuid,grant_version bigint,generation bigint,enabled boolean);
 CREATE TABLE private.burimunsi_observation_requests(source_id text PRIMARY KEY,collection_id text,account_id uuid,principal_user_id text,installation_id uuid,grant_id uuid,
  grant_version bigint,native_session_id uuid,request_id uuid,fingerprint text,initial_profile_version text,initial_profile_sha256 text,initial_profile_tuple_sha256 text,initial_consent_generation bigint,created_at bigint);
 CREATE TABLE private.burimunsi_unresolved_observations(source_id text PRIMARY KEY,collection_id text,request_id uuid,body_sha256 text,object_key text,object_sha256 text,size_bytes bigint,
  fingerprint text,principal_user_id text,installation_id uuid,account_id uuid,grant_id uuid,grant_version bigint,consent_generation bigint,profile_sha256 text,created_at bigint);
 CREATE TABLE private.burimunsi_native_receipt_origins(source_id text,collection_id text);
 CREATE TABLE private.collect_imported_native_history(source_id text,collection_id text,request_id uuid,body_sha256 text,object_sha256 text,source_fingerprint text,transaction_id text);
 CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text,collection_id text,receiving_account_id text,source_fingerprint text,profile_sha256 text,
  state text,relation text,transaction_id text,facts_sha256 text,posting_last_error text,last_error text,invalid_output_count bigint,attempt_id uuid);
 CREATE TABLE private.burimunsi_transaction_scopes(collection_id text,transaction_id text);
 CREATE TABLE private.burimunsi_sms_source_scopes(source_id text,collection_id text,owner_user_id text,source_body_sha256 text,object_sha256 text,binding_id text,
  binding_version bigint,installation_id uuid,custodian_account_id uuid,grant_id uuid,grant_version bigint,associated_at timestamptz,
  receiving_account_id text,provenance text,proof_id text,credential_id text);
 CREATE TABLE private.storage_put_intents(object_key text,operation_id text,sha256 text,size bigint,scope jsonb,http_metadata jsonb,custom_metadata jsonb,
   state text,active_attempt text,upload_unresolved boolean,delete_tombstone boolean);
 CREATE TABLE private.storage_objects(LIKE private.storage_put_intents);CREATE TABLE private.storage_delete_intents(object_key text);
 CREATE TABLE app.sms_receipts(id text,client_envelope_id text,owner_user_id text,object_key text,object_sha256 text,body_sha256 text,size_bytes bigint);
 CREATE TABLE app.momo_gateway_bindings(id text,version bigint,receiving_account_id text,status text);
 CREATE TABLE app.momo_gateway_credentials(id text,binding_id text,installation_id text,revoked_at text);
 CREATE TABLE app.momo_gateway_captures(raw_sms_id text,credential_id text,identity_sha256 text,subscription_id bigint);
 CREATE TABLE app.momo_processing_jobs(raw_sms_id text,binding_id text,binding_version bigint,receiving_account_id text,state text,last_error text);
 CREATE TABLE app.momo_transaction_sources(raw_sms_id text,transaction_id text,parse_attempt_id text,relation text);
 CREATE TABLE app.momo_transactions(id text,receiving_account_id text);
 CREATE TABLE app.momo_parse_attempts(id text,outcome text,raw_sms_id text,source_body_sha256 text,attempt_number bigint);
 CREATE FUNCTION private.burimunsi_observation_actor(boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('fixture.admin',true) IS DISTINCT FROM 'yes' OR current_setting('role',true)<>'collect_runtime' THEN RAISE insufficient_privilege;END IF;
  RETURN current_setting('fixture.actor')::jsonb;END$$;
 CREATE FUNCTION private.burimunsi_observation_consent_current() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('enabled',current_setting('fixture.consent',true)='on','generation',current_setting('fixture.generation')::bigint)$$;
 CREATE FUNCTION private.burimunsi_observation_context() RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN IF current_setting('fixture.consent',true) IS DISTINCT FROM 'on' THEN RAISE insufficient_privilege;END IF;
  RETURN private.burimunsi_observation_actor(false)||jsonb_build_object('consentGeneration',current_setting('fixture.generation')::int,
   'profile_tuple_sha256','${tuple}','profile_version','test','profile_sha256','${profile}');END$$;
 CREATE FUNCTION private.burimunsi_observation_admin_scope(g text,s boolean) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
  IF current_setting('fixture.web',true) IS DISTINCT FROM 'yes' OR g IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN RAISE insufficient_privilege;END IF;RETURN '{}'::jsonb;END$$;
 CREATE FUNCTION private.burimunsi_observation_reconcile_status() RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE a jsonb:=private.burimunsi_observation_context();n integer;rev text;BEGIN
  SELECT count(*),md5(coalesce(string_agg(source_id,',' ORDER BY source_id),'')) INTO n,rev FROM private.burimunsi_unresolved_observations WHERE collection_id=a->>'collectionId';
  RETURN jsonb_build_object('groupId',a->>'collectionId','hasPending',false,'hasRecorded',n>0,'recordedCount',n,'hasUnmatchedCanonical',false,'revision',rev||rev);END$$;
 CREATE FUNCTION private.burimunsi_observation_storage_matches(text,jsonb,text) RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('fixture.storage',true) IS DISTINCT FROM 'bad'$$;
 CREATE FUNCTION private.burimunsi_observation_own(text,boolean) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
 CREATE FUNCTION private.burimunsi_observation_history_rows(text) RETURNS SETOF private.burimunsi_unresolved_observations LANGUAGE sql AS $$SELECT * FROM private.burimunsi_unresolved_observations WHERE source_id=$1$$;
 CREATE FUNCTION private.collect_imported_native_source(text) RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT 1 FROM private.collect_imported_native_history WHERE source_id=$1)$$;
 CREATE FUNCTION private.collect_imported_native_job_transaction(text) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION private.burimunsi_auto_snapshot(p_source text) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF private.collect_imported_native_source(p_source) OR private.collect_imported_native_job_transaction(p_source)
  THEN RAISE EXCEPTION 'blocked' USING ERRCODE='55000';END IF; RETURN '{}'::jsonb;END$$;
 CREATE FUNCTION private.burimunsi_auto_candidates(p_collection text) RETURNS SETOF text LANGUAGE sql AS $$
 SELECT o.source_id FROM private.burimunsi_unresolved_observations o
 WHERE NOT private.collect_imported_native_source(o.source_id) AND o.collection_id=p_collection$$;
 CREATE FUNCTION private.burimunsi_observation_prepare(uuid,text,text,text,text,bigint) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
 CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$SELECT '{"private_classes":[]}'::jsonb$$;
 CREATE FUNCTION private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$BEGIN RETURN jsonb_build_array('managed:storage_iceberg');END$$;
 `);
 await execute(await sqlSource('20261113130000_burimunsi_native_observation_dedup.sql'));
 const original=await sqlSource('20261117134954_burimunsi_observation_processing_status.sql');
 const segment=original.slice(original.indexOf('CREATE FUNCTION private.burimunsi_observation_processing_status'),original.indexOf('-- No job is created'));
 await execute(segment);
 await execute(await sqlSource('20261122191000_burimunsi_sms_completeness.sql'));
 await execute("INSERT INTO private.burimunsi_scopes VALUES($1,'wallet',NULL)",[group]);
 await execute("INSERT INTO private.burimunsi_accounts VALUES($1,$2,true,false,'admin')",[account,group]);
 await execute("INSERT INTO private.burimunsi_device_grants VALUES($1,$2,1,$3,true,'internal_receiver')",[grant,group,device]);
 await execute('INSERT INTO private.burimunsi_device_accounts VALUES($1,$2,$3)',[account,grant,group]);
 await execute('INSERT INTO private.burimunsi_observation_consents VALUES($1,$2,$3,$4,1,1,true)',[group,account,device,grant]);
 const guc=(k,v)=>execute('SELECT set_config($1,$2,false)',[k,v]);
 await guc('fixture.actor',JSON.stringify(actor));await guc('fixture.generation','1');await guc('burimunsi.collection_id',group);
 await guc('fixture.admin','yes');await guc('fixture.web','yes');await guc('fixture.consent','on');await guc('collect.edge_verified','true');
 const runtime=()=>execute('SET ROLE collect_runtime'),owner=()=>execute('SET ROLE postgres');
 const summary=()=>call('SELECT private.burimunsi_observation_reconcile_verified_status() v');
 const admin=(collection=group)=>call('SELECT private.burimunsi_observation_admin_inbox_check($1) v',[collection]);
 const checkpoint=p=>call('SELECT private.burimunsi_observation_inbox_check($1::jsonb) v',[JSON.stringify(p)]);
 const page=(run,items)=>call('SELECT private.burimunsi_observation_inbox_page($1,$2::jsonb) v',[run,JSON.stringify(items)]);
 const statuses=ids=>call('SELECT private.burimunsi_observation_processing_status($1::jsonb) v',[JSON.stringify(ids)]);
 const opened=()=>({runId:randomUUID(),expectedConsentGeneration:1,state:'checking',candidateCount:0,missingCount:0,pendingCount:0,
  phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null});
 const entry=n=>({key:key(n),sourceId:source(n),bodySha256:body(n),inboxReceivedAt:n===1?'2026-11-21T12:00:00Z':'2026-11-22T12:00:00Z'});
 await runtime();assert.equal((await admin()).state,'unknown');
 const empty=opened();await checkpoint(empty);const emptyEnd={...empty,state:'verified',collectionRevision:(await summary()).revision};await checkpoint(emptyEnd);
 assert.equal((await admin()).headsMatch,true);
 for(const ignored of ['anon','authenticated','service_role','collect_importer']){
  await execute('SET ROLE '+ignored);
  await assert.rejects(summary,{code:'42501'});await assert.rejects(()=>admin(),{code:'42501'});
 }
 await runtime();await assert.rejects(()=>execute('SELECT * FROM private.burimunsi_inbox_checks'),{code:'42501'});
 await assert.rejects(()=>admin('another-collection'),{code:'42501'});
 await owner();
 for(const n of [1,2]){
  const args=[source(n),group,uuid(n+20),body(n),'sms/'+source(n),hash('object'+n),51,hash('identity'+n),'fixture-owner',device,account,grant,1,1,profile,100+n];
  await execute('INSERT INTO private.burimunsi_unresolved_observations VALUES('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args);
  await execute('INSERT INTO private.burimunsi_native_receipt_origins VALUES($1,$2)',[source(n),group]);
  await execute('INSERT INTO app.sms_receipts VALUES($1,$2,$3,$4,$5,$6,51)',[source(n),uuid(n+20),'fixture-owner','sms/'+source(n),hash('object'+n),body(n)]);
  await execute("INSERT INTO private.burimunsi_auto_sms_jobs VALUES($1,$2,'wallet',$3,$4,'completed','accepted',$5,$6,NULL,NULL,0,$7)",
   [source(n),group,hash('identity'+n),profile,'tx'+n,hash('facts'+n),uuid(80+n)]);
  await execute("INSERT INTO app.momo_parse_attempts VALUES($1,'accepted',$2,$3,1)",[uuid(80+n),source(n),body(n)]);
  await execute("INSERT INTO app.momo_transactions VALUES($1,'wallet')",['tx'+n]);
  await execute("INSERT INTO private.burimunsi_transaction_scopes VALUES($1,$2)",[group,'tx'+n]);
  await execute("INSERT INTO app.momo_transaction_sources VALUES($1,$2,$3,'accepted')",[source(n),'tx'+n,uuid(80+n)]);
 }
 await execute('INSERT INTO private.collect_imported_native_history VALUES($1,$2,$3,$4,$5,$6,$7)',[source(2),group,uuid(22),body(2),hash('object2'),hash('identity2'),'tx2']);
 await execute("INSERT INTO app.momo_gateway_bindings VALUES('binding',1,'wallet','active')");
 await execute("INSERT INTO app.momo_gateway_credentials VALUES('cred','binding',$1,NULL)",[device]);
 await execute("UPDATE private.burimunsi_scopes SET active_binding_id='binding' WHERE collection_id=$1",[group]);
 await execute("INSERT INTO private.burimunsi_sms_source_scopes VALUES($1,$2,'fixture-owner',$3,$4,'binding',1,$5,$6,$7,1,now(),'wallet','gateway_capture',$1,'cred')",
  [source(3),group,body(3),hash('object3'),device,account,grant]);
 await execute("INSERT INTO app.sms_receipts VALUES($1,$2,'fixture-owner',$3,$4,$5,51)",[source(3),uuid(23),'sms/'+source(3),hash('object3'),body(3)]);
 await execute("INSERT INTO app.momo_gateway_captures VALUES($1,'cred',$2,1)",[source(3),hash('identity3')]);
 await execute("INSERT INTO app.momo_processing_jobs VALUES($1,'binding',1,'wallet','pending',NULL)",[source(3)]);
 await execute("INSERT INTO private.storage_put_intents VALUES($1,'op','cipher',50,$2,'{}',$3,'committed',NULL,false,false)",
  ['sms/'+source(3),{ownerId:'fixture-owner',purpose:'sms_receipt',entityId:source(3)},{sha256:hash('object3')}]);
 await execute("INSERT INTO private.storage_objects SELECT * FROM private.storage_put_intents");
 await runtime();
 assert.deepEqual((await statuses([source(1),source(2),source(3)])).statuses.map(r=>r.status),['parsed','parsed','pending']);
 const lookup=()=>call('SELECT private.burimunsi_observation_gateway_lookup($1,$2) v',[uuid(23),body(3)]);
 assert.equal((await lookup()).id,source(3));await owner();await execute("UPDATE private.storage_put_intents SET upload_unresolved=true");await runtime();
 await assert.rejects(lookup,{code:'55000'});await owner();await execute("UPDATE private.storage_put_intents SET upload_unresolved=false");await runtime();
 const inventory=await summary();assert.equal(inventory.recordedCount,3);assert.equal(inventory.hasUnmatchedCanonical,false);
 const first=opened();await checkpoint(first);await page(first.runId,[entry(1),entry(3)]);
 const finish=(run,rev)=>({...run,state:'verified',candidateCount:3,phoneLatestKey:key(3),parsedLatestKey:key(3),collectionRevision:rev});
 await assert.rejects(()=>checkpoint(finish(first,inventory.revision)),{code:'40001'});
 await page(first.runId,[{...entry(2),sourceId:null}]);await assert.rejects(()=>checkpoint(finish(first,inventory.revision)),{code:'40001'});
 const next=opened();await checkpoint(next);await assert.rejects(()=>page(first.runId,[entry(1)]),{code:'40001'});
 await page(next.runId,[entry(1),entry(2)]);await page(next.runId,[entry(1),entry(2)]);
 await assert.rejects(()=>page(next.runId,[{...entry(2),key:key(8)}]),{code:'23505'});
 await page(next.runId,[entry(3)]);await assert.rejects(()=>checkpoint(finish(next,inventory.revision)),{code:'40001'});
 await owner();
 await execute("UPDATE app.momo_processing_jobs SET state='completed'");
 await execute("INSERT INTO app.momo_parse_attempts VALUES('pa','accepted',$1,$2,1)",[source(3),body(3)]);
 await execute("INSERT INTO app.momo_transactions VALUES('tx3','wallet')");
 await execute("INSERT INTO app.momo_transaction_sources VALUES($1,'tx3','pa','accepted')",[source(3)]);
 await runtime();const completed=await summary();assert.notEqual(completed.revision,inventory.revision);
 assert.equal((await statuses([source(3)])).statuses[0].status,'parsed');
 await assert.rejects(()=>checkpoint(finish(next,inventory.revision)),{code:'40001'});
 await assert.rejects(()=>checkpoint({...finish(next,completed.revision),phoneLatestKey:key(2),parsedLatestKey:key(2)}),{code:'40001'});
 const verified=finish(next,completed.revision);await checkpoint(verified);await checkpoint(verified);
 assert.deepEqual(await admin(),{state:'verified',checkedAt:(await admin()).checkedAt,candidateCount:3,missingCount:0,pendingCount:0,headsMatch:true});
 const prepareSql='SELECT private.burimunsi_observation_held_prepare($1,$2,$3,$4,$5,$6,$7,$8,$9) v';
 const request=uuid(40),heldSource=fixtureSource(request),heldArgs=[key(9),hash('content'),body(9),request,hash('request'),heldSource,'test',profile,1];
 await call(prepareSql,heldArgs);await call(prepareSql,heldArgs);
 const heldMatches=()=>call('SELECT private.burimunsi_observation_held_matches($1,$2,$3,$4,$5) v',[key(9),request,hash('request'),body(9),1]);
 assert.equal(await heldMatches(),true);
 await assert.rejects(()=>call(prepareSql,[...heldArgs.slice(0,3),uuid(41),...heldArgs.slice(4)]),{code:'23505'});
 await guc('fixture.generation','2');await assert.rejects(heldMatches,{code:'42501'});await guc('fixture.generation','1');
 assert.equal((await admin()).state,'incomplete');
 await guc('fixture.admin','no');await assert.rejects(summary,{code:'42501'});await guc('fixture.admin','yes');
 await guc('fixture.consent','off');await assert.rejects(()=>checkpoint(opened()),{code:'42501'});await assert.rejects(lookup,{code:'42501'});await guc('fixture.consent','on');
 await owner();await execute('UPDATE private.burimunsi_observation_consents SET generation=2');await runtime();assert.equal((await admin()).state,'unknown');
 await owner();await execute('UPDATE private.burimunsi_observation_consents SET generation=1');
 await execute('DELETE FROM app.momo_transaction_sources WHERE raw_sms_id=$1',[source(2)]);
 await runtime();assert.equal((await statuses([source(2)])).statuses[0].status,'historical');
 await assert.rejects(()=>checkpoint(verified),{code:'40001'});
 await assert.rejects(()=>call('SELECT private._burimunsi_observation_automatable($1) v',[heldSource]),{code:'42501'});
 await owner();assert.equal(await call('SELECT private._burimunsi_observation_automatable($1) v',[heldSource]),false);

});
