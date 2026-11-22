import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {readCanonicalHome} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payment-reads.js';

const pg=createRequire(import.meta.url)('pg');
const at='2026-11-18T00:00:00Z',group='group';
const namedZones=/CASE WHEN ([tq]\.transaction_timezone) COLLATE "C" IN \('Africa\/Kigali','UTC','Etc\/UTC'\) THEN true\s+ELSE (EXISTS \(SELECT 1 FROM zones z WHERE z\.name=\1\)) END/g;
function before(candidate){
 let replacements=0;
 const query=candidate.replace(namedZones,(_match,_column,original)=>{replacements++;return original;});
 assert.equal(replacements,2,'both former exact catalog guards must be restored');
 return query;
}
function timezoneCatalogLoops(plan){
 return (plan['Function Name']==='pg_timezone_names'?(plan['Actual Loops']??0):0)
  +(plan.Plans??[]).reduce((total,child)=>total+timezoneCatalogLoops(child),0);
}
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');

const f=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap',clusterName:'collect_home_perf_fixture'});
const db=new pg.Client({host:f.socket,port:f.port,database:'postgres',user:'fixture_bootstrap'});
try{
 await db.connect();
 const [identity]=(await db.query("SELECT current_setting('cluster_name') name,inet_server_addr() IS NULL socket")).rows;
 assert.deepEqual(identity,{name:'collect_home_perf_fixture',socket:true});
 await db.query(`CREATE SCHEMA app; CREATE SCHEMA private;
   CREATE TABLE private.burimunsi_transaction_scopes(collection_id text,transaction_id text,receiving_account_id text,native_source_id text);
   CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text,payer_name text,payer_identifier text,
     amount_minor bigint,transaction_at text,transaction_timezone text,transaction_datetime_raw text,provider_transaction_id text,
     allocation_state text,has_conflict integer,version bigint,created_at text,event_kind text,fee_minor bigint,wallet_balance_after_minor bigint);
   CREATE TABLE app.momo_financial_links(transaction_id text,payment_id text,beneficiary_member_id text);
   CREATE TABLE app.payments(id text,collection_id text,status text,amount_minor bigint,evidence_id text,member_id text);
   CREATE TABLE app.memberships(collection_id text,user_id text,active bigint);
   CREATE TABLE app.users(id text,full_name text,momo_number text);
   CREATE TABLE app.ledger_entries(payment_id text,collection_id text,kind text,amount_minor bigint,evidence_id text,member_id text);
   CREATE TABLE app.momo_transaction_sources(transaction_id text,raw_sms_id text,relation text);
   CREATE FUNCTION private.burimunsi_auto_projection(p_source text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
   BEGIN
     IF current_setting('fixture.role',true)='denied' THEN RAISE EXCEPTION 'projection_denied' USING ERRCODE='42501'; END IF;
     RETURN jsonb_build_object('sourceId',p_source,'outcome','successful',
       'canReveal',current_setting('fixture.role',true)='admin',
       'facts',CASE WHEN p_source='source-1' THEN jsonb_build_object('transaction_at','2026-11-17T23:00:00Z')
         WHEN p_source='source-8' THEN jsonb_build_object('transaction_at','invalid-time')
         WHEN p_source='source-5-historical' THEN jsonb_build_object('transaction_timezone','US/Eastern')
         ELSE '{}'::jsonb END);
   END $$;
   INSERT INTO app.users VALUES('member','Synthetic member','0780000001');
   INSERT INTO app.memberships VALUES('group','member',1);
   INSERT INTO app.momo_transactions
    SELECT 'transaction-'||i,'wallet','Synthetic','masked',100+i,
      CASE i WHEN 2 THEN '2026-11-17T23:45:00Z' WHEN 3 THEN '2026-11-18T00:00:00Z'
       WHEN 4 THEN '2026-11-18T00:00:01Z' ELSE '2026-11-17T08:00:00Z' END,
      (ARRAY['Africa/Kigali','UTC','Etc/UTC'])[1+(i%3)],'synthetic','ref-'||i,
      'unallocated',0,1,'synthetic','incoming_receipt',0,NULL FROM generate_series(1,37) i;
   INSERT INTO private.burimunsi_transaction_scopes
    SELECT 'group','transaction-'||i,'wallet','source-'||i FROM generate_series(1,37) i;
   INSERT INTO app.momo_financial_links SELECT 'transaction-'||i,'payment-'||i,'member' FROM generate_series(1,11) i;
   INSERT INTO app.payments SELECT 'payment-'||i,'group','confirmed',100+i,'evidence-'||i,'member' FROM generate_series(1,11) i;
   INSERT INTO app.ledger_entries SELECT 'payment-'||i,'group','contribution',100+i,'evidence-'||i,'member' FROM generate_series(1,11) i;
   INSERT INTO app.momo_transaction_sources SELECT 'transaction-'||i,'source-'||i,'accepted' FROM generate_series(1,37) i;`);

 async function compare(role,auto,{fallback,predecessorScans=true,expected}={}){
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await db.query('SET LOCAL jit=off');
   await db.query("SELECT set_config('fixture.role',$1,true)",[role]);
   let rawRows,previousRows,originalPlan,optimizedPlan;
   const home=await readCanonicalHome({unsafe:async(query,args)=>{
    const predecessor=before(query);
    previousRows=(await db.query(predecessor,args)).rows;
    rawRows=(await db.query(query,args)).rows;
    assert.deepEqual(rawRows,previousRows);
    const explain=async text=>(await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+text,args)).rows[0]['QUERY PLAN'][0];
    originalPlan=await explain(predecessor);
    optimizedPlan=await explain(query);
    return rawRows;
   }},group,at,auto);
   assert.equal(timezoneCatalogLoops(originalPlan.Plan)>0,predecessorScans);
   assert.equal(timezoneCatalogLoops(optimizedPlan.Plan)>0,fallback);
   expected?.(home);
   return {role,auto,fallback,rows:rawRows.length,canonicalDigest:digest(rawRows),
    originalMs:originalPlan['Execution Time'],optimizedMs:optimizedPlan['Execution Time'],
    originalCatalogScans:timezoneCatalogLoops(originalPlan.Plan),optimizedCatalogScans:timezoneCatalogLoops(optimizedPlan.Plan)};
  }finally{await db.query('ROLLBACK');}
 }
 const results=[];
 for(const role of ['staff','admin']){
  results.push(await compare(role,true,{fallback:false,expected:home=>{
   assert.equal(home.groupBalanceRwf,1166);
   assert.equal(home.memberCount,1);
   assert.equal(home.recentPayments.length,3);
   assert.deepEqual(home.recentPayments.map(row=>row.id),['transaction-3','transaction-2','transaction-1']);
   assert.equal(home.recentPayments[0].sourceId,role==='admin'?'source-3':null);
  }}));
 }
 results.push(await compare('staff',false,{fallback:false}));

 await db.query(`UPDATE app.momo_transactions SET transaction_timezone='America/New_York', transaction_at='2026-11-17T23:55:00Z' WHERE id='transaction-5';
  UPDATE private.burimunsi_transaction_scopes SET native_source_id='source-5-historical' WHERE transaction_id='transaction-5';
  UPDATE app.momo_transactions SET transaction_timezone='utc', transaction_at='2026-11-17T23:59:30Z' WHERE id='transaction-6';
  UPDATE app.momo_transactions SET transaction_timezone='Bogus/Historical', transaction_at='2026-11-17T23:59:31Z' WHERE id='transaction-7';
  UPDATE app.momo_transactions SET transaction_timezone=NULL WHERE id='transaction-8';
  UPDATE app.momo_transactions SET transaction_at='2026-13-18T00:00:00Z' WHERE id='transaction-9';
  UPDATE app.momo_transactions SET has_conflict=1 WHERE id='transaction-3';
  UPDATE app.ledger_entries SET amount_minor=999 WHERE payment_id='payment-4';
  UPDATE app.payments SET status='reversed' WHERE id='payment-10';
  INSERT INTO private.burimunsi_transaction_scopes VALUES('different-group','transaction-11','wallet','source-11');`);
 for(const role of ['staff','admin']){
  results.push(await compare(role,true,{fallback:true,expected:home=>{
   assert.deepEqual(home.recentPayments.map(row=>row.id),['transaction-5','transaction-2','transaction-1']);
   assert.equal(home.recentPayments[0].sourceId,role==='admin'?'source-5-historical':null);
  }}));
 }
 let candidate,args;
 await readCanonicalHome({unsafe:async(query,values)=>{
  candidate=query;args=values;
  return [{balance:0,today:0,members:0,unallocated:0,unallocated_amount:0,id:null}];
 }},group,at,true);
 for(const sql of [before(candidate),candidate]){
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await db.query("SET LOCAL fixture.role='denied'");
   await assert.rejects(()=>db.query(sql,args),error=>error.code==='42501'&&error.message==='projection_denied');
  }finally{await db.query('ROLLBACK');}
 }
 await db.query("UPDATE app.payments SET status='reversed'");
 results.push(await compare('staff',true,{fallback:false,predecessorScans:false,expected:home=>{
  assert.equal(home.todayRwf,0);
  assert.deepEqual(home.recentPayments,[]);
 }}));
 console.log(JSON.stringify({status:'PASS',fixture:'owned-socket-only-pg17',synthetic:true,results}));
}finally{await db.end().catch(()=>{});const x=await f.close();assert.equal(x.removed,true);}
