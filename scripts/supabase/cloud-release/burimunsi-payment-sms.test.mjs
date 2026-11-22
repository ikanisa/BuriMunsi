import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import { test } from 'node:test';
import pg from '../node_modules/pg/lib/index.js';

import {fixturePaymentId as id,startPayerFixture} from './fixtures/burimunsi-payer-postgres.mjs';
import {openFixturePayerWorker} from './fixtures/burimunsi-payer-delivery.mjs';

const {Client}=pg;
const group=id(1),member=id(2),app='app_'+id(3),phone='+250788000001',hash='a'.repeat(64);
const fixture=(t,options={})=>startPayerFixture(t,{seedHistoricalPayment:true,...options});

test('one canonical payment allows one armed body and GET-only reconciliation', async (t) => {
  const f = await fixture(t);
  const retention = (await f.db.query('SELECT private._retention_manifest_catalog_v2() AS catalog')).rows[0].catalog;
  assert.deepEqual(retention.private_classes.map(({relation, blocked}) => ({relation, blocked})),
    [{relation: 'private.burimunsi_payment_sms_deliveries', blocked: true}, {relation: 'private.burimunsi_payment_sms_obligations', blocked: true}]);
  const {pay, entry, posted} = await f.record(20);
  assert.deepEqual(await f.readiness(), {contract_version: 1, eligible_count: 1, unresolved_count: 0});
  const [row] = await f.claim();
  assert.equal(row.phase, 'send');
  assert.equal(row.body_sha256, null);
  assert.equal(row.destination, phone);
  assert.equal(row.posted_reference, pay);
  assert.equal(row.posted_at, posted);
  assert.equal(row.amount_rwf, 125);
  assert.equal(row.member_balance_rwf, 765);
  assert.equal(row.message_id, app + ':buri-receipt:' + entry);
  assert.equal(row.idempotency_key, 'buri-receipt:' + entry);
  assert.ok(Math.abs(Date.parse(row.not_after)-Date.now()-300_000)<3000);
  assert.equal(Object.hasOwn(row, 'group_balance_rwf'), false);
  assert.deepEqual(await f.claim(), []);
  assert.equal(await f.prepare(row, id(8)), 'held');
  assert.equal(await f.prepare(row), 'prepared');
  assert.equal(await f.prepare(row), 'held');
  assert.equal(await f.finish(row, 'unknown'), true);
  await f.db.exec("UPDATE private.burimunsi_payment_sms_deliveries SET next_inspect_at=clock_timestamp()-interval '1 second'");
  const [read] = await f.claim();
  assert.equal(read.phase, 'inspect');
  assert.equal(read.attempt_id, row.attempt_id);
  assert.equal(read.message_id, row.message_id);
  assert.equal(read.destination, null);
  assert.equal(read.destination_sha256, row.destination_sha256);
  assert.equal(read.body_sha256, hash);
  assert.equal(await f.prepare(read), 'held');
  assert.equal(await f.finish(row, 'accepted', 'delivered'), false);
  assert.equal(await f.finish(read, 'accepted', 'delivered'), true);
  assert.deepEqual(await f.claim(), []);
  assert.deepEqual(await f.readiness(), {contract_version: 1, eligible_count: 0, unresolved_count: 0});
});

