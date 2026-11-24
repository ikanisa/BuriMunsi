import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {verifyEnvironment,verifyBinaryPins} from '../managed-identity-provider-compat/fixture-safety.mjs';
import {writerJournalLinuxPg} from '../testing/writer-journal-pg.mjs';
import {compileSql} from '../../../supabase/functions/_shared/postgres-compatibility-sql.js';
import {attestAdminPasscodeAccount} from '../../../supabase/functions/_shared/domain/admin_email_policy.js';
import {activityAccess,activityPage} from '../../../supabase/functions/_shared/domain/admin_payment_activity.js';
import {paymentActivitySql} from '../../../supabase/functions/_shared/domain/admin_payment_activity_sql.js';
import {canonicalJson} from '../../../supabase/functions/_shared/domain/burimunsi/values.js';

const {Client,types}=createRequire(import.meta.url)('pg');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const group=id(1);
const origin='https://burimunsi-admin.ikanisa.com';
const native={BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'true',BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED:'true'};
const permissions=['payments.read','sms.read','sms.reveal','reconciliations.read','users.read','collections.read','receivers.read'];
function operator(role='admin',grants=permissions) {
 const expires=Math.floor(Date.now()/1000)+300,account={id:id(50),principal_id:id(51),auth_session_id:id(52),token_hash:'a'.repeat(64),
  public_id:id(53),origin,auth_version:2,role,expires_at:expires};
 attestAdminPasscodeAccount(account,{sessionId:id(52),publicId:id(53),adminId:id(50),principalId:id(51),collectionId:group,
  verifiedAt:expires-301,proofId:id(54),accountId:id(55),expiresAt:expires,storageRole:role,operatorRole:role});
 const actor={userId:account.principal_id,sessionId:account.auth_session_id,permissions:new Set(grants)};
 return {account,actor,role,grants};
}
function queryConfig(viewer,query='') {return activityAccess(viewer.account,viewer.actor,new URL('/api/admin/core/payment-activity?'+query,origin));}

test('payment activity validates filter values, signed-in collection, and independent grants',()=>{
 const admin=operator(),staff=operator('staff',permissions);
 assert.deepEqual(queryConfig(admin,'scope=android&group='+group+'&from=2026-01-02&to=2026-01-02').args,
  [group,'android',null,null,null,'2026-01-01T22:00:00.000Z','2026-01-02T22:00:00.000Z',25,0]);
 assert.ok(!queryConfig(staff).grants.includes('sms.read'));
 for(const q of ['scope=sms','scope=captures','scope=android'])assert.throws(()=>queryConfig(staff,q),{status:403});
 for(const q of ['scope=bogus','scope=sms&scope=momo','raw=body','search=%0a','from=2026-02-30','offset=1e2','limit=0'])
  assert.throws(()=>queryConfig(admin,q),{status:400});
 assert.throws(()=>queryConfig(admin,'group='+id(2)),{status:403});
 assert.throws(()=>queryConfig(operator('admin',['payments.read']),'account='+id(4)),{status:403});
 assert.throws(()=>queryConfig(operator('admin',['reconciliations.read'])),{status:403});
 assert.throws(()=>activityAccess({...admin.account},admin.actor,new URL(origin)),{status:403});
 assert.throws(()=>activityAccess(admin.account,{...admin.actor,userId:id(999)},new URL(origin)),{status:403});
});

