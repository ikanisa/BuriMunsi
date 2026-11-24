import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {assignPayment,readPayment,readPayments,readPaymentsHome,setPaymentsScope} from '../../../supabase/functions/_shared/domain/burimunsi/postgres-payments.js';

const {Client}=createRequire(import.meta.url)('pg');

test('payments migration carries forward both directions and closes the old write path',async()=>{
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
  }finally{await db.end().catch(()=>{});assert.equal((await fixture.close()).removed,true);}
});