test('private jobs-only receipt selection rejects masked, unrelated, historical, reversed and pre-activation payments', async (t) => {
  const f = await fixture(t);
  // The verified member controls this recipient number; neither that challenge
  // nor matching last digits proves the wallet used to pay this transaction.
  await f.db.exec(`CREATE OR REPLACE FUNCTION private.managed_phone_binding(text,text,text) RETURNS boolean LANGUAGE sql
    AS $$SELECT $2='verified-member-contact' AND $3='+250788000001'$$`);
  await f.db.query("INSERT INTO app.assisted_sms_authorizations VALUES($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'),1,1,'verified-member-contact')",[group,member,phone]);
  assert.equal((await f.db.query("SELECT private.managed_phone_binding($1,'verified-member-contact',$2) AS verified",[member,phone])).rows[0].verified,true);
  const masked=await f.record(20, { payer: '******001' });
  assert.equal((await f.db.query('SELECT disposition FROM private.burimunsi_payment_sms_obligations WHERE payment_id=$1',[masked.pay])).rows[0].disposition,'unverified_destination');
  await f.db.exec('DELETE FROM app.assisted_sms_authorizations');
  await f.record(25, { payer: '+250788000099' });
  await f.record(30, { mode: 'historical' });
  await f.record(35, { age: 120_000 });
  const reversed = await f.record(40);
  await f.db.query("INSERT INTO app.ledger_entries(id,reverses_entry_id,kind) VALUES($1,$2,'reversal')", [id(99), reversed.entry]);
  assert.deepEqual(await f.claim(), []);
  assert.deepEqual(await f.claim(id(8)), []);
  await assert.rejects(f.claim(group, 'http_collect'), /jobs work required/);
  await assert.rejects(f.claim(group, 'jobs', 'anon'), /permission denied/);
  await assert.rejects(f.db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE collect_runtime');
    return tx.query('SELECT * FROM private.burimunsi_payment_sms_deliveries');
  }), /permission denied/);
});

test('updated member authority suppresses before POST and keeps the original receipt identity', async (t) => {
  const f = await fixture(t);
  await f.record(20);
  const [row] = await f.claim();
  await f.db.query("INSERT INTO app.assisted_sms_authorizations VALUES($1,$2,$3,1,0,NULL)", [group, member, row.destination_sha256]);
  assert.equal(await f.prepare(row), 'suppressed');
  assert.equal(await f.prepare(row), 'held');
  await f.db.query('DELETE FROM app.assisted_sms_authorizations');
  assert.deepEqual(await f.claim(), []);
  await f.record(30);
  await f.db.query('INSERT INTO app.notification_preferences VALUES($1,0)', [member]);
  assert.deepEqual(await f.claim(), []);
  await f.db.query('DELETE FROM app.notification_preferences');
  await f.db.query('INSERT INTO app.privacy_retention_barriers VALUES($1)', [member]);
  assert.deepEqual(await f.claim(), []);
  await f.db.query('DELETE FROM app.privacy_retention_barriers');
  assert.deepEqual(await f.claim(), []);
  await f.record(40);
  const [original] = await f.claim();
  await f.db.query("UPDATE app.users SET momo_number='+250788000002' WHERE id=$1", [member]);
  assert.equal(await f.prepare(original), 'suppressed');
  const stored = (await f.db.query('SELECT state, body_sha256, claim_token FROM private.burimunsi_payment_sms_deliveries WHERE attempt_id=$1', [original.attempt_id])).rows[0];
  assert.deepEqual(stored, {state: 'suppressed', body_sha256: null, claim_token: null});
});


test('Admin SMS aggregates require current global and collection authority and keep postings and gateway outcomes distinct', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adminHealth('anon'), /permission denied/);
  await assert.rejects(f.adminHealth('collect_runtime', 'jobs'), /Admin runtime required/);
  await assert.rejects(f.adminHealth(), /permission denied/);
  await f.db.exec("INSERT INTO app.admin_grants VALUES('principal','system_health.read'),('principal','sms.read'); INSERT INTO app.admin_account_role_capabilities VALUES('owner','sms.read')");
  assert.equal(await f.adminHealth(), null);
  await f.db.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')", [group]);
  const {pay} = await f.record(20);
  const recorded = (await f.db.query('SELECT transaction_id FROM app.momo_financial_links WHERE payment_id=$1', [pay])).rows[0].transaction_id;
  const now = Date.now();
  await f.db.query(`INSERT INTO private.burimunsi_auto_sms_jobs VALUES
    ('posted-source',$1,$4,'completed','accepted',1,0,0,$3),
    ('retry-source',$1,NULL,'retry',NULL,2,0,0,$3),
    ('blocked-source',$1,NULL,'failed',NULL,5,0,0,$3),
    ('unrelated-source',$2,NULL,'failed',NULL,5,0,0,$3)`, [group,id(8),now-20000,recorded]);
  await f.db.query("INSERT INTO private.burimunsi_unresolved_observations VALUES('new-source',$1,$2),('posted-source',$1,$2)", [group,now-60000]);
  const [receipt] = await f.claim();
  assert.equal(await f.prepare(receipt), 'prepared');
  assert.equal(await f.finish(receipt, 'accepted','queued'), true);
  const sample = await f.adminHealth();
  assert.deepEqual({...sample.burimunsi_sms, oldest_pending_seconds: 60}, {
    pending: 1,retrying: 1,blocked: 1,unmatched: 0,posted: 1,oldest_pending_seconds: 60,
  });
  assert.ok(sample.burimunsi_sms.oldest_pending_seconds>=59);
  assert.deepEqual(sample.burimunsi_payer_sms, {pending: 0,gateway_accepted: 1,sent: 0,delivered: 0,failed: 0,unknown: 0,suppressed: 0});
  assert.equal(JSON.stringify(sample).includes(group), false);
  await f.db.exec("DELETE FROM app.admin_grants WHERE permission='sms.read'");
  assert.equal(await f.adminHealth(), null);
});

