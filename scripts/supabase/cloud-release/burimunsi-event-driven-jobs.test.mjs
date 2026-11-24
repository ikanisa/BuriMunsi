import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const load=path=>readFile(new URL('../../../'+path,import.meta.url),'utf8');
const sha=value=>createHash('sha256').update(value).digest('hex');
const project='rrlduytparvsjfmegalh', source=sha('isolated current release');

test('committed SMS wakes the signed worker, rollback cancels the wake, and idle seconds perform no external work',async t=>{
  const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
  const clients=[];
  async function connect(user){
    const db=new pg.Client({host:cluster.socket,port:cluster.port,database:'postgres',user});
    await db.connect();clients.push(db);return db;
  }
  t.after(async()=>{try{await Promise.all(clients.map(c=>c.end()));}finally{assert.ok((await cluster.close()).removed);}});
  const root=await connect(cluster.initialUser);
  await root.query(`CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE anon;CREATE ROLE authenticated;
    CREATE ROLE service_role;CREATE ROLE collect_runtime;CREATE ROLE collect_importer;CREATE ROLE collect_sms_runtime;
    GRANT collect_runtime TO postgres;GRANT CREATE ON DATABASE postgres TO postgres;
    CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;GRANT USAGE ON SCHEMA extensions TO postgres;
    CREATE SCHEMA private AUTHORIZATION postgres;CREATE SCHEMA app AUTHORIZATION postgres;
    CREATE SCHEMA collect_sms AUTHORIZATION postgres;CREATE SCHEMA collect_ops AUTHORIZATION postgres;
    GRANT USAGE ON SCHEMA private,app TO collect_runtime;`);
  const db=await connect('postgres'), independent=await connect('postgres');
  await db.query(`CREATE FUNCTION collect_ops.cleanup_google_expired() RETURNS void LANGUAGE sql AS $$ SELECT $$;
    REVOKE ALL ON FUNCTION collect_ops.cleanup_google_expired() FROM PUBLIC;
    CREATE TABLE private.collect_fence_control(singleton boolean,mode text,project_ref text,source_sha256 text,epoch bigint);
    INSERT INTO private.collect_fence_control VALUES(true,'fenced','${project}','${source}',1);
    CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION private._retention_manifest_catalog_v2() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT '{"private_classes":[]}'::jsonb $$;
    REVOKE ALL ON FUNCTION private._retention_manifest_catalog_v2() FROM PUBLIC;
    CREATE FUNCTION private.retention_capture_inventory_v2(uuid,text,bigint,text,integer) RETURNS text[] LANGUAGE sql
      AS $$ SELECT ARRAY['private:burimunsi_payment_sms_deliveries','other'] $$;
    CREATE TABLE private.collect_fence_scheduler_lifecycle(dispatch_id uuid PRIMARY KEY,native_epoch text,evidence_sha256 text,review_operation_id uuid,recorded_at timestamptz DEFAULT now());
    CREATE TABLE private.collect_fence_admissions(admission_id uuid PRIMARY KEY,epoch bigint,source_sha256 text,kind text,state text,reason text,uncertain_dispatches integer);
    CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('role',true)<>'collect_runtime' OR current_setting('collect.edge_verified',true)<>'true' THEN RAISE EXCEPTION 'denied';END IF;END $$;
    CREATE FUNCTION private.collect_fence_assert_write(request uuid,epoch bigint,src text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('role',true)='collect_runtime' AND (request IS NULL OR epoch<>1 OR src<>'${source}') THEN RAISE EXCEPTION 'invalid_admission'; END IF;
      RETURN '{}'::jsonb;END $$;
    CREATE FUNCTION private._collect_fence_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;
    CREATE FUNCTION private.collect_fence_owner_status() RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('role',true)='collect_runtime' THEN RAISE EXCEPTION 'operator_only';END IF;
      RETURN jsonb_build_object('sourceSha256','${source}'); END $$;
    CREATE TABLE private.burimunsi_unresolved_observations(source_id uuid PRIMARY KEY);
    CREATE TABLE app.sms_receipts(id uuid PRIMARY KEY);
    CREATE TABLE private.burimunsi_payment_sms_obligations(disposition text);
    CREATE TABLE collect_sms.messages(kind text,state text);
    CREATE TABLE private.burimunsi_auto_sms_jobs(state text,phase text,next_attempt_at bigint,posting_next_attempt_at bigint);
    CREATE TABLE private.burimunsi_payment_sms_deliveries(body_sha256 text,state text,inspect_count int,provider_state text,next_inspect_at timestamptz,lease_until timestamptz,last_claimed_phase text);
    GRANT INSERT ON private.burimunsi_unresolved_observations TO collect_runtime;`);
  await db.query(await load('supabase/jobs/test-fixture.sql'));
  await db.query('ALTER TABLE cron.job_run_details ADD COLUMN status text, ADD COLUMN start_time timestamptz');
  const [{cleanup,manifest}]=(await db.query(`SELECT encode(sha256(convert_to(pg_get_functiondef('collect_ops.cleanup_google_expired()'::regprocedure),'UTF8')),'hex') cleanup,
    (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure) manifest`)).rows;
  const base=await load('supabase/migrations/20261117073850_collect_managed_jobs_hmac.sql');
  await db.query(base.replace('f70925051147096cfb72869b401fdb69c976b68034c87e8c3e98ee8b5f350ed0',cleanup)
    .replace('09ecc11aca46af15d7f981b5d5c7c7d3775be6fc245c8ff73f48f61269e37671',manifest));
  await db.query(await load('supabase/migrations/20261117135049_collect_sms_schedule_one_minute.sql'));
  await db.query(await load('supabase/migrations/20261122191300_burimunsi_event_driven_jobs.sql'));
  const jobPredecessor=await load('scripts/supabase/cloud-release/native-parser-review-preimage.sql');
  await db.query(jobPredecessor.slice(jobPredecessor.indexOf('CREATE OR REPLACE FUNCTION collect_ops.reconcile_jobs()')));
  const performanceSql=await load('supabase/migrations/20261122180000_burimunsi_internal_query_performance.sql');
  await db.query(performanceSql.match(/DO \$scheduler\$[\s\S]*?\$scheduler\$;/)[0]);
  const budgetSql=await load('supabase/migrations/20261117081411_collect_native_provider_budget.sql');
  await db.query(budgetSql.match(/ALTER TABLE private\.collect_managed_job_tickets ADD COLUMN native_provider_calls[^;]+;/)[0]);
  await db.query(await load('supabase/migrations/20261124080612_burimunsi_retry_unclaimed_scheduler_refusals.sql'));
  assert.deepEqual((await db.query(`SELECT proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex') digest
    FROM pg_proc WHERE oid IN ('collect_ops.reconcile_jobs()'::regprocedure,
    'private.collect_managed_job_claim(uuid,text,jsonb,text)'::regprocedure) ORDER BY proname`)).rows,[
    {proname:'collect_managed_job_claim',digest:'c2848c875d9095bc971c7b4a121fe69844c0fc428e152d5c5e18c39d0c60fdd9'},
    {proname:'reconcile_jobs',digest:'2ec0bc1e411e0a2f74688fc4fd3a6e029ded1261b43c3e721ba6acb02faffacb'},
  ]);
  assert.equal((await db.query('SELECT schedule FROM cron.job')).rows[0].schedule,'1 second');
  const digests=(await db.query("SELECT proname,encode(sha256(convert_to(prosrc,'UTF8')),'hex') digest FROM pg_proc WHERE pronamespace='collect_ops'::regnamespace AND proname IN ('dispatch_jobs','activate_jobs','tick_jobs') ORDER BY 1")).rows;
  t.diagnostic('Installed routine digests '+JSON.stringify(digests));
  const covered=await db.query("SELECT count(*)::int n FROM pg_proc WHERE oid IN ('collect_ops.dispatch_jobs(text,uuid)'::regprocedure,'collect_ops.tick_jobs()'::regprocedure) AND strpos(prosrc,$1)>0",
    ['BEGIN\n -- collect_fence_sql2_write_guard_v1\n PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);']);
  assert.equal(covered.rows[0].n,2);
  await db.query('INSERT INTO vault.secrets(name,decrypted_secret) VALUES($1,$2)',['collect_job_signing_key_v1',randomBytes(32).toString('hex')]);
  const ready={format:'collect.jobs.readiness.v1',project_ref:project,endpoint:'https://'+project+'.supabase.co/functions/v1/collect-jobs',
    deployment_sha256:sha('deploy'),runtime_evidence_sha256:sha('runtime'),token_custody_evidence_sha256:sha('key'),copy_inventory_evidence_sha256:sha('inventory'),
    quota_evidence_sha256:sha('quota'),verified_at:new Date().toISOString(),momo_processing_paused:true,remaining_invocations:90000,evidence_file_sha256:sha('fixture')};
  await db.query('SELECT collect_ops.record_jobs_readiness($1::jsonb)',[ready]);
  const result=async(text,parameters=[]) => (await db.query(text,parameters)).rows[0].v;
  const probe=await result("SELECT collect_ops.dispatch_jobs('probe',$1) v",[randomUUID()]);
  assert.equal(probe.state,'awaiting');
  const receipt=JSON.stringify({dispatch_id:probe.dispatch_id,maintenance:{status:'complete',examined_limit:100,purged:0,provider_calls:0},processing:{processed:0,results:[],paused:true}});
  await db.query("UPDATE private.collect_fence_control SET mode='open'");
  const [envelope]=(await db.query("SELECT convert_from(body,'UTF8')::jsonb payload,substr(headers->>'Authorization',8) proof FROM net.http_request_queue WHERE id=$1",[probe.net_request_id])).rows;
  const admission=randomUUID();
  await db.query("INSERT INTO private.collect_fence_admissions VALUES($1,1,$2,'jobs','active')",[admission,source]);
  await db.query('BEGIN');await db.query('SET LOCAL ROLE collect_runtime');
  await db.query("SELECT set_config('collect.edge_verified','true',true),set_config('collect.fence_admission_id',$1,true),set_config('collect.fence_epoch','1',true),set_config('collect.fence_source_sha256',$2,true)",[admission,source]);
  assert.equal(await result('SELECT private.collect_managed_job_claim($1,$2,$3,$4) v',[probe.dispatch_id,source,envelope.payload,envelope.proof]),true);
  assert.equal(await result('SELECT private.collect_managed_job_complete($1,$2,$3) v',[probe.dispatch_id,source,sha(receipt)]),true);
  await db.query('COMMIT');
  await db.query('INSERT INTO net._http_response(id,status_code,content) VALUES ($1,200,$2)',[probe.net_request_id,receipt]);
  await db.query('DELETE FROM net.http_request_queue WHERE id=$1',[probe.net_request_id]);
  await db.query('SELECT collect_ops.reconcile_jobs()');
  await db.query('SELECT collect_ops.activate_jobs($1)',[ready.evidence_file_sha256]);
  await db.query('DELETE FROM net.http_request_queue');
  const input=async()=>{
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE collect_runtime');
    await db.query("SELECT set_config('collect.edge_verified','true',true),set_config('collect.fence_admission_id',$1,true),set_config('collect.fence_epoch','1',true),set_config('collect.fence_source_sha256',$2,true)",[randomUUID(),source]);
    await db.query('INSERT INTO private.burimunsi_unresolved_observations VALUES ($1)',[randomUUID()]);
  };
  const counts=async()=>(await independent.query('SELECT (SELECT count(*)::int FROM net.http_request_queue) q,(SELECT count(*)::int FROM private.burimunsi_sms_wakes) wakes')).rows[0];
  await input();assert.deepEqual(await counts(),{q:0,wakes:0});await db.query('ROLLBACK');assert.deepEqual(await counts(),{q:0,wakes:0});
  await input();assert.deepEqual(await counts(),{q:0,wakes:0});await db.query('COMMIT');assert.deepEqual(await counts(),{q:1,wakes:0});
  const metadata=await independent.query("SELECT method,headers->>'Authorization' AS signature,convert_from(body,'UTF8')::jsonb payload FROM net.http_request_queue");
  assert.equal(metadata.rows[0].method,'POST');assert.match(metadata.rows[0].signature,/^Bearer [a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(metadata.rows[0].payload).sort(),['dispatch_expires_at','dispatch_id']);
  await input();await db.query('COMMIT');assert.deepEqual(await counts(),{q:1,wakes:1});
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'awaiting_confirmation');
  await db.query("UPDATE collect_ops.jobs_dispatches SET state='confirmed',reason='reply_confirmed',slot=date_trunc('second',clock_timestamp())-interval '2 seconds' WHERE kind='scheduled'");
  const drain=await result('SELECT collect_ops.tick_jobs() v');assert.equal(drain.state,'awaiting');assert.deepEqual(await counts(),{q:2,wakes:0});
  await db.query("UPDATE collect_ops.jobs_dispatches SET state='confirmed' WHERE id=$1",[drain.dispatch_id]);
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'idle');
  await db.query("INSERT INTO private.burimunsi_payment_sms_deliveries VALUES(repeat('a',64),'accepted',1,'accepted',now()+interval '5 seconds',NULL,NULL)");
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'idle');
  assert.equal((await independent.query('SELECT count(*)::int n FROM private.burimunsi_sms_wakes WHERE wake_class=1 AND due_at>now()')).rows[0].n,1);
  await db.query("INSERT INTO private.burimunsi_payment_sms_deliveries VALUES(NULL,'sending',0,NULL,NULL,now()+interval '2 seconds','send')");
  assert.equal((await independent.query('SELECT count(*)::int n FROM private.burimunsi_sms_wakes WHERE wake_class=1 AND due_at>now()')).rows[0].n,2);
  // Complete the original signed job, then simulate pg_net losing its native
  // queue identity. No HTTP 200 is invented and the intended work is never replayed.
  await db.query('DELETE FROM private.burimunsi_sms_wakes');
  await db.query("UPDATE collect_ops.jobs_dispatches SET slot=slot-interval '5 seconds' WHERE id=$1",[drain.dispatch_id]);
  await input();await db.query('COMMIT');
  const lost=(await independent.query("SELECT d.id,convert_from(net.body,'UTF8')::jsonb payload,substr(net.headers->>'Authorization',8) proof FROM collect_ops.jobs_dispatches d JOIN net.http_request_queue net ON d.net_request_id=net.id WHERE d.state='awaiting'")).rows[0];
  const lostAdmission=randomUUID();
  await db.query("INSERT INTO private.collect_fence_admissions(admission_id,epoch,source_sha256,kind,state) VALUES($1,1,$2,'jobs','active')",[lostAdmission,source]);
  await db.query('BEGIN');await db.query('SET LOCAL ROLE collect_runtime');
  await db.query("SELECT set_config('collect.edge_verified','true',true),set_config('collect.fence_admission_id',$1,true),set_config('collect.fence_epoch','1',true),set_config('collect.fence_source_sha256',$2,true)",[lostAdmission,source]);
  assert.equal(await result('SELECT private.collect_managed_job_claim($1,$2,$3,$4) v',[lost.id,source,lost.payload,lost.proof]),true);
  const completedDigest=sha('original successful independently stored response');
  assert.equal(await result('SELECT private.collect_managed_job_complete($1,$2,$3) v',[lost.id,source,completedDigest]),true);
  await db.query('COMMIT');
  await db.query("UPDATE private.collect_fence_admissions SET state='settled',reason='completed',uncertain_dispatches=0 WHERE admission_id=$1",[lostAdmission]);
  await db.query("UPDATE collect_ops.jobs_dispatches SET native_epoch=repeat('c',64) WHERE id=$1",[lost.id]);
  const beforeRestart=await counts();
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'idle');
  assert.deepEqual(await counts(),beforeRestart);
  const restored=(await independent.query('SELECT state,reason,http_status,response_sha256,resolution_evidence_sha256 FROM collect_ops.jobs_dispatches WHERE id=$1',[lost.id])).rows[0];
  assert.equal(restored.reason,'transport_lost_edge_completed');assert.equal(restored.state,'reviewed_unknown');
  assert.equal(restored.http_status,null);assert.equal(restored.response_sha256,completedDigest);assert.match(restored.resolution_evidence_sha256,/^[a-f0-9]{64}$/);
  assert.equal((await independent.query('SELECT enabled FROM collect_ops.jobs_config')).rows[0].enabled,true);
  assert.equal((await independent.query('SELECT evidence_sha256 FROM private.collect_fence_scheduler_lifecycle WHERE dispatch_id=$1',[lost.id])).rows[0].evidence_sha256,restored.resolution_evidence_sha256);
  await independent.query("UPDATE collect_ops.jobs_dispatches SET slot=slot-interval '1 hour' WHERE id=$1",[lost.id]);
  await input();await db.query('COMMIT');
  const never=(await independent.query("SELECT id FROM collect_ops.jobs_dispatches WHERE state='awaiting'")).rows[0].id;
  await independent.query("UPDATE collect_ops.jobs_dispatches SET native_epoch=repeat('d',64) WHERE id=$1",[never]);
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'awaiting_original');
  await independent.query(`UPDATE private.collect_managed_job_tickets SET created_at=clock_timestamp()-interval '1 minute',
     expires_at=date_trunc('second',clock_timestamp())-interval '1 second',payload=jsonb_set(payload,'{dispatch_expires_at}',
       to_jsonb(floor(extract(epoch FROM clock_timestamp()))::bigint-1)) WHERE dispatch_id=$1`,[never]);
  assert.equal((await result('SELECT collect_ops.tick_jobs() v')).state,'idle');
  const retired=(await independent.query('SELECT state,reason,http_status,response_sha256 FROM collect_ops.jobs_dispatches WHERE id=$1',[never])).rows[0];
  assert.deepEqual(retired,{state:'reviewed_unknown',reason:'transport_lost_ticket_expired_unclaimed',http_status:null,response_sha256:null});
  await assert.rejects(db.query("SELECT collect_ops.dispatch_jobs('signal',$1)",[randomUUID()]),{code:'42501'});
  const {verifyRefusalRaces}=await import('./fixtures/burimunsi-job-refusal.mjs');
  await verifyRefusalRaces({db,independent,observer:root,source});
});
