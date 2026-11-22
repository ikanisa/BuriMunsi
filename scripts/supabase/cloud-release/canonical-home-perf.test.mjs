import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {nativePaymentListingScope,paymentsSql,readCanonicalHome} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payment-reads.js';
const pg=createRequire(import.meta.url)('pg');

const repo=new URL('../../../',import.meta.url);
const modulePath='supabase/functions/_shared/domain/burimunsi/postgres-payment-reads.js';
const source=new URL(modulePath,repo);
const baseline='c9755d7c4b6f43bd951888f9cada0d10591206be';
const previous=execFileSync('git',['show',baseline+':'+modulePath],{cwd:fileURLToPath(repo),encoding:'utf8'})
 .replace(/from '(\.\/[^']+)'/g,(_match,specifier)=>'from '+JSON.stringify(new URL(specifier,source).href));
const {readCanonicalHome:originalHome,nativePaymentListingScope:originalScope,paymentsSql:originalPayments}
  =await import('data:text/javascript;base64,'+Buffer.from(previous).toString('base64'));

async function queryPair(auto){
 async function capture(read){
  let captured;
  await read({unsafe:async(query,args)=>{
   captured={query,args};
   return [{balance:0,today:0,members:0,unallocated:0,unallocated_amount:0,id:null}];
  }},'group','2026-11-18T00:00:00.000Z',auto);
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
   CREATE TABLE private.home_time_fixture(source_id text PRIMARY KEY,transaction_at text,transaction_timezone text);
   INSERT INTO private.home_time_fixture VALUES ('source-1','2026-11-17T23:00:00Z','Africa/Kigali'),
    ('source-8','invalid-time','Africa/Kigali'), ('source-10','2026-11-18T01:00:00Z','Africa/Kigali'),
    ('source-11','2026-11-17T23:45:00Z','Invalid/timezone');
   CREATE FUNCTION private.burimunsi_home_payment_times(text,text[])
    RETURNS SETOF private.home_time_fixture LANGUAGE plpgsql VOLATILE AS $$
    BEGIN
      IF $1<>'group' OR current_setting('fixture.role',true)='denied' AND cardinality($2)>0 THEN
        RAISE EXCEPTION 'projection_denied' USING ERRCODE='42501';
      END IF;
      RETURN QUERY SELECT * FROM private.home_time_fixture WHERE source_id=ANY($2);
    END
   $$;
   CREATE FUNCTION private.burimunsi_auto_projection(p_source text) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
   BEGIN
     PERFORM nextval('private.projection_calls'); PERFORM pg_sleep(0.004);
     IF current_setting('fixture.role',true)='denied' THEN RAISE EXCEPTION 'projection_denied' USING ERRCODE='42501'; END IF;
     RETURN jsonb_build_object('sourceId',p_source,'outcome','successful',
       'canReveal',current_setting('fixture.role',true)='admin',
       'facts',coalesce((SELECT to_jsonb(r) - 'source_id' FROM private.home_time_fixture r WHERE r.source_id=p_source),'{}'::jsonb));
   END $$;
   INSERT INTO app.users VALUES('member','Synthetic member','0780000001');
   INSERT INTO app.memberships VALUES('group','member',1);
   INSERT INTO app.momo_transactions
    SELECT 'transaction-'||i,'wallet','Synthetic','masked',100+i,'2026-11-17T08:00:00Z','Africa/Kigali','synthetic','ref-'||i,
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
  const result=[];
  for(const role of ['staff','admin']){
    const before=await run(original,role),after=await run(candidate,role);
    assert.deepEqual(after.rows,before.rows);
    assert.equal(before.rows.length,3);assert.equal(before.rows[0].id,'transaction-1');
    assert.ok(after.calls<=3&&before.calls>after.calls);
    assert.equal(before.rows[0].native_meta.canReveal,role==='admin');
    result.push({role,rows:before.rows.length,originalProjectionCalls:before.calls,candidateProjectionCalls:after.calls,
      originalMs:before.elapsedMs,candidateMs:after.elapsedMs});
  }
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
  await assert.rejects(()=>run(candidate,'denied'),e=>e.code==='42501'&&e.message==='projection_denied');
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
  console.log(JSON.stringify({status:'PASS',fixture:'owned-socket-only-pg17',synthetic:true,result,listing,productionDispatched:false}));
} finally {await db.end().catch(()=>{});const x=await f.close();assert.equal(x.removed,true);}
