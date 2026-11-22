import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {nativePaymentListingScope,paymentsSql,readCanonicalHome} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payment-reads.js';
const pg=createRequire(import.meta.url)('pg');

const repo=new URL('../../../',import.meta.url);
const modulePath='supabase/functions/_shared/domain/burimunsi/postgres-payment-reads.js';
const source=new URL(modulePath,repo);
const group='group',at='2026-11-18T00:00:00.000Z';
const baseline='c9755d7c4b6f43bd951888f9cada0d10591206be';
const previous=execFileSync('git',['show',baseline+':'+modulePath],{cwd:fileURLToPath(repo),encoding:'utf8'})
 .replace(/from '(\.\/[^']+)'/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,source).href));
const {readCanonicalHome:originalHome,nativePaymentListingScope:originalScope,paymentsSql:originalPayments}
  =await import('data:text/javascript;base64,'+Buffer.from(previous).toString('base64'));
const migration=readFileSync(new URL('supabase/migrations/20261122180000_burimunsi_internal_query_performance.sql',repo),'utf8');
const homePaymentTimes=migration.match(/^CREATE FUNCTION private\.burimunsi_home_payment_times\(.*\n[\s\S]*?^\$fn\$;/m)?.[0];
assert.ok(homePaymentTimes,'qualify the deployed timestamp helper definition');

function timezoneCatalogLoops(plan){
  return (plan['Function Name']==='pg_timezone_names'?(plan['Actual Loops']??0):0)
    +(plan.Plans??[]).reduce((total,child)=>total+timezoneCatalogLoops(child),0);
}
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');

async function queryPair(auto){
 async function capture(read){
  let captured;
  await read({unsafe:async(query,args)=>{
   captured={query,args};
   return [{balance:0,today:0,members:0,unallocated:0,unallocated_amount:0,id:null}];
  }},group,at,auto);
  assert.ok(captured);
  return captured;
 }
 return {original:await capture(originalHome),candidate:await capture(readCanonicalHome)};
}
const {original,candidate}=await queryPair(true);
const f=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap',clusterName:'collect_home_perf_fixture'});
const db=new pg.Client({host:f.socket,port:f.port,database:'postgres',user:'fixture_bootstrap'});
try {
  await db.connect();
  const identity=(await db.query("SELECT current_setting('cluster_name') name,inet_server_addr() IS NULL socket")).rows[0];
  assert.deepEqual(identity,{name:'collect_home_perf_fixture',socket:true});
  await db.query(`CREATE SCHEMA app; CREATE SCHEMA private;
   CREATE TABLE private.burimunsi_transaction_scopes(collection_id text,transaction_id text PRIMARY KEY,receiving_account_id text,native_source_id text);
   CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text,payer_name text,payer_identifier text,
     amount_minor bigint,transaction_at text,transaction_timezone text,transaction_datetime_raw text,provider_transaction_id text,
     allocation_state text,has_conflict integer,version bigint,created_at text,event_kind text,fee_minor bigint,wallet_balance_after_minor bigint);
   CREATE TABLE app.momo_financial_links(transaction_id text PRIMARY KEY,payment_id text UNIQUE,beneficiary_member_id text);
   CREATE TABLE app.payments(id text PRIMARY KEY,collection_id text,status text,amount_minor bigint,evidence_id text,member_id text);
   CREATE TABLE app.memberships(collection_id text,user_id text,active bigint,PRIMARY KEY(collection_id,user_id));
   CREATE TABLE app.users(id text PRIMARY KEY,full_name text,momo_number text);
   CREATE TABLE app.ledger_entries(payment_id text,collection_id text,kind text,amount_minor bigint,evidence_id text,member_id text);
   CREATE TABLE app.momo_transaction_sources(transaction_id text,raw_sms_id text,relation text);
   CREATE SEQUENCE private.projection_calls;
   CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text PRIMARY KEY,collection_id text,state text,posting_facts jsonb);
   CREATE FUNCTION private._collect_fence_require_runtime() RETURNS void LANGUAGE plpgsql AS $$
   BEGIN
     IF current_setting('fixture.role',true) NOT IN ('staff','admin','denied') THEN
       RAISE EXCEPTION 'fixture_role_required' USING ERRCODE='42501';
     END IF;
   END $$;
   CREATE FUNCTION private.burimunsi_pin_context()
    RETURNS TABLE(collection_id text,capabilities text[]) LANGUAGE sql AS $$
    SELECT 'group',CASE WHEN current_setting('fixture.role',true)<>'denied' THEN ARRAY['records.read'] ELSE ARRAY[]::text[] END
   $$;
   CREATE FUNCTION private.burimunsi_pin_assert_actor(text,text,text,integer,text) RETURNS void LANGUAGE plpgsql AS $$
   BEGIN
     IF $2<>'group' OR $4<>1 THEN RAISE EXCEPTION 'fixture_scope_denied' USING ERRCODE='42501'; END IF;
   END $$;
   ${homePaymentTimes}
   CREATE FUNCTION private.burimunsi_auto_projection(p_source text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
   DECLARE facts jsonb;
   BEGIN
     IF current_setting('transaction_read_only')='off' THEN
       PERFORM nextval('private.projection_calls');
       PERFORM pg_sleep(0.004);
     END IF;
     IF current_setting('fixture.role',true)='denied' THEN RAISE EXCEPTION 'projection_denied' USING ERRCODE='42501'; END IF;
     SELECT job.posting_facts INTO facts FROM private.burimunsi_auto_sms_jobs job
      WHERE job.source_id=p_source AND job.collection_id='group' AND job.state='completed';
     IF NOT FOUND THEN RETURN NULL; END IF;
     RETURN jsonb_build_object('sourceId',p_source,'outcome','successful',
       'canReveal',current_setting('fixture.role',true)='admin','facts',facts);
   END $$;
   INSERT INTO private.burimunsi_auto_sms_jobs
    SELECT 'source-'||i,'group','completed','{}'::jsonb FROM generate_series(1,37) i;
   UPDATE private.burimunsi_auto_sms_jobs SET posting_facts='{"transaction_at":"2026-11-17T23:00:00Z"}' WHERE source_id='source-1';
   UPDATE private.burimunsi_auto_sms_jobs SET posting_facts='{"transaction_at":"invalid-time","transaction_timezone":"Africa/Kigali"}' WHERE source_id='source-8';
   UPDATE private.burimunsi_auto_sms_jobs SET posting_facts='{"transaction_at":"2026-11-18T01:00:00Z","transaction_timezone":"Africa/Kigali"}' WHERE source_id='source-10';
   UPDATE private.burimunsi_auto_sms_jobs SET posting_facts='{"transaction_at":"2026-11-18T01:00:00Z","transaction_timezone":"Etc/UTC"}' WHERE source_id='source-11';
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
  async function run(input,role){
    await db.query("SELECT set_config('fixture.role',$1,false)",[role]);
    await db.query('ALTER SEQUENCE private.projection_calls RESTART WITH 1');
    const start=performance.now();const rows=(await db.query(input.query,input.args)).rows;
    const elapsedMs=Math.round(performance.now()-start);
    const seq=(await db.query('SELECT last_value,is_called FROM private.projection_calls')).rows[0];
    return {rows,elapsedMs,calls:seq.is_called?Number(seq.last_value):0};
  }
  async function compareTimezonePlans(role,auto,{fallback,predecessorScans=true,expected}){
    const pair=await queryPair(auto);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{
      await db.query('SET LOCAL jit=off');
      await db.query("SELECT set_config('fixture.role',$1,true)",[role]);
      const previousRows=(await db.query(pair.original.query,pair.original.args)).rows;
      const rawRows=(await db.query(pair.candidate.query,pair.candidate.args)).rows;
      assert.deepEqual(rawRows,previousRows);
      const explain=async input=>(await db.query('EXPLAIN (ANALYZE, FORMAT JSON) '+input.query,input.args)).rows[0]['QUERY PLAN'][0];
      const originalPlan=await explain(pair.original),optimizedPlan=await explain(pair.candidate);
      const originalCatalogScans=timezoneCatalogLoops(originalPlan.Plan),optimizedCatalogScans=timezoneCatalogLoops(optimizedPlan.Plan);
      assert.equal(originalCatalogScans>0,predecessorScans);
      assert.equal(optimizedCatalogScans>0,fallback);
      const home=await readCanonicalHome({unsafe:async()=>rawRows},group,at,auto);
      expected?.(home);
      return {role,auto,fallback,rows:rawRows.length,canonicalDigest:digest(rawRows),
        originalMs:originalPlan['Execution Time'],optimizedMs:optimizedPlan['Execution Time'],
        originalCatalogScans,optimizedCatalogScans};
    }finally{await db.query('ROLLBACK');}
  }
  const result=[],timezone=[];
  for(const role of ['staff','admin']){
    const before=await run(original,role),after=await run(candidate,role);
    assert.deepEqual(after.rows,before.rows);
    assert.deepEqual(after.rows.map(row=>row.id),['transaction-3','transaction-2','transaction-1']);
    assert.ok(after.calls<=3&&before.calls>after.calls);
    assert.equal(after.rows[0].native_meta.canReveal,role==='admin');
    result.push({role,rows:after.rows.length,originalProjectionCalls:before.calls,candidateProjectionCalls:after.calls,
      originalMs:before.elapsedMs,candidateMs:after.elapsedMs});
    timezone.push(await compareTimezonePlans(role,true,{fallback:false,expected:home=>{
      assert.equal(home.groupBalanceRwf,1166);
      assert.equal(home.memberCount,1);
      assert.deepEqual(home.recentPayments.map(row=>row.id),['transaction-3','transaction-2','transaction-1']);
      assert.equal(home.recentPayments[0].sourceId,role==='admin'?'source-3':null);
    }}));
  }
  timezone.push(await compareTimezonePlans('staff',false,{fallback:false}));

  // Exercise historical aliases, exact-name rejection, malformed and absent
  // timestamps, time boundaries, conflicting credits, and source visibility.
  await db.query(`CREATE TEMP TABLE default_home_transactions AS SELECT * FROM app.momo_transactions;
   UPDATE app.momo_transactions SET transaction_timezone='America/New_York', transaction_at='2026-11-17T23:55:00Z' WHERE id='transaction-5';
   UPDATE private.burimunsi_transaction_scopes SET native_source_id='source-5-historical' WHERE transaction_id='transaction-5';
   INSERT INTO private.burimunsi_auto_sms_jobs VALUES('source-5-historical','group','completed','{"transaction_timezone":"US/Eastern"}');
   UPDATE app.momo_transactions SET transaction_timezone='utc', transaction_at='2026-11-17T23:59:30Z' WHERE id='transaction-6';
   UPDATE app.momo_transactions SET transaction_timezone='Bogus/Historical', transaction_at='2026-11-17T23:59:31Z' WHERE id='transaction-7';
   UPDATE app.momo_transactions SET transaction_timezone=NULL WHERE id='transaction-8';
   UPDATE app.momo_transactions SET transaction_at='2026-13-18T00:00:00Z' WHERE id='transaction-9';
   UPDATE private.burimunsi_auto_sms_jobs SET posting_facts='{"transaction_at":"2026-11-17T23:45:00Z","transaction_timezone":"Invalid/timezone"}' WHERE source_id='source-11';
   UPDATE app.momo_transactions SET has_conflict=1 WHERE id='transaction-3';
   UPDATE app.ledger_entries SET amount_minor=999 WHERE payment_id='payment-4';
   UPDATE app.payments SET status='reversed' WHERE id='payment-10';`);
  for(const role of ['staff','admin']){
    timezone.push(await compareTimezonePlans(role,true,{fallback:true,expected:home=>{
      assert.deepEqual(home.recentPayments.map(row=>row.id),['transaction-5','transaction-2','transaction-1']);
      assert.equal(home.recentPayments[0].sourceId,role==='admin'?'source-5-historical':null);
    }}));
  }
  timezone.push(await compareTimezonePlans('staff',false,{fallback:true}));
  await db.query(`UPDATE app.momo_transactions t
    SET (transaction_timezone,transaction_at,has_conflict)=(base.transaction_timezone,base.transaction_at,base.has_conflict)
    FROM default_home_transactions base WHERE t.id=base.id;
   UPDATE private.burimunsi_transaction_scopes SET native_source_id='source-5' WHERE transaction_id='transaction-5';
   UPDATE app.ledger_entries SET amount_minor=104 WHERE payment_id='payment-4';
   UPDATE app.payments SET status='confirmed' WHERE id='payment-10';`);

  // Alter independent credit predicates; the candidate must not invent a
  // credit when a conflict, status, amount, beneficiary or lineage disagrees.
  await db.query(`UPDATE app.momo_transactions SET has_conflict=1 WHERE id='transaction-2';
   UPDATE app.ledger_entries SET amount_minor=999 WHERE payment_id='payment-3';
   UPDATE app.payments SET status='reversed' WHERE id='payment-4';
   UPDATE app.payments SET member_id='unregistered' WHERE id='payment-5';
   UPDATE app.momo_financial_links SET beneficiary_member_id='unregistered' WHERE payment_id='payment-5';
   UPDATE app.ledger_entries SET member_id='unregistered' WHERE payment_id='payment-5';
   UPDATE app.payments SET status='corrected' WHERE id='payment-6';
   INSERT INTO app.ledger_entries VALUES('payment-7','group','reversal',-107,'evidence-7','member');
   UPDATE private.burimunsi_transaction_scopes SET native_source_id=NULL WHERE transaction_id='transaction-9';
   INSERT INTO app.momo_transactions VALUES('foreign','wallet','Synthetic','masked',500,'2026-11-17T22:00:00Z',
    'Africa/Kigali','synthetic','foreign-ref','unallocated',0,1,'synthetic','incoming_receipt',0,NULL);
   INSERT INTO private.burimunsi_transaction_scopes VALUES('different-group','foreign','wallet','foreign-source');`);
  for(const role of ['staff','admin']){
    const before=await run(original,role),after=await run(candidate,role);
    assert.deepEqual(after.rows,before.rows);
    assert.equal(before.rows[0].id,'transaction-1');
    assert.ok(after.rows.some(row=>row.id==='transaction-9'&&row.native_source_id===null));
    assert.ok(after.rows.every(row=>!['transaction-2','transaction-3','transaction-4','transaction-5',
      'transaction-6','transaction-7','transaction-8'].includes(row.id)));
    result.push({role:role+'-credit-negative-cases',rows:after.rows.length,originalProjectionCalls:before.calls,
      candidateProjectionCalls:after.calls,originalMs:before.elapsedMs,candidateMs:after.elapsedMs});
  }
  await assert.rejects(()=>run(original,'denied'),e=>e.code==='42501'&&e.message==='projection_denied');
  await assert.rejects(()=>run(candidate,'denied'),e=>e.code==='42501'&&e.message==='burimunsi_auto_denied');
  for(const input of [original,candidate]){
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try{
      await db.query("SET LOCAL fixture.role='denied'");
      await assert.rejects(()=>db.query(input.query,input.args),e=>e.code==='42501');
    }finally{await db.query('ROLLBACK');}
  }
  // The non-native mode retains exactly the same credit rows as well.
  const managed=await queryPair(false);
  const managedBefore=await run(managed.original,'staff'),managedAfter=await run(managed.candidate,'staff');
  assert.deepEqual(managedAfter.rows,managedBefore.rows);assert.equal(managedAfter.calls,0);
  result.push({role:'managed-without-native-projection',rows:managedAfter.rows.length,originalProjectionCalls:managedBefore.calls,candidateProjectionCalls:managedAfter.calls});
  // No credited records: previously projected native rows must not become credits.
  await db.query("UPDATE app.payments SET status='reversed'");
  const before=await run(original,'staff'),after=await run(candidate,'staff');
  assert.deepEqual(after.rows,before.rows);assert.equal(after.rows.length,1);assert.equal(after.rows[0].id,null);
  result.push({role:'staff-no-credits',rows:0,originalProjectionCalls:before.calls,candidateProjectionCalls:after.calls,
    originalMs:before.elapsedMs,candidateMs:after.elapsedMs});
  timezone.push(await compareTimezonePlans('staff',true,{fallback:false,predecessorScans:false,expected:home=>{
    assert.equal(home.todayRwf,0);
    assert.deepEqual(home.recentPayments,[]);
  }}));
  // The second dataset exercises set-based source and actual ledger joins.
  await db.query(`
   CREATE FUNCTION private.burimunsi_auto_projection_batch(text,text[]) RETURNS TABLE(source_id text,value jsonb)
   LANGUAGE sql STABLE AS $$
    SELECT id,jsonb_build_object('sourceId',id,'outcome','successful','canReveal',false)
    FROM unnest($2) id
   $$;
   INSERT INTO app.momo_transactions
    SELECT 'batch-'||n,'wallet','Synthetic','masked',100+n,'2026-11-17T08:00:00Z','Africa/Kigali','synthetic','ref-'||n,
      'unallocated',0,1,'synthetic','incoming_receipt',0,NULL FROM generate_series(1,5000) n;
   INSERT INTO private.burimunsi_transaction_scopes
    SELECT 'group','batch-'||n,'wallet',CASE WHEN n%2=0 THEN 'batch-source-'||n END FROM generate_series(1,5000) n;
   INSERT INTO app.momo_financial_links
    SELECT 'batch-'||n,'batch-pay-'||n,'member' FROM generate_series(1,5000,2) n;
   INSERT INTO app.payments SELECT 'batch-pay-'||n,'group','confirmed',100+n,'batch-evidence-'||n,'member'
    FROM generate_series(1,5000,2) n;
   INSERT INTO app.ledger_entries
    SELECT 'batch-pay-'||n,'group','contribution',100+n,'batch-evidence-'||n,'member' FROM generate_series(1,5000,2) n;
   INSERT INTO app.ledger_entries
    SELECT 'batch-pay-'||n,'group','reversal',-100-n,'batch-evidence-'||n,'member' FROM generate_series(1,5000,7) n WHERE n%2=1;
   INSERT INTO app.momo_transaction_sources
    SELECT 'batch-'||n,'accepted-'||n,'accepted' FROM generate_series(1,5000) n;
   INSERT INTO app.momo_transaction_sources
    SELECT 'batch-'||n,'conflict-'||n,'conflict' FROM generate_series(1,5000,3) n;
   CREATE INDEX fixture_ledger_key ON app.ledger_entries(payment_id,collection_id);
   CREATE INDEX fixture_source_key ON app.momo_transaction_sources(transaction_id,relation);
   ANALYZE;
  `);
  const batches={old:originalScope+originalPayments(true,{batch:true}),next:nativePaymentListingScope+paymentsSql(true,{batch:true})};
  async function timedBatch(statement){
    const start=performance.now();
    const rows=(await db.query(statement+' ORDER BY t.id',['group'])).rows;
    return {rows,elapsedMs:performance.now()-start};
  }
  await timedBatch(batches.old);
  await timedBatch(batches.next);
  const oldTimes=[],newTimes=[];
  let rowsCompared;
  for(let i=0;i<5;i++){
    const old=await timedBatch(batches.old),next=await timedBatch(batches.next);
    assert.deepEqual(next.rows,old.rows);
    assert.ok(next.rows.some(r=>r.ledger_posted)&&next.rows.some(r=>r.source_conflict));
    rowsCompared=next.rows.length;
    oldTimes.push(old.elapsedMs);newTimes.push(next.elapsedMs);
  }
  const median=times=>Math.round(times.sort((a,b)=>a-b)[2]*100)/100;
  const listing={rowsCompared,baselineMedianMs:median(oldTimes),candidateMedianMs:median(newTimes)};
  console.log(JSON.stringify({status:'PASS',fixture:'owned-socket-only-pg17',synthetic:true,result,timezone,listing,productionDispatched:false}));
} finally {await db.end().catch(()=>{});const x=await f.close();assert.equal(x.removed,true);}