test('historical and concurrent payments get unique durable display references and preserve financial writes', async t => {
  const f=await fixture(t);
  const getReference=async id=>(await f.db.query('SELECT payment_reference FROM app.payments WHERE id=$1',[id])).rows[0].payment_reference;
  assert.match(await getReference('historical-payment'), /^[0-9]{12}$/);
  const parallel = new Client({host:f.cluster.socket, port:f.cluster.port, database:'postgres', user:f.cluster.initialUser});
  await parallel.connect();
  try {
    await parallel.query('SET ROLE collect_runtime');
    const insert='INSERT INTO app.payments(id,amount_minor) VALUES($1,1) RETURNING payment_reference';
    const [a,b]=await Promise.all([f.db.transaction(async tx=>{
      await tx.exec('SET LOCAL ROLE collect_runtime');
      return tx.query(insert,['new-payment-a']);
    }),parallel.query(insert,['new-payment-b'])]);
    const refs=[a,b].map(row=>row.rows[0].payment_reference);
    assert.ok(refs.every(value=>/^[0-9]{12}$/.test(value))); assert.notEqual(refs[0],refs[1]);
    await parallel.query("UPDATE app.payments SET status='reversed' WHERE id='new-payment-a'");
    assert.equal(await getReference('new-payment-a'), refs[0]);
    await assert.rejects(parallel.query("UPDATE app.payments SET payment_reference=DEFAULT WHERE id='new-payment-a'"), /payment_reference_immutable/);
    assert.equal(await getReference('new-payment-a'), refs[0]);
    assert.equal((await parallel.query('SELECT id FROM app.payments WHERE payment_reference=$1',[refs[1]])).rows[0].id,'new-payment-b');
  } finally {await parallel.end();}
});


test('a complete synthetic PostgreSQL restore retains display references and resumes allocation', async t => {
  const {cluster,db}=await fixture(t);
  const committed=await db.query("INSERT INTO app.payments(id,amount_minor) VALUES('restore-payment',1) RETURNING payment_reference");
  const original=committed.rows[0].payment_reference;
  const connection=['-h',cluster.socket,'-p',String(cluster.port),'-U',cluster.initialUser];
  const dump=execFileSync(join(cluster.bin,'pg_dump'),[...connection,'-d','postgres','--schema=app','--schema=private'],{env:cluster.env,maxBuffer:2**22});
  await db.exec('CREATE DATABASE payment_restore_fixture');
  execFileSync(join(cluster.bin,'psql'),[...connection,'-d','payment_restore_fixture','-Xq','-v','ON_ERROR_STOP=1'],{env:cluster.env,input:dump});
  const restore=new Client({host:cluster.socket,port:cluster.port,database:'payment_restore_fixture',user:cluster.initialUser});
  await restore.connect();
  try {
    assert.equal((await restore.query("SELECT payment_reference FROM app.payments WHERE id='restore-payment'")).rows[0].payment_reference,original);
    await restore.query('SET ROLE collect_runtime');
    assert.ok(BigInt((await restore.query("INSERT INTO app.payments(id,amount_minor) VALUES('new-payment',1) RETURNING payment_reference")).rows[0].payment_reference)>BigInt(original));
  } finally {await restore.end();}
});

