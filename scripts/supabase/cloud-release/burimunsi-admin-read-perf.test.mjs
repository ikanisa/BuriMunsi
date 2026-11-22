import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';
import {overview} from '../../../supabase/functions/_shared/domain/admin_records.js';
import {momoTransactionPage} from '../../../supabase/functions/_shared/domain/admin_momo_reads.js';

const pg=createRequire(import.meta.url)('pg');
for (const oid of [20,1700]) pg.types.setTypeParser(oid,value=>{
 const number=Number(value);
 assert.ok(Number.isSafeInteger(number));
 return number;
});
const repo=new URL('../../../',import.meta.url);
const beforeSha='c9755d7c4b6f43bd951888f9cada0d10591206be';
async function previous(name){
 const path='supabase/functions/_shared/domain/'+name+'.js';
 const previousSource=execFileSync('git',['show',beforeSha+':'+path],{cwd:fileURLToPath(repo),encoding:'utf8'})
  .replace(/from '(\.\/[^']+)'/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,new URL(path,repo)).href));
 return import('data:text/javascript;base64,'+Buffer.from(previousSource).toString('base64'));
}

const fixture=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap',clusterName:'burimunsi_admin_perf_fixture'});
const db=new pg.Client({host:fixture.socket,port:fixture.port,database:'postgres',user:'fixture_bootstrap'});
try{
 await db.connect();
 const identity=(await db.query("SELECT current_setting('cluster_name') name,inet_server_addr() IS NULL socket")).rows[0];
 assert.deepEqual(identity,{name:'burimunsi_admin_perf_fixture',socket:true});
 await db.query(`
  CREATE SCHEMA app; CREATE SCHEMA private; SET search_path=app,pg_catalog;
  CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text NOT NULL,provider text,provider_transaction_id text,
   event_kind text,original_transaction_id text,amount_minor bigint,currency text,currency_scale bigint,payer_name text,payer_identifier text,
   payer_last3 text,transaction_at text,transaction_datetime_raw text,transaction_timezone text,transaction_time_source text,
   fee_minor bigint,wallet_balance_after_minor bigint,parse_attempt_id text,mode text,allocation_state text,has_conflict bigint,created_at text);
  CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY,public_code text,recipient_name text);
  CREATE TABLE app.momo_parse_attempts(id text PRIMARY KEY,raw_sms_id text,outcome text,source_body_sha256 text,
   parser_version text,profile_version text,created_at text);
  CREATE TABLE app.sms_receipts(id text PRIMARY KEY,body_sha256 text,originating_session_id text);
  CREATE TABLE app.momo_transaction_sources(transaction_id text PRIMARY KEY,raw_sms_id text,parse_attempt_id text,relation text);
  CREATE TABLE app.momo_financial_links(transaction_id text PRIMARY KEY,payment_id text,beneficiary_member_id text);
  CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text,revision bigint,intent_id text,status text,amount_minor bigint,member_id text);
  CREATE TABLE app.collections(id text PRIMARY KEY,title text,receiver_momo_number text,status text);
  CREATE TABLE app.users(id text PRIMARY KEY,full_name text,member_type text);
  CREATE TABLE app.admin_users(role text,status text);
  CREATE TABLE app.memberships(user_id text,active bigint);
  CREATE TABLE app.ledger_entries(payment_id text,amount_minor bigint,kind text);
  CREATE INDEX ledger_payment ON app.ledger_entries(payment_id);
  CREATE TABLE app.payment_evidence(id text);
  CREATE SEQUENCE private.visibility_calls;
  CREATE FUNCTION private.synthetic_id(prefix text,n bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT $1||'-0000-4000-8000-'||lpad($2::text,12,'0')
  $$;
  CREATE FUNCTION private.burimunsi_admin_transaction_visibility(p_transaction text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
  DECLARE n integer;
  BEGIN
    PERFORM nextval('private.visibility_calls');
    n:=right(p_transaction,5)::integer;
    RETURN CASE WHEN n%4=0 THEN '{"kind":"hidden","groupId":null}'::jsonb
      WHEN n%2=0 THEN '{"kind":"visible","groupId":"22222222-0000-4000-8000-000000000001"}'::jsonb
      ELSE '{"kind":"managed","groupId":null}'::jsonb END;
  END
  $$;
  CREATE TABLE private.burimunsi_auto_sms_jobs(transaction_id text,collection_id text,state text,relation text,posting_facts jsonb);
  CREATE FUNCTION private.burimunsi_admin_sms_facts(p_transaction text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
  DECLARE v jsonb; answer jsonb;
  BEGIN
    v:=private.burimunsi_admin_transaction_visibility(p_transaction);
    IF v->>'kind' IS DISTINCT FROM 'visible' THEN RETURN NULL;END IF;
    SELECT j.posting_facts INTO answer FROM private.burimunsi_auto_sms_jobs j
    WHERE j.transaction_id=p_transaction AND j.collection_id=v->>'groupId' AND j.state='completed' AND j.relation='accepted';
    RETURN answer;
  END
  $$;
  INSERT INTO app.momo_receiving_accounts VALUES(private.synthetic_id('11111111',1),'12345','Synthetic account');
  INSERT INTO app.collections VALUES(private.synthetic_id('22222222',1),'Synthetic group','0780000001','active');
  INSERT INTO app.admin_users VALUES('owner','active'),('staff','active'),('admin','suspended');
  INSERT INTO app.users SELECT 'user-'||n,'Person '||n,CASE WHEN n%3=0 THEN 'app' ELSE 'direct' END
   FROM generate_series(1,10000) n;
  INSERT INTO app.memberships SELECT 'user-'||n,(n%3<>0)::int FROM generate_series(1,10000) n;
  INSERT INTO app.payment_evidence SELECT 'evidence-'||n FROM generate_series(1,10000) n;
  INSERT INTO app.momo_transactions
   SELECT private.synthetic_id('33333333',n),private.synthetic_id('11111111',1),'mtn_momo','REF'||n,'incoming_receipt',NULL,
    100+n,'RWF',0,'Payer '||n,NULL,NULL,'2026-11-17T08:00:00.000Z','17/11/2026 10:00:00',
    'Africa/Kigali','sms_body_and_provider_profile',NULL,NULL,private.synthetic_id('44444444',n),'live','unallocated',0,
    '2026-11-17T08:00:00.000Z' FROM generate_series(1,200) n;
  INSERT INTO app.momo_parse_attempts
   SELECT private.synthetic_id('44444444',n),private.synthetic_id('55555555',n),'accepted',repeat('a',64),'synthetic','synthetic',
    '2026-11-17T08:00:00.000Z' FROM generate_series(1,200) n;
  INSERT INTO app.sms_receipts SELECT private.synthetic_id('55555555',n),repeat('a',64),CASE WHEN n%2=1 THEN 'session' END
   FROM generate_series(1,200) n;
  INSERT INTO app.momo_transaction_sources
   SELECT private.synthetic_id('33333333',n),private.synthetic_id('55555555',n),private.synthetic_id('44444444',n),'accepted'
   FROM generate_series(1,200) n;
  INSERT INTO app.payments SELECT 'payment-'||n,private.synthetic_id('22222222',1),1,NULL,
   CASE WHEN n%5=0 THEN 'reversed' WHEN n%3=0 THEN 'confirmed' ELSE 'recorded' END,100+n,
   CASE WHEN n%3=0 THEN 'user-'||n ELSE NULL END FROM generate_series(1,20000) n;
  INSERT INTO app.ledger_entries SELECT 'payment-'||n,CASE WHEN n%5=0 THEN -100-n ELSE 100+n END,
   CASE WHEN n%5=0 THEN 'reversal' ELSE 'contribution' END FROM generate_series(1,20000,3) n;
  INSERT INTO app.momo_financial_links SELECT private.synthetic_id('33333333',n),'payment-'||n,'user-'||n
   FROM generate_series(1,200,3) n;
  INSERT INTO private.burimunsi_auto_sms_jobs SELECT private.synthetic_id('33333333',n),private.synthetic_id('22222222',1),
   'completed','accepted',jsonb_build_object('amount_minor',1000+n,'counterparty_name','Confirmed payer '||n)
   FROM generate_series(2,200,4) n;
  ANALYZE;
 `);
 const {readFileSync}=await import('node:fs');
 const migration=readFileSync(new URL('supabase/migrations/20261122180000_burimunsi_internal_query_performance.sql',repo),'utf8');
 const functionOnly=migration.split('CREATE FUNCTION private.burimunsi_admin_transaction_facts(p_transaction text)')[1]
  .split('REVOKE ALL ON FUNCTION')[0];
 await db.query('CREATE FUNCTION private.burimunsi_admin_transaction_facts(p_transaction text)'+functionOnly);
 const baselineOverview=(await previous('admin_records')).overview;
 const baselineMoMo=(await previous('admin_momo_reads')).momoTransactionPage;
 const env={BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'true',DB:{
  prepare(query){return {query,values:[],bind(...values){return {query,values}}}},
  async batch(statements){
   const results=[];
   for(const statement of statements){
    const {text,values}=compileSql(statement.query,statement.values);
    results.push({results:(await db.query(text,values)).rows});
   }
   return results;
  },
 }};
 function stable(value){
  const {measured_at,as_of,...result}=value;
  return result;
 }
 async function timed(read,url){
  await db.query('ALTER SEQUENCE private.visibility_calls RESTART WITH 1');
  const start=performance.now();
  const data=stable(await read(env,url));
  const ms=performance.now()-start;
  const counter=(await db.query('SELECT last_value,is_called FROM private.visibility_calls')).rows[0];
  return {data,ms,calls:counter.is_called?counter.last_value:0};
 }
 const results=[];
 for(const [operation,oldRead,newRead,path] of [
  ['overview',baselineOverview,overview,'/admin'],
  ['momo-page',baselineMoMo,momoTransactionPage,'/momo?limit=25&offset=25'],
  ['momo-empty-page',baselineMoMo,momoTransactionPage,'/momo?limit=25&offset=500'],
  ['momo-filter',baselineMoMo,momoTransactionPage,'/momo?account_scope_id=11111111-0000-4000-8000-000000000001&status=recorded&search=Confirmed&limit=5'],
 ]){
  const url=new URL(path,'https://admin.example.invalid');
  await timed(oldRead,url);
  await timed(newRead,url);
  const before=[],after=[];
  let previousCalls=0,candidateCalls=0;
  for(let i=0;i<3;i++){
   const prior=await timed(oldRead,url),candidate=await timed(newRead,url);
   assert.deepEqual(candidate.data,prior.data,operation);
   before.push(prior.ms); after.push(candidate.ms);
   previousCalls=prior.calls;candidateCalls=candidate.calls;
  }
  if(operation!=='overview')assert.ok(candidateCalls<previousCalls);
  const median=samples=>Math.round(samples.sort((a,b)=>a-b)[1]*100)/100;
  results.push({operation,baselineMedianMs:median(before),candidateMedianMs:median(after),previousCalls,candidateCalls});
 }
 console.log(JSON.stringify({status:'PASS',fixture:'owned-socket-only-pg17',synthetic:true,baseline:beforeSha,results}));
}finally{
 await db.end().catch(()=>{});
 assert.equal((await fixture.close()).removed,true);
}
