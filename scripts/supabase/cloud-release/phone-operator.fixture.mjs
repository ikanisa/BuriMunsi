// This fixture runs only on the pinned, socket-only PostgreSQL archive in chain.test.mjs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import '../../../supabase/functions/_shared/tests/helpers/node-postgres-import.mjs';
import {ownedFixturePool} from '../../../supabase/tests/burimunsi/postgres-fixture-pool.mjs';
import {primeJournalSchema} from './writer-journal-source.mjs';

const migration=name=>readFile(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');
const fixture=name=>readFile(new URL('./fixtures/'+name,import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const group='browser-fixture-group';
const origin='https://burimunsi-admin.ikanisa.com';
const adminId='20000000-0000-4000-8000-000000000001';
const staffId='20000000-0000-4000-8000-000000000002';

async function admitted(owner,kind,work) {
  const control=(await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
  const admission=randomUUID();
  await owner.query('BEGIN');
  try {
    await owner.query("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'; SET LOCAL request.jwt.claims='{}'");
    await owner.query('SELECT private.collect_fence_register($1,$2,$3)',[admission,control.source_sha256,kind]);
    await owner.query("SELECT set_config('collect.fence_admission_id',$1,true),set_config('collect.fence_epoch',$2,true),set_config('collect.fence_source_sha256',$3,true),set_config('burimunsi.collection_id',$4,true)",[admission,String(control.epoch),control.source_sha256,group]);
    const result=await work(owner);
    await owner.query("SELECT private.collect_fence_close($1,$2,$3,'settled','completed',0,0)",[admission,control.epoch,control.source_sha256]);
    await owner.query('COMMIT');
    return result;
  } catch(error) { await owner.query('ROLLBACK');throw error; }
}

async function qualifyBrowserReads(pool,source,originalCookie){
  const {PostgresDatabase}=await import('../../../supabase/functions/_shared/postgres.js');
  const {sqlFenceBackend,openApplicationWork}=await import('../../../supabase/functions/_shared/application-fence.js');
  const {handleAdmin}=await import('../../../supabase/functions/_shared/domain/admin_bridge.js');
  const initial='8237';
  const backend=sqlFenceBackend(pool,pool);
  async function call(path,{cookie,csrf,body}={}) {
    const work=await openApplicationWork({backend,sourceSha256:source,kind:'http_admin'});
    let failed=true;
    try {
      const db=new PostgresDatabase(pool,{},work);
      const headers=new Headers({Origin:origin});
      if(cookie)headers.set('Cookie','__Host-collect_admin='+cookie);
      if(csrf)headers.set('X-Collect-CSRF',csrf);
      if(body){headers.set('Content-Type','application/json');headers.set('X-Collect-Requested-With','collect-admin');}
      const request=new Request(origin+'/api/admin/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
      const res=await handleAdmin(request,{DB:db,BURIMUNSI_COLLECTION_ID:group,BURIMUNSI_PRODUCT_MODE:'standalone',ADMIN_ORIGINS:origin,
        BURIMUNSI_DEFAULT_STAFF_PIN:initial,BURIMUNSI_PIN_PEPPER_ID:'fixture',BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32,29).toString('base64')});
      const parsed=await res.json();
      failed=false;
      return {status:res.status,data:parsed,cookie:res.headers.get('set-cookie')?.match(/^__Host-collect_admin=([a-f0-9]{64});/)?.[1]};
    } finally {assert.equal((await work.finish({failed})).state,'settled');}
  }
  const original=await call('auth/session',{cookie:originalCookie});
  assert.equal(original.status,200);
  assert.equal(Object.hasOwn(original.data.user,'email'),false);
  assert.equal(Object.hasOwn(original.data,'ownerIdentity'),false);
  assert.equal(original.data.ownerEmail,null);
  const originalDirectory=await call('team',{cookie:originalCookie});
  assert.equal(originalDirectory.status,200,JSON.stringify(originalDirectory.data));
  assert.equal(originalDirectory.data.currentAccountId,adminId);
  assert.equal(originalDirectory.data.canManage,true);
  const authorized={cookie:originalCookie,csrf:original.data.csrfToken};
  for(const [role,phone] of [['admin','+250780000058'],['staff','+250780000059']]){
    const made=await call('team/accounts',{...authorized,body:{requestId:randomUUID(),displayName:'Synthetic '+role,phone,role}});
    assert.equal(made.status,200,JSON.stringify(made.data));
    const signed=await call('auth/phone-passcode',{body:{phone,pin:initial}});
    assert.equal(signed.status,200,JSON.stringify(signed.data));
    assert.equal(signed.data.sessionContract,2);
    assert.match(signed.cookie,/^[a-f0-9]{64}$/);
    assert.equal(signed.data.user.accountId,made.data.id);
    const view={cookie:signed.cookie};
    const data=await call('auth/session',view);
    assert.equal(data.data.user.role,role);
    assert.equal(Object.hasOwn(data.data.user,'email'),false);
    assert.equal(data.data.adminIdentity?.role,role==='admin'?'admin':undefined);
    const groups=await call('core/groups?limit=5',view);
    assert.equal(groups.status,200,JSON.stringify(groups.data));
    assert.ok(groups.data.rows.some(row=>row.id===group));
    const payments=await call('core/transactions?limit=5',view);
    assert.equal(payments.status,200,JSON.stringify(payments.data));
    assert.ok(Array.isArray(payments.data.rows));
    const team=await call('team',view);
    assert.equal(team.status,role==='admin'?200:403,JSON.stringify(team.data));
  }
}

export async function verifyPhoneOperatorAccounts({owner,database,fixtureRoot}) {
  const [{actual,local,cluster}] = (await owner.query("SELECT current_database() AS actual,inet_server_addr() IS NULL AS local,current_setting('cluster_name') AS cluster")).rows;
  assert.ok(local && actual===database && /^collect_archive_[0-9a-f]{24}_test$/.test(database) && cluster==='collect_archive_next_fixture');
  await primeJournalSchema(owner);
  // The archive omits scheduler installation. Restore its real row type and
  // captured unaltered reconciliation body without enabling jobs or dispatch.
  const scheduler=await migration('20261117073850_collect_managed_jobs_hmac.sql');
  const shape=scheduler.match(/CREATE FUNCTION collect_ops\.native_jobs_epoch\(\)[\s\S]*?CREATE TABLE collect_ops\.jobs_dispatches\([\s\S]*?\n\);/);
  const parserPreimage=await readFile(new URL('./native-parser-review-preimage.sql',import.meta.url),'utf8');
  const reconcile=parserPreimage.match(/CREATE OR REPLACE FUNCTION collect_ops\.reconcile_jobs\(\)[\s\S]*?END\$function\$\s*;/);
  assert.ok(shape && reconcile);
  await owner.query('CREATE SCHEMA IF NOT EXISTS collect_ops');
  await owner.query(shape[0]);
  await owner.query(reconcile[0]);
  await owner.query(await migration('20261119114600_burimunsi_admin_sms_health.sql'));
  for (const name of [
    '20261122125000_burimunsi_browser_passcode.sql',
    '20261122140000_burimunsi_batch_payment_projections.sql',
    '20261122180000_burimunsi_internal_query_performance.sql',
  ]) await owner.query(await migration(name));
  const performanceFunctions=[
    'private.burimunsi_auto_projection_batch(text,text[])','private.burimunsi_home_payment_times(text,text[])',
    'private.burimunsi_admin_transaction_facts(text)','private._collect_fence_resources()',
    'private.burimunsi_native_sms_post_candidates(integer)','private.burimunsi_operator_directory(text,text,text,text,text,uuid)',
    'collect_ops.reconcile_jobs()',
  ];
  const performanceDefinitions=async()=>(await owner.query(
    'SELECT routine,md5(pg_get_functiondef(routine::regprocedure)) AS fingerprint FROM unnest($1::text[]) AS routine ORDER BY routine',[performanceFunctions])).rows;
  const beforePerformance=await performanceDefinitions();
  const historical=await fixture('burimunsi-browser-passcode.sql');
  const seed=historical.split('\nDO $exercise$\n');
  assert.equal(seed.length,2);
  await owner.query(seed[0]+'\nCOMMIT;');
  const receiverState=async()=>{
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
      return (await owner.query('SELECT collection_id,receiving_account_id,enabled,active_binding_id,binding_version,version FROM private.burimunsi_scopes ORDER BY collection_id')).rows;
    } finally { await owner.query('ROLLBACK'); }
  };
  const originalReceiver=await receiverState();
  assert.equal(originalReceiver.length,1);
  assert.equal(originalReceiver[0].enabled,false);
  assert.equal(originalReceiver[0].active_binding_id,null);
  const originalCookie=hash(randomUUID()),cookieHash=hash(originalCookie),installation=randomUUID(),device='6'.repeat(64),token='7'.repeat(64),nativeSid=randomUUID();
  const saved=await admitted(owner,'http_admin',async db=>{
    const sid=randomUUID(),pub=randomUUID();
    assert.equal((await db.query('SELECT private.burimunsi_browser_pin_issue($1,$2,1,1,$3,$4,$5,$6) AS ok',[group,adminId,cookieHash,sid,pub,origin])).rows[0].ok,true);
    return (await db.query('SELECT private.burimunsi_browser_pin_session($1,$2,$3) AS p',[group,cookieHash,origin])).rows[0].p;
  });
  await admitted(owner,'http_collect',async db=>{
    const now=Date.now();
    const issued=(await db.query("SELECT private.burimunsi_pin_create_session($1,$2,$3,'staff',$4,2,$5,$6,$7,$8,2) AS p",
      [group,staffId,installation,hash(device),nativeSid,hash(token),now,now+1800000])).rows[0].p;
    assert.equal(issued.created,true);
  });
  const state=(await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
  const hold=randomUUID(),args=[hold,state.epoch,state.source_sha256];
  await owner.query('SELECT private.collect_fence_begin_quiesce($1,$2,$3)',args);
  await owner.query('SELECT private.collect_fence_drain($1,$2,$3)',args);
  await owner.query(await migration('20261122190000_burimunsi_phone_operator_accounts.sql'));
  await owner.query('SELECT private.collect_fence_release_v3($1,$2,$3)',[randomUUID(),state.epoch,state.source_sha256]);
  await admitted(owner,'http_collect',async db=>{
    const current=(await db.query('SELECT * FROM private.burimunsi_pin_session_context($1,$2,$3,$4)',[token,installation,device,'staff'])).rows;
    assert.equal(current.length,1);
    assert.equal(current[0].native_session_id,nativeSid);
    assert.equal(current[0].account_id,staffId);
  });
  await admitted(owner,'http_admin',async db=>{
    const current=(await db.query('SELECT private.burimunsi_browser_pin_session($1,$2,$3) AS p',[group,cookieHash,origin])).rows[0].p;
    for(const key of ['sessionId','publicId','principalId','accountId','credentialVersion','accountVersion','proofId','expiresAt'])
      assert.equal(current[key],saved[key],key);
    assert.equal(current.operatorRole,'admin');
    assert.equal(current.storageRole,'owner');
  });
  await owner.query('BEGIN');
  try { await owner.query(await fixture('burimunsi-phone-team.sql')); } finally { await owner.query('ROLLBACK'); }
  const {host:socket,port}=owner.connectionParameters;
  const pool=await ownedFixturePool({root:fixtureRoot,socket,port:Number(port),database,user:'postgres',clusterName:cluster});
  try { await qualifyBrowserReads(pool,state.source_sha256,originalCookie); } finally { await pool.end(); }
  assert.deepEqual(await receiverState(),originalReceiver);
  assert.deepEqual(await performanceDefinitions(),beforePerformance);
  return {existingBrowserSession:true,existingNativeSession:true,phoneAccountLifecycle:true,adminAndStaffGroupsAndPayments:true,unchangedDisabledReceiver:true,epoch64PerformanceRoutinesPreserved:true};
}