test('canonical credit commits its original notice, and concurrent replay and rollback preserve one obligation',async t=>{
  const f=await fixture(t);
  const second=new Client({host:f.cluster.socket,port:f.cluster.port,database:'postgres',user:f.cluster.initialUser});
  await second.connect();
  let replay;
  try { await f.db.transaction(async()=>{
    await f.post(50);
    replay=second.query("INSERT INTO app.payments(id) VALUES($1) ON CONFLICT(id) DO NOTHING RETURNING id",[id(50)]);
    assert.equal((await f.db.query("SELECT count(*) FROM private.burimunsi_payment_sms_obligations")).rows[0].count,'0');
  });
  assert.equal((await replay).rowCount,0); } finally {await second.end();}
  await assert.rejects(f.db.transaction(async()=>{
    await f.post(60); throw Error('abort after posting');
  }),/abort after posting/);
  const {rows:[counts]}=await f.db.query(`SELECT
    (SELECT count(*) FROM app.ledger_entries) AS credits,
    (SELECT count(*) FROM private.burimunsi_payment_sms_obligations) AS notices,
    (SELECT count(*) FROM private.burimunsi_payment_sms_deliveries) AS attempts`);
  assert.deepEqual(counts,{credits:'1',notices:'1',attempts:'0'});
  await assert.rejects(f.db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE collect_runtime');
    await tx.query('SELECT * FROM private.burimunsi_payment_sms_obligations');
  }),/permission denied/);
});