test('scoped payment activity under PG17 with native processing, global pagination and role redaction',async t=>{
 const policy=process.platform==='linux'?writerJournalLinuxPg:{verifyEnvironment,verifyBinaryPins};
 policy.verifyEnvironment(process.env);await policy.verifyBinaryPins();
 const fixture=await startOwnedPg17({prefix:'collect-pg-transfer-',initialUser:'fixture_bootstrap',clusterName:'collect_activity_fixture'});
 const db=new Client({host:fixture.socket,port:fixture.port,database:'postgres',user:'fixture_bootstrap',connectionTimeoutMillis:5000,
  types:{getTypeParser:(oid,format)=>oid===20?Number:types.getTypeParser(oid,format)}});
 t.after(async()=>{try{await db.end();}finally{await fixture.close();}});
 await db.connect();
 const meta=await db.query("SELECT current_setting('server_version_num')::int/10000 AS version,inet_server_addr() IS NULL AS local");
 assert.deepEqual(meta.rows,[{version:17,local:true}]);
 await db.query(await readFile(new URL('./fixtures/burimunsi-payment-activity.sql',import.meta.url),'utf8'));
 const path=new URL('../../../supabase/migrations/20261124100000_burimunsi_payment_activity_source_metadata.sql',import.meta.url);
 await db.query(await readFile(path,'utf8'));
 const source=id(101),objectSha='b'.repeat(64),fingerprint='c'.repeat(64);
 const descriptor={scope:{ownerId:'fixture-owner',purpose:'sms_receipt',entityId:source},aad:'sms:'+source+':'+objectSha,
  keyId:'fixture-key',plaintextSha256:objectSha,requestDigest:fingerprint,httpMetadata:{contentType:'application/octet-stream'},
  customMetadata:{sha256:objectSha,key_id:'fixture-key'}};
 const sha=createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
 await db.query('UPDATE fixture.observations SET source_fingerprint=$1 WHERE source_id=$2',[sha,source]);
 const privileges=await db.query(`SELECT r,has_function_privilege(r,'private.burimunsi_payment_activity_sources(text,boolean,boolean)','EXECUTE') AS sources,
   has_function_privilege(r,'private.burimunsi_payment_activity_transactions(text)','EXECUTE') AS transfers
  FROM unnest(ARRAY['collect_runtime','service_role','authenticated','anon','collect_importer']) r`);
 assert.deepEqual(privileges.rows.map(row=>[row.r,row.sources,row.transfers]),[
  ['collect_runtime',true,true],['service_role',false,false],['authenticated',false,false],['anon',false,false],['collect_importer',false,false]]);
 await db.query('SET ROLE collect_runtime');
 const setViewer=(role,grants)=>db.query("SELECT set_config('fixture.operator_role',$1,false),set_config('fixture.group_id',$2,false),set_config('fixture.grants',$3,false)",[role,group,grants.join(',')]);
 const admin=operator(),staff=operator('staff',permissions),sms=operator('admin',['sms.read']),review=operator('admin',['reconciliations.read','users.read']);
 const elapsed=[];
 async function page(viewer,query='',env=native) {
  const config=queryConfig(viewer,query);
  await setViewer(viewer.role,viewer.grants);
  const {text,values}=compileSql(paymentActivitySql(env,config.access),config.args),start=performance.now();
  const res=await db.query(text,values),ms=performance.now()-start;
  elapsed.push({query,ms:Math.round(ms*10)/10});
  return activityPage(res.rows[0],config);
 }
 await t.test('authorized totals include unresolved Android admissions, deduplicate one-to-many receipts and expose only verified metadata',async()=>{
  const data=await page(admin);
  assert.equal(data.total,142);
  const payment=data.items.find(item=>item.id===id(11));
  assert.deepEqual(payment.momoIds,[id(31)]);
  assert.deepEqual(payment.receipts.map(s=>s.id),[id(102),id(101)]);
  assert.equal(payment.receipts[1].bodySha256,'a'.repeat(64));assert.equal(payment.receipts[0].bodySha256,null);
  assert.equal(payment.receipts[1].paymentReference,'111111111111');
  assert.ok(!JSON.stringify(data).includes('sms/'));assert.ok(!JSON.stringify(data).includes('fixture-owner'));
  assert.ok(!JSON.stringify(data).includes('sourceFingerprint'));
  assert.equal(data.items.find(i=>i.id===id(106)).status,'unresolved');
  assert.equal(data.items.find(i=>i.id===id(106)).receipts[0].bodySha256,null);
  assert.deepEqual(data.items.find(i=>i.id===id(32)).receipts.map(s=>s.id),[id(105)]);
  assert.ok(data.items.some(i=>i.id===id(103)&&i.kind==='receiver_sms'&&i.attention));
  assert.ok(data.items.some(i=>i.id===id(109)&&i.kind==='receiver_sms'));
  for(const foreign of [13,33,34,107,108,9999])assert.ok(!JSON.stringify(data).includes(id(foreign)));
 });
 await t.test('multiple 25-item pages have a stable global order, exact counts and no overlap; literal and source filters use the complete snapshot',async()=>{
  const all=[];
  for(let offset=0;offset<150;offset+=25){const v=await page(admin,'offset='+offset);assert.equal(v.total,142);all.push(...v.items);}
  assert.equal(all.length,142);assert.equal(new Set(all.map(i=>i.kind+i.id)).size,142);
  assert.deepEqual(all,all.toSorted((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id)));
  assert.equal((await page(admin,'offset=175')).total,142);assert.deepEqual((await page(admin,'offset=175')).items,[]);
  assert.deepEqual((await page(admin,'scope=momo')).items.map(i=>i.id),[id(11),id(32)]);
  assert.deepEqual((await page(admin,'search=PAY%25_')).items.map(i=>i.id),[id(11)]);
  assert.deepEqual((await page(admin,'scope=payments&from=2026-01-03&to=2026-01-03')).items.map(i=>i.id),[id(11),id(12)]);
  assert.equal((await page(admin,'scope=payments&to=2026-01-02')).total,0);
  assert.equal((await page(admin,'status=duplicate')).total,1);
  assert.deepEqual((await page(admin,'scope=captures')).items.map(i=>i.id),[id(104),id(32)]);
  assert.equal((await page(admin,'account='+id(5))).total,0);
  assert.ok((await page(admin,'scope=attention')).items.some(i=>i.id===id(12)&&i.reconciliationId===id(12)));
 });
 await t.test('Staff financial-only, SMS-only, reconciliation and disabled observation reads preserve independent authority',async()=>{
  const staffData=await page(staff);
  assert.deepEqual(staffData.items.map(i=>i.id),[id(11),id(12),id(32)]);
  assert.ok(staffData.items.every(i=>i.receipts.length===0));assert.ok(!JSON.stringify(staffData).includes(id(101)));
  const sourceData=await page(sms);assert.equal(sourceData.total,142);
  assert.ok(sourceData.items.every(i=>['capture','receiver_sms'].includes(i.kind)&&!i.paymentId&&!i.reconciliationId&&!i.momoIds.length&&
   i.receipts.every(s=>s.bodySha256===null&&s.paymentReference===null&&s.payerStatus===null)));
  const attention=await page(review,'scope=attention');
  assert.deepEqual(attention.items.map(i=>[i.id,i.reconciliationId,i.paymentId,i.momoIds,i.receipts]),[[id(12),id(12),null,[],[]]]);
  assert.equal((await page(admin,'scope=android',{...native,BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED:'false'})).total,0);
  const noNative=await page(admin,'scope=momo',{...native,BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'false'});
  assert.deepEqual(noNative.items.map(i=>i.id),[id(32)]);
  await setViewer('staff',permissions);
  await assert.rejects(db.query('SELECT * FROM private.burimunsi_payment_activity_sources($1,false,false)',[group]),{code:'42501'});
  for(const role of ['', 'auditor']){await setViewer(role,permissions);await assert.rejects(db.query('SELECT * FROM private.burimunsi_payment_activity_transactions($1)',[group]),{code:'42501'});}
  await setViewer('admin',permissions);await assert.rejects(db.query('SELECT * FROM private.burimunsi_payment_activity_transactions($1)',[id(2)]),{code:'42501'});
 });
 await t.test('Staff can display and search public references while legacy SMS evidence keys stay private',async()=>{
  const limited=operator('staff',['payments.read']),first='sMs:fixture-sensitive-digest:'+id(801),second='SMS:another-private-digest:'+id(802);
  await db.query('BEGIN');
  try{
   await db.query('RESET ROLE');
   await db.query('UPDATE app.payments SET payment_reference=NULL WHERE id=$1',[id(12)]);
   await db.query('UPDATE app.payment_evidence SET external_reference=$1 WHERE id=$2',[first,id(22)]);
   await db.query('UPDATE app.payment_evidence SET external_reference=$1 WHERE id=$2',[second,id(21)]);
   await db.query('SET LOCAL ROLE collect_runtime');
   const result=await page(limited,'scope=payments');
   assert.equal(result.items.find(row=>row.id===id(12)).reference,null);
   assert.equal(result.items.find(row=>row.id===id(11)).reference,'111111111111');
   for(const term of [first,second,'fixture-sensitive-digest','another-private-digest',id(801),id(802)]){
    assert.equal((await page(limited,'search='+encodeURIComponent(term))).total,0);
   }
   assert.deepEqual((await page(limited,'search=111111111111')).items.map(row=>row.id),[id(11)]);
   await db.query('RESET ROLE');
   await db.query('UPDATE app.payment_evidence SET external_reference=$1 WHERE id=$2',['MTN-SMS:provider-reference',id(22)]);
   await db.query('SET LOCAL ROLE collect_runtime');
   const provider=await page(limited,'search=provider-reference');
   assert.deepEqual(provider.items.map(row=>row.reference),['MTN-SMS:provider-reference']);
  }finally{await db.query('ROLLBACK');}
 });
 await t.test('37 scoped transfers with 11 linked payments and 37 linked receiver receipts plus one pre-storage admission yield exactly 38 Admin activities',async()=>{
  await db.query('RESET ROLE');
  await db.query(`TRUNCATE app.payments,app.payment_evidence,app.ledger_entries,app.reconciliations,app.momo_transactions,
    app.momo_financial_links,app.momo_transaction_sources,app.momo_parse_attempts,app.sms_receipts,
    private.burimunsi_transaction_scopes,private.burimunsi_sms_source_scopes,private.burimunsi_auto_sms_jobs,fixture.observations,fixture.native;
   INSERT INTO app.payment_evidence SELECT fixture.id(2300+n),fixture.id(1),'ref-'||n FROM generate_series(1,11)n;
   INSERT INTO app.payments SELECT fixture.id(2000+n),fixture.id(1),fixture.id(3),fixture.id(2300+n),NULL,
    100+n,'RWF','confirmed','Synthetic payer','2026-01-01T00:00:00.000Z',1,(100000000000::bigint+n)::text FROM generate_series(1,11)n;
   INSERT INTO app.momo_financial_links SELECT fixture.id(2100+n),fixture.id(2000+n),fixture.id(3) FROM generate_series(1,11)n;
   INSERT INTO app.momo_transactions SELECT fixture.id(2100+n),fixture.id(4),'transfer-'||n,'incoming_receipt',100+n,
    'RWF',0,'Synthetic payer','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','unallocated',0,fixture.id(2400+n) FROM generate_series(1,37)n;
   INSERT INTO private.burimunsi_transaction_scopes SELECT fixture.id(2100+n),fixture.id(1),fixture.id(4) FROM generate_series(1,37)n;
   INSERT INTO fixture.native SELECT fixture.id(2100+n),fixture.id(1) FROM generate_series(1,37)n;
   INSERT INTO app.sms_receipts SELECT fixture.id(2200+n),'synthetic-owner',NULL,repeat('a',64),repeat('b',64),'received','observed','2026-01-01T00:00:00.000Z'
    FROM generate_series(1,37)n;
   INSERT INTO app.momo_parse_attempts SELECT fixture.id(2400+n),fixture.id(2200+n),'accepted',repeat('a',64),'v1','p1','2026-01-01T00:00:00.000Z' FROM generate_series(1,37)n;
   INSERT INTO app.momo_transaction_sources SELECT fixture.id(2100+n),fixture.id(2200+n),fixture.id(2400+n),'accepted' FROM generate_series(1,37)n;
   INSERT INTO fixture.observations SELECT fixture.id(1),fixture.id(2200+n),1767225600000::bigint+n,
    CASE WHEN n=38 THEN 'unresolved' ELSE 'retained' END,CASE WHEN n<=37 THEN repeat('a',64) END,'synthetic-owner',
    NULL,NULL,NULL,NULL,NULL,CASE WHEN n=38 THEN 'pending' WHEN n<=11 THEN 'posted' ELSE 'unmatched' END,
    CASE WHEN n<=11 THEN (100000000000::bigint+n)::text END FROM generate_series(1,38)n;
   SET ROLE collect_runtime`);
  const first=await page(admin),second=await page(admin,'offset=25');
  assert.equal(first.total,38);assert.equal(first.items.length,25);assert.equal(second.items.length,13);
  const rows=[...first.items,...second.items];
  assert.equal(rows.filter(i=>i.kind==='payment').length,11);assert.equal(rows.filter(i=>i.kind==='momo').length,26);
  assert.equal(rows.filter(i=>i.kind==='receiver_sms').length,1);
  assert.equal(rows.flatMap(i=>i.momoIds).length,37);
  const receipts=rows.flatMap(i=>i.receipts);
  assert.equal(receipts.length,38);assert.equal(new Set(receipts.map(s=>s.id)).size,38);
  assert.equal((await page(staff)).total,37);
 });

 t.diagnostic('Socket PostgreSQL 17 synthetic query milliseconds '+JSON.stringify(elapsed.filter(x=>x.query.startsWith('offset='))));
});
