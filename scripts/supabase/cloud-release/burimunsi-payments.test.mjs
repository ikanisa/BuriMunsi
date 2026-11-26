import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {assignPayment,readOptionalPaymentsHome,readPayment,readPayments,readPaymentsHome,setPaymentsScope} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payments.js';

const {Client}=createRequire(import.meta.url)('pg');

test('payments migration carries forward both directions and closes the old write path',async t=>{
  const fixture=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap'});
  const db=new Client({host:fixture.socket,port:fixture.port,database:'postgres',user:fixture.initialUser});
  try{
    await db.connect();
    await db.query(`
      CREATE ROLE postgres SUPERUSER; SET ROLE postgres;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE collect_runtime;
      CREATE SCHEMA app; CREATE SCHEMA private;
      CREATE TABLE private.burimunsi_scopes(collection_id text PRIMARY KEY);
      CREATE TABLE app.momo_receiving_accounts(id text PRIMARY KEY);
      CREATE TABLE app.sms_receipts(id text PRIMARY KEY);
      CREATE TABLE private.burimunsi_unresolved_observations(source_id text PRIMARY KEY);
      CREATE TABLE app.users(id text PRIMARY KEY,full_name text,momo_number text,access_status text,member_type text);
      CREATE TABLE app.memberships(collection_id text,user_id text,active integer,PRIMARY KEY(collection_id,user_id));
      CREATE TABLE app.momo_transactions(id text PRIMARY KEY,receiving_account_id text,provider text,
        provider_transaction_id text,event_kind text,currency text,amount_minor bigint,transaction_at text,
        transaction_datetime_raw text,payer_name text,payer_identifier text,version bigint,created_at text,updated_at text);
      CREATE TABLE private.burimunsi_transaction_scopes(transaction_id text,collection_id text,receiving_account_id text,native_source_id text);
      CREATE TABLE private.burimunsi_auto_sms_jobs(source_id text,collection_id text,posting_facts jsonb);
      CREATE TABLE app.momo_financial_links(transaction_id text,payment_id text,beneficiary_member_id text);
      CREATE TABLE app.payments(id text,collection_id text,member_id text,status text);
      CREATE TABLE app.ledger_entries(collection_id text,amount bigint);
      GRANT USAGE ON SCHEMA app,private TO collect_runtime;
      GRANT SELECT ON ALL TABLES IN SCHEMA app TO collect_runtime;
      GRANT UPDATE ON app.memberships,app.users TO collect_runtime;
      INSERT INTO private.burimunsi_scopes VALUES ('group-a'),('group-b');
      INSERT INTO app.momo_receiving_accounts VALUES ('wallet');
      INSERT INTO app.users VALUES ('member-a','Member A','0780000011','active','member'),
        ('member-b','Member B','0780000012','active','member');
      INSERT INTO app.memberships VALUES ('group-a','member-a',1),('group-b','member-b',1);
      INSERT INTO app.sms_receipts VALUES ('sms-in'),('sms-out'),('sms-other'),('sms-foreign');
      INSERT INTO app.momo_transactions VALUES
        ('payment-in','wallet','m-money','ref-in','incoming_receipt','RWF',1000,'2026-11-24T08:00:00Z','08:00','Member A',NULL,2,'2026-11-24T08:00:00Z','2026-11-24T08:00:00Z'),
        ('payment-out','wallet','m-money',NULL,'unknown',NULL,NULL,NULL,NULL,NULL,NULL,1,'2026-11-24T09:00:00Z','2026-11-24T09:00:00Z'),
        ('notice','wallet','m-money',NULL,'other',NULL,NULL,NULL,NULL,NULL,NULL,1,'2026-11-24T10:00:00Z','2026-11-24T10:00:00Z'),
        ('foreign','wallet','m-money','foreign-ref','incoming_receipt','RWF',10,'2026-11-24T11:00:00Z','11:00',NULL,NULL,1,'2026-11-24T11:00:00Z','2026-11-24T11:00:00Z');
      INSERT INTO private.burimunsi_transaction_scopes VALUES ('payment-in','group-a','wallet','sms-in'),
        ('payment-out','group-a','wallet','sms-out'),('notice','group-a','wallet','sms-other'),('foreign','group-b','wallet','sms-foreign');
      INSERT INTO private.burimunsi_auto_sms_jobs VALUES ('sms-out','group-a',
        '{"event_kind":"outgoing","payment_outcome":"successful","currency":"RWF","amount_minor":700,
          "transaction_at":"2026-11-24T09:00:00Z","provider_transaction_id":"ref-out"}');
      INSERT INTO app.momo_financial_links VALUES ('payment-in','former-pay','member-a');
      INSERT INTO app.payments VALUES ('former-pay','group-a','member-a','confirmed');
      INSERT INTO app.ledger_entries VALUES ('group-a',1000);`);
    const migration=new URL('../../../supabase/migrations/20261124114500_burimunsi_payments.sql',import.meta.url);
    await db.query(await readFile(migration,'utf8'));
    await assert.rejects(db.query("INSERT INTO app.ledger_entries VALUES ('group-a',1)"),error=>error.message==='burimunsi_payments_only');
    await db.query("INSERT INTO app.ledger_entries VALUES ('different-product',1)");
    assert.equal((await db.query("SELECT count(*)::int n FROM app.ledger_entries WHERE collection_id='group-a'")).rows[0].n,1);
    await db.query('SET ROLE collect_runtime; BEGIN');
    const sql={unsafe:async(statement,parameters)=>(await db.query(statement,parameters)).rows};
    await setPaymentsScope(sql,'group-a');
    const home=await readPaymentsHome(sql,'group-a','2026-11-24T11:00:00Z',{showSms:false});
    assert.deepEqual([home.paymentCount,home.unallocatedCount,home.memberCount],[2,1,1]);
    assert.deepEqual(home.recentPayments.map(row=>[row.id,row.direction,row.state,row.sourceId]),[
      ['payment-out','outgoing','unallocated',null],['payment-in','incoming','allocated',null]]);
    assert.deepEqual((await readPayments(sql,'group-a',{status:'unallocated',direction:'outgoing',q:'ref-out'})).items.map(row=>row.id),['payment-out']);
    assert.equal(await readPayment(sql,'group-a','foreign'),null);
    assert.equal((await readPayment(sql,'group-a','payment-out',{showSms:true})).sourceId,'sms-out');
    await assert.rejects(assignPayment(sql,{groupId:'group-a',paymentId:'payment-out',memberId:'member-b',expectedVersion:1}),
      error=>error.code==='member_unavailable');
    assert.deepEqual(await assignPayment(sql,{groupId:'group-a',paymentId:'payment-out',memberId:'member-a',expectedVersion:1}),
      {paymentId:'payment-out',memberId:'member-a',state:'allocated',version:2});
    await assert.rejects(assignPayment(sql,{groupId:'group-a',paymentId:'payment-out',memberId:'member-a',expectedVersion:1}),
      error=>error.code==='payment_changed');
    await db.query('ROLLBACK');

    await t.test('Home combines totals and indexed recent payments and restores its snapshot after an optional timeout',async()=>{
      await db.query(`SET ROLE postgres;
        INSERT INTO burimunsi.payments(id,collection_id,receiving_account_id,provider,direction,amount_rwf,occurred_at)
        SELECT 'plan-'||g||'-'||n, g,'wallet','fixture','incoming',n,'2026-11-26'::timestamptz+n*interval '1 second'
        FROM (VALUES ('group-a'),('group-b')) scope(g) CROSS JOIN generate_series(1,5000) n;
        ANALYZE burimunsi.payments;
        CREATE FUNCTION private.burimunsi_home_savings(p_group text)
        RETURNS TABLE(lifetime_contributions_rwf numeric,latest_wallet_balance_rwf numeric,reconciliation_status text)
        LANGUAGE plpgsql AS $$ BEGIN
          IF p_group IS DISTINCT FROM current_setting('burimunsi.collection_id',true) THEN
            RAISE EXCEPTION 'scope changed' USING ERRCODE='42501'; END IF;
          IF current_setting('fixture.savings_delay',true)='representative' THEN PERFORM pg_sleep(0.3); END IF;
          IF current_setting('fixture.savings_delay',true)='timeout' THEN PERFORM pg_sleep(0.6); END IF;
          RETURN QUERY SELECT 1000::numeric,300::numeric,'unavailable'::text;
        END $$;
        SET ROLE collect_runtime;`);
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await setPaymentsScope(sql,'group-a');
      const stable='2026-11-26T11:00:00Z',statements=[];
      const traced={unsafe:(text,values)=>{statements.push(text);return sql.unsafe(text,values);}};
      const plain=await readPaymentsHome(traced,'group-a',stable,{showSms:false});
      assert.equal(plain.paymentCount,5002);assert.equal(plain.recentPayments.length,3);
      assert.ok(plain.recentPayments.every(row=>row.groupId==='group-a'&&row.sourceId===null));
      assert.equal(statements.length,1);
      const previous=[`SELECT count(*) AS payments,count(*) FILTER (WHERE allocation_state='unallocated') AS unallocated,
        (SELECT count(*) FROM app.memberships WHERE collection_id=$1 AND active=1) AS members FROM burimunsi.payments WHERE collection_id=$1`,
        `SELECT p.*,member.full_name AS member_name,member.momo_number AS member_phone,coalesce(p.occurred_at,p.created_at) AS page_at
        FROM burimunsi.payments p LEFT JOIN app.users member ON member.id=p.member_id WHERE p.collection_id=$1
        ORDER BY coalesce(p.occurred_at,p.created_at) DESC,p.id DESC LIMIT 3`];
      const explain=async text=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+text,['group-a'])).rows[0]['QUERY PLAN'][0];
      const before=[await explain(previous[0]),await explain(previous[1])],after=await explain(statements[0]);
      assert.ok(JSON.stringify(before[1]).includes('burimunsi_payments_recent'));
      assert.ok(JSON.stringify(after).includes('burimunsi_payments_recent'));
      t.diagnostic(`Home with 5,002 scoped rows and 5,001 foreign rows. SELECTs 2 -> 1, recent index retained, shared blocks ${before.reduce((n,r)=>n+r.Plan['Shared Hit Blocks'],0)} -> ${after.Plan['Shared Hit Blocks']}, PG executor ${before.reduce((n,r)=>n+r['Execution Time'],0).toFixed(3)} -> ${after['Execution Time'].toFixed(3)} ms.`);
      await db.query("SET LOCAL fixture.savings_delay='representative'");
      assert.deepEqual((await readOptionalPaymentsHome(sql,'group-a',stable,{})).savings,{lifetimeContributionsRwf:1000,
        outgoingPaymentsRwf:700,latestWalletBalanceRwf:300,reconciliationStatus:'unavailable'});
      await assert.rejects(readOptionalPaymentsHome(sql,'group-b',stable,{}),{code:'42501'});
      await db.query('ROLLBACK');
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await setPaymentsScope(sql,'group-a');
      await db.query("SET LOCAL fixture.savings_delay='timeout'; SET LOCAL statement_timeout='2s'");
      assert.deepEqual(await readOptionalPaymentsHome(sql,'group-a',stable,{}),plain);
      const [context]=await sql.unsafe(`SELECT current_setting('statement_timeout') AS deadline,
        current_setting('transaction_read_only') AS readonly,current_setting('burimunsi.collection_id') AS group_id`);
      assert.deepEqual(context,{deadline:'2s',readonly:'on',group_id:'group-a'});
      await db.query('ROLLBACK');
    });
  }finally{await db.end().catch(()=>{});assert.equal((await fixture.close()).removed,true);}
});