test('expired, suppressed and delivered receipts remain visible in the scoped Admin panel after an outage and a lost acknowledgement',async t=>{
  const f=await fixture(t,{enabledAgo:3600000});
  await f.db.exec("INSERT INTO app.admin_grants VALUES('principal','system_health.read'),('principal','sms.read'),('principal','payments.read'); INSERT INTO app.admin_account_role_capabilities VALUES('owner','sms.read')");
  await f.db.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
  await f.db.exec("INSERT INTO collect_ops.jobs_dispatches VALUES('scheduled','confirmed',now()-interval '1 minute',repeat('b',64)),('probe','confirmed',now(),repeat('c',64)); INSERT INTO collect_sms.devices VALUES(now()::text,1,NULL,'[\"receipt\"]')");
  await f.db.exec("INSERT INTO private.collect_managed_job_tickets SELECT id,now(),response_sha256 FROM collect_ops.jobs_dispatches WHERE kind='scheduled'");
  const operations=()=>f.rpc('burimunsi_admin_sms_operations',[],[],'http_admin');
  const disposition=(g,source)=>f.rpc('burimunsi_admin_observation_outcomes',[g,[source],true],['text','text[]','boolean'],'http_admin');
  const delayed=await f.record(20,{age:480000,postedAge:420000});
  assert.equal((await operations()).payer.pending,1);
  const [recovered]=await f.claim();
  assert.equal(recovered.payment_id,delayed.pay);
  assert.equal(recovered.posted_at,delayed.posted);assert.equal(recovered.member_balance_rwf,765);
  assert.ok(Date.parse(recovered.not_after)>Date.now()+295000);
  assert.equal(await f.prepare(recovered),'prepared');assert.equal(await f.finish(recovered,'accepted','delivered'),true);
  await f.record(25);
  const [expired]=await f.claim();
  assert.equal(await f.prepare(expired),'prepared');assert.equal(await f.finish(expired,'accepted','expired'),true);
  await f.record(30,{payer:'***0001'});
  await f.db.query('INSERT INTO app.notification_preferences VALUES($1,0)',[member]);
  await f.record(40);
  await f.db.query('DELETE FROM app.notification_preferences');
  const posted=await f.record(50);
  const src=id(52);
  await f.db.query("INSERT INTO private.burimunsi_auto_sms_jobs VALUES($1,$2,$1,'completed','accepted',1,0,0,$3)",[src,group,Date.now()-5000]);
  const first=await operations();
  assert.equal(first.payer.expired,1);assert.equal(first.payer.suppressed,2);assert.equal(first.payer.pending,1);
  assert.equal(first.reasons.gateway_expired,1);assert.equal(first.reasons.unverified_destination,1);assert.equal(first.reasons.preferences_disabled,1);
  assert.ok(first.oldest_pending_seconds>=4);assert.equal(first.last_confirmed_sha256,'b'.repeat(64));assert.ok(first.gateway_last_seen_at);
  assert.deepEqual([first.scheduler_enabled,first.cron_active,first.gateway_heartbeat,first.unresolved_dispatches],[true,true,'recent',0]);
  assert.equal(first.cron_interval_seconds,60);
  await f.db.exec("UPDATE cron.job SET schedule='1 second'");
  const fast=await operations();assert.equal(fast.cron_active,true);assert.equal(fast.cron_interval_seconds,1);
  await f.db.exec("UPDATE cron.job SET active=false; UPDATE collect_sms.devices SET last_seen_at=(now()-interval '2 minutes')::text; INSERT INTO collect_ops.jobs_dispatches(kind,state) VALUES('scheduled','unconfirmed')");
  const stale=await operations();assert.deepEqual([stale.scheduler_enabled,stale.cron_active,stale.gateway_heartbeat,stale.unresolved_dispatches],[true,false,'stale',1]);
  const [send]=await f.claim();
  assert.equal(send.payment_id,posted.pay);assert.equal(await f.prepare(send),'prepared');
  assert.equal(await f.finish(send,'unknown'),true);
  await f.db.exec("UPDATE private.burimunsi_payment_sms_deliveries SET next_inspect_at=now()-interval '1 minute'");
  await f.record(60);await f.record(70);
  const [inspect]=await f.claim();
  assert.equal(inspect.phase,'inspect');assert.equal(inspect.message_id,send.message_id);
  assert.equal(await f.finish(inspect,'accepted','delivered'),true);
  assert.equal((await f.claim())[0].phase,'send');
  const reference=(await f.db.query("SELECT payment_reference FROM app.payments WHERE id=$1",[posted.pay])).rows[0].payment_reference;
  assert.deepEqual(await disposition(group,src),[{sourceId:src,processing:'posted',paymentReference:reference,payerStatus:'delivered',payerReason:null}]);
  const redacted=await f.rpc('burimunsi_admin_observation_outcomes',[group,[src],false],['text','text[]','boolean'],'http_admin');
  assert.equal(redacted[0].paymentReference,null);assert.equal(redacted[0].payerStatus,null);
  const last=await operations();assert.equal(last.payer.delivered,2);assert.equal(last.payer.unknown,0);
  await assert.rejects(disposition(id(999),src),/scope denied/);
  assert.ok(!JSON.stringify(last).includes(phone));
});

