import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from '../node_modules/pg/lib/index.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';

const migration = new URL('../../../supabase/migrations/20261122201000_burimunsi_admin_inbox_coverage.sql',import.meta.url);
const uuid = n => '80000000-0000-4000-8000-'+String(n).padStart(12,'0');
const group='group-1', account=uuid(1), first=uuid(10), second=uuid(11), third=uuid(12);
const unknown={state:'unknown',checkedAt:null,candidateCount:null,missingCount:null,pendingCount:null,headsMatch:null};

test('Admin combines current consenting phones without pairing them, crossing scopes or counting handset entries as payments',async t=>{
 const cluster=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
 const db=new pg.Client({host:cluster.socket,port:cluster.port,user:cluster.initialUser,database:'postgres'});
 t.after(async()=>{try{await db.end()}finally{assert.equal((await cluster.close()).removed,true)}});
 await db.connect();
 await db.query(`
  CREATE ROLE postgres; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE ROLE collect_importer; CREATE ROLE collect_runtime;
  CREATE SCHEMA private AUTHORIZATION postgres; SET ROLE postgres;
  GRANT USAGE ON SCHEMA private TO collect_runtime,anon,authenticated;
  CREATE TABLE private.collect_fence_control(singleton boolean,mode text);
  INSERT INTO private.collect_fence_control VALUES(true,'fenced');
  CREATE FUNCTION private._collect_fence_require_operator() RETURNS void LANGUAGE plpgsql AS $$BEGIN
    IF current_user<>'postgres' THEN RAISE insufficient_privilege; END IF; END$$;
  CREATE TABLE private.burimunsi_accounts(id uuid,collection_id text,active boolean,removed boolean,role text,principal_user_id text);
  CREATE TABLE private.burimunsi_device_grants(id uuid,version int,collection_id text,installation_id uuid,active boolean);
  CREATE TABLE private.burimunsi_device_accounts(grant_id uuid,account_id uuid,collection_id text);
  CREATE TABLE private.burimunsi_observation_consents(collection_id text,installation_id uuid,account_id uuid,grant_id uuid,grant_version int,generation int,enabled boolean);
  CREATE TABLE private.burimunsi_inbox_checks(collection_id text,installation_id uuid,account_id uuid,grant_id uuid,grant_version int,consent_generation int,state text,checked_at bigint,report jsonb);
  CREATE TABLE private.test_inventory(collection_id text,account_id uuid,principal text,installation_id uuid,inventory jsonb);
  CREATE FUNCTION private._burimunsi_handset_inventory(text,uuid,text,uuid) RETURNS jsonb LANGUAGE sql AS $$
   SELECT inventory FROM private.test_inventory WHERE (collection_id,account_id,principal,installation_id)=($1,$2,$3,$4)
  $$;
  CREATE FUNCTION private.burimunsi_observation_admin_scope(text,boolean) RETURNS void LANGUAGE plpgsql AS $$BEGIN
   IF current_setting('role',true)<>'collect_runtime' OR current_setting('test.allowed_collection',true) IS DISTINCT FROM $1
    THEN RAISE insufficient_privilege; END IF;END$$;
 `);
 await db.query(await readFile(migration,'utf8'));
 await db.query('INSERT INTO private.burimunsi_accounts VALUES($1,$2,true,false,$3,$4)',[account,group,'admin','operator']);
 async function add(install,n,enabled=true){
  const grant=uuid(100+n);
  await db.query('INSERT INTO private.burimunsi_device_grants VALUES($1,1,$2,$3,true)',[grant,group,install]);
  await db.query('INSERT INTO private.burimunsi_device_accounts VALUES($1,$2,$3)',[grant,account,group]);
  await db.query('INSERT INTO private.burimunsi_observation_consents VALUES($1,$2,$3,$4,1,1,$5)',[group,install,account,grant,enabled]);
  return grant;
 }
 async function verify(install,grant,at,revision,head,count){
  const report={candidateCount:count,missingCount:0,pendingCount:0,phoneLatestKey:head,parsedLatestKey:head,collectionRevision:revision};
  await db.query("INSERT INTO private.burimunsi_inbox_checks VALUES($1,$2,$3,$4,1,1,'verified',$5,$6)",[group,install,account,grant,at,report]);
  await db.query("INSERT INTO private.test_inventory VALUES($1,$2,'operator',$3,$4)",[group,account,install,{revision,recordedCount:count,hasPending:false,hasUnmatchedCanonical:false}]);
 }
 const view=async(scope=group)=>{
  await db.query('SET ROLE collect_runtime');
  try{return (await db.query('SELECT private.burimunsi_observation_admin_inbox_check($1) AS v',[scope])).rows[0].v;}
  finally{await db.query('SET ROLE postgres')}
 };
 await db.query("SELECT set_config('test.allowed_collection',$1,false)",[group]);
 assert.deepEqual(await view(),unknown);
 const g1=await add(first,1),g2=await add(second,2);
 await add(third,3,false);
 await verify(first,g1,100,'inventory-a','most-recent-on-first',2);
 assert.deepEqual(await view(),unknown);
 // The same payment can occur on both phones. The first phone also has its own newer receipt.
 await verify(second,g2,200,'inventory-b','shared-provider-transfer',1);
 assert.deepEqual(await view(),{state:'verified',checkedAt:100,candidateCount:3,missingCount:0,pendingCount:0,headsMatch:true});
 await db.query("UPDATE private.test_inventory SET inventory=inventory||'{\"revision\":\"new-incoming-sms\",\"hasPending\":true}' WHERE installation_id=$1",[second]);
 assert.deepEqual(await view(),{...unknown,state:'incomplete',checkedAt:100});
 await db.query('UPDATE private.burimunsi_observation_consents SET generation=2 WHERE installation_id=$1',[second]);
 assert.deepEqual(await view(),unknown);
 await db.query('UPDATE private.burimunsi_device_grants SET active=false WHERE installation_id=$1',[second]);
 assert.deepEqual(await view(),{state:'verified',checkedAt:100,candidateCount:2,missingCount:0,pendingCount:0,headsMatch:true});
 await db.query("UPDATE private.burimunsi_inbox_checks SET state='incomplete',report=report||'{\"parsedLatestKey\":null,\"pendingCount\":1}' WHERE installation_id=$1",[first]);
 assert.deepEqual(await view(),{state:'incomplete',checkedAt:100,candidateCount:2,missingCount:0,pendingCount:1,headsMatch:false});
 await db.query("UPDATE private.burimunsi_inbox_checks SET state='checking' WHERE installation_id=$1",[first]);
 assert.deepEqual(await view(),{...unknown,state:'checking',checkedAt:100});
 await db.query("UPDATE private.burimunsi_accounts SET role='staff' WHERE id=$1",[account]);
 assert.deepEqual(await view(),unknown);
 await assert.rejects(view('unowned-group'),{code:'42501'});
 const acl=await db.query("select has_function_privilege('authenticated','private.burimunsi_observation_admin_inbox_check(text)','EXECUTE') exposed");
 assert.equal(acl.rows[0].exposed,false);
});