test('payment SMS worker recovers a late PostgreSQL posting and a lost gateway reply with exactly one POST and scoped Admin delivery',async t=>{
  const f=await fixture(t,{enabledAgo:3600000});
  const native=await f.record(80,{age:490000,postedAge:480000}), source=id(82);
  await f.db.query("INSERT INTO private.burimunsi_auto_sms_jobs VALUES($1,$2,$1,'completed','accepted',1,0,0,$3)",[source,group,Date.now()-480000]);
  await f.db.exec("INSERT INTO app.admin_grants VALUES('principal','payments.read')");
  await f.db.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
  const worker=await openFixturePayerWorker({client:f.client,collectionId:group,enabledAt:f.enabledAt,applicationId:app});
  try{
    assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'unknown'});
    assert.equal((await f.db.query("SELECT state FROM private.burimunsi_payment_sms_deliveries WHERE payment_id=$1",[native.pay])).rows[0].state,'unknown');
    await f.db.exec("UPDATE private.burimunsi_payment_sms_deliveries SET next_inspect_at=now()+interval '8 hours',inspect_count=12");
    await f.db.query("INSERT INTO collect_sms.messages VALUES($1,$2,'receipt',$3,'delivered')",
      [app+':buri-receipt:'+id(999),app,'buri-receipt:'+id(999)]);
    assert.deepEqual(await worker.drain(),{status:'complete',processed:0});
    await worker.carrierDelivered();
    assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'accepted',gateway_state:'delivered'});
    assert.deepEqual(await worker.drain(),{status:'complete',processed:0});
    assert.deepEqual(worker.requests,['POST','GET']);
    assert.equal(worker.submitted.to,phone);assert.equal(worker.submitted.message_id,app+':buri-receipt:'+native.entry);
    assert.match(worker.submitted.text,/125 RWF/);assert.match(worker.submitted.text,/765 RWF/);
    const detail=await f.rpc('burimunsi_admin_observation_outcomes',[group,[source],true],['text','text[]','boolean'],'http_admin');
    assert.equal(detail[0].payerStatus,'delivered');assert.equal(detail[0].processing,'posted');assert.match(detail[0].paymentReference,/^\d{12}$/);
    const counts=await f.db.query(`SELECT (SELECT count(*) FROM app.ledger_entries WHERE payment_id=$1) AS credits,
      (SELECT count(*) FROM private.burimunsi_payment_sms_obligations WHERE payment_id=$1) AS obligations,
      (SELECT count(*) FROM private.burimunsi_payment_sms_deliveries WHERE payment_id=$1 AND evidence_sha256 ~ '^[a-f0-9]{64}$') AS deliveries`,[native.pay]);
    assert.deepEqual(counts.rows[0],{credits:'1',obligations:'1',deliveries:'1'});
  }finally{await worker.complete();}
});


test('non-bypass definer reads only exact payer gateway hints under authenticated jobs and scoped Admin frames',async t=>{
  const f=await fixture(t);
  await f.record(90);
  await f.db.exec("INSERT INTO app.admin_grants VALUES('principal','system_health.read'),('principal','sms.read'); INSERT INTO app.admin_account_role_capabilities VALUES('owner','sms.read')");
  await f.db.query("INSERT INTO private.burimunsi_operator_approvals VALUES($1,'principal','admin',true,ARRAY['records.read','sms.read'],NULL,'admin')",[group]);
  await f.db.exec('RESET ROLE; ALTER ROLE postgres NOSUPERUSER NOBYPASSRLS');
  const [send]=await f.claim();
  assert.equal(await f.prepare(send),'prepared');assert.equal(await f.finish(send,'unknown'),true);
  await f.db.query("INSERT INTO collect_sms.messages VALUES($1,$2,'receipt',$3,'delivered')",[send.message_id,app,send.idempotency_key]);
  assert.deepEqual(await f.db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE postgres');
    return (await tx.query('SELECT state FROM collect_sms.messages')).rows;
  }),[]);
  const [read]=await f.claim();
  assert.equal(read.phase,'inspect');assert.equal(read.message_id,send.message_id);
  assert.equal(await f.finish(read,'accepted','delivered'),true);
  const health=await f.rpc('burimunsi_admin_sms_operations',[],[],'http_admin');
  assert.equal(health.payer.delivered,1);
  await assert.rejects(f.db.transaction(async tx=>{
    await tx.exec('SET LOCAL ROLE collect_runtime');
    return tx.exec('SELECT message_id FROM collect_sms.messages');
  }),/permission denied/);
});


test('a lost claim commit reply resumes the exact unarmed payment and never submits a second message',async t=>{
  const f=await fixture(t,{enabledAgo:3600000});
  const native=await f.record(80);
  const worker=await openFixturePayerWorker({client:f.client,collectionId:group,enabledAt:f.enabledAt,applicationId:app,lostClaimReply:true});
  try{
    assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'unknown'});
    const {rows:[entry]}=await f.db.query('SELECT * FROM private.burimunsi_payment_sms_deliveries WHERE payment_id=$1',[native.pay]);
    assert.ok(entry.claim_request_id);assert.ok(entry.claim_admission_id);assert.equal(worker.submitted.message_id,entry.message_id);
    assert.deepEqual(worker.requests,['POST']);
    await worker.carrierDelivered();
    assert.deepEqual(await worker.drain(),{status:'complete',processed:1,outcome:'accepted',gateway_state:'delivered'});
    assert.deepEqual(worker.requests,['POST','GET']);
    assert.equal((await f.db.query('SELECT count(*) FROM private.burimunsi_payment_sms_deliveries')).rows[0].count,'1');
  }finally{await worker.complete();}
});

test('after a worker dies, only the proved unarmed lease can rotate its deadline, under current authority and the same identity',async t=>{
  const f=await fixture(t,{enabledAgo:3600000});
  const expire=async r=>f.db.query("UPDATE private.burimunsi_payment_sms_deliveries SET lease_until=now()-interval '1 second' WHERE attempt_id=$1",[r.attempt_id]);
  await f.record(90);const [original]=await f.claim();
  await assert.rejects(f.db.query("UPDATE private.burimunsi_payment_sms_deliveries SET not_after=now()+interval '1 hour' WHERE attempt_id=$1",
    [original.attempt_id]),/payment_sms_identity_changed/);
  // Simulate the persisted time fields from a seven-minute worker outage.
  await f.db.exec('ALTER TABLE private.burimunsi_payment_sms_deliveries DISABLE TRIGGER burimunsi_payment_sms_immutable');
  await f.db.query("UPDATE private.burimunsi_payment_sms_deliveries SET lease_until=now()-interval '6 minutes',not_after=now()-interval '2 minutes' WHERE attempt_id=$1",[original.attempt_id]);
  await f.db.exec('ALTER TABLE private.burimunsi_payment_sms_deliveries ENABLE ALWAYS TRIGGER burimunsi_payment_sms_immutable');
  assert.deepEqual(await f.readiness(),{contract_version:1,eligible_count:1,unresolved_count:0});
  const [renewed]=await f.claim();
  assert.deepEqual([renewed.phase,renewed.attempt_id,renewed.message_id,renewed.idempotency_key,renewed.destination],
    ['send',original.attempt_id,original.message_id,original.idempotency_key,original.destination]);
  assert.notEqual(original.claim_token,renewed.claim_token);assert.ok(Date.parse(renewed.not_after)>Date.now()+295000);
  assert.equal(await f.prepare(original),'held');assert.equal(await f.prepare(renewed),'prepared');
  await expire(renewed);await f.db.query("UPDATE private.burimunsi_payment_sms_deliveries SET next_inspect_at=now() WHERE attempt_id=$1",[renewed.attempt_id]);
  const [read]=await f.claim();assert.equal(read.phase,'inspect');assert.equal(read.message_id,original.message_id);
  assert.equal(await f.finish(read,'accepted','delivered'),true);
  await f.record(100);const [changed]=await f.claim();await expire(changed);
  await f.db.query('INSERT INTO app.notification_preferences VALUES($1,0)',[member]);
  assert.deepEqual(await f.claim(),[]);assert.equal((await f.db.query('SELECT state FROM private.burimunsi_payment_sms_deliveries WHERE attempt_id=$1',[changed.attempt_id])).rows[0].state,'suppressed');
  await f.db.query('DELETE FROM app.notification_preferences');await f.record(110);const [legacy]=await f.claim();
  await f.db.query('UPDATE private.burimunsi_payment_sms_deliveries SET last_claimed_phase=NULL WHERE attempt_id=$1',[legacy.attempt_id]);
  await expire(legacy);assert.deepEqual(await f.claim(),[]);
  await f.record(120);const [conflict]=await f.claim();await expire(conflict);
  await f.db.query("INSERT INTO collect_sms.messages(message_id,application_id,kind,idempotency_key,state) VALUES($1,$2,'receipt',$3,'accepted')",
    [conflict.message_id,app,conflict.idempotency_key]);
  assert.deepEqual(await f.claim(),[]);const [inspection]=await f.claim();assert.equal(inspection.phase,'inspect');assert.equal(inspection.message_id,conflict.message_id);
});
