// This fixture runs only on the pinned, socket-only PostgreSQL archive in chain.test.mjs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import '../../../supabase/functions/_shared/tests/helpers/node-postgres-import.mjs';
import {ownedFixturePool} from '../../../supabase/tests/burimunsi/postgres-fixture-pool.mjs';
import {primeJournalSchema} from './writer-journal-source.mjs';
import {verifyBrowserMemberEnrollment} from './phone-member-enrollment.fixture.mjs';
import {verifyBrowserMemberOnboarding} from './phone-member-onboarding.fixture.mjs';
import {canonicalProfile,MANAGED_SUPABASE_ORIGIN} from '../../../supabase/functions/_shared/deployment-profile.js';

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

async function installSmsHealthSchedulerFixture(owner) {
  // Use the real disabled scheduler with the repository's local provider doubles.
  await owner.query(await readFile(new URL('../../../supabase/jobs/test-fixture.sql',import.meta.url),'utf8'));
  await owner.query(`
    ALTER TABLE cron.job_run_details ADD COLUMN status text, ADD COLUMN start_time timestamptz;
    CREATE SCHEMA collect_ops;
    CREATE FUNCTION collect_ops.cleanup_google_expired() RETURNS void LANGUAGE plpgsql AS $$BEGIN
 -- collect_fence_sql2_write_guard_v1
 PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);
 RAISE EXCEPTION 'scheduler_fixture_read_only'; END$$;
    REVOKE ALL ON FUNCTION collect_ops.cleanup_google_expired() FROM PUBLIC;
  `);
  const [{cleanup,manifest}]=(await owner.query(`SELECT
    encode(sha256(convert_to(pg_get_functiondef('collect_ops.cleanup_google_expired()'::regprocedure),'UTF8')),'hex') AS cleanup,
    (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
      WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure) AS manifest`)).rows;
  const base=await migration('20261117073850_collect_managed_jobs_hmac.sql');
  await owner.query(base.replace('f70925051147096cfb72869b401fdb69c976b68034c87e8c3e98ee8b5f350ed0',cleanup)
    .replace('09ecc11aca46af15d7f981b5d5c7c7d3775be6fc245c8ff73f48f61269e37671',manifest));
  await owner.query(await migration('20261117135049_collect_sms_schedule_one_minute.sql'));
}

async function qualifyBrowserReads(pool,source,originalCookie,enrollmentFixture,installSmsScopeRepair,phoneOnboarding){
  const {PostgresDatabase}=await import('../../../supabase/functions/_shared/postgres.js');
  const {sqlFenceBackend,openApplicationWork}=await import('../../../supabase/functions/_shared/application-fence.js');
  const {handleAdmin}=await import('../../../supabase/functions/_shared/domain/admin_bridge.js');
  const initial='8237';
  const backend=sqlFenceBackend(pool,pool);
  const profile=canonicalProfile({format:'collect.deployment.v1',id:'collect-managed-production-cloud',mode:'managed',environment:'production',
    supabase_origin:MANAGED_SUPABASE_ORIGIN,member_api_origin:MANAGED_SUPABASE_ORIGIN,admin_origin:MANAGED_SUPABASE_ORIGIN,
    public_origin:MANAGED_SUPABASE_ORIGIN,google_callback_origin:MANAGED_SUPABASE_ORIGIN});
  let previewBindings={};
  async function withPreviewBindings(bindings,run) {
    assert.equal(phoneOnboarding,true);
    previewBindings=bindings;
    try{return await run();}finally{previewBindings={};}
  }
  async function call(path,{cookie,csrf,body,key}={}) {
    const work=await openApplicationWork({backend,sourceSha256:source,kind:'http_admin'});
    let failed=true;
    try {
      const db=new PostgresDatabase(pool,{},work);
      const errors=[];
      if (installSmsScopeRepair && path.startsWith('oversight/')) {
        const execute = db.statement.bind(db);
        db.statement=async (...args)=>{
          try { return await execute(...args); }
          catch (error) { errors.push({code:error.code,message:error.message,where:error.where});throw error; }
        };
      }
      const headers=new Headers({Origin:origin});
      if(cookie)headers.set('Cookie','__Host-collect_admin='+cookie);
      if(csrf)headers.set('X-Collect-CSRF',csrf);
      if(key)headers.set('Idempotency-Key',key);
      if(body){headers.set('Content-Type','application/json');headers.set('X-Collect-Requested-With','collect-admin');}
      const request=new Request(origin+'/api/admin/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
      const res=await handleAdmin(request,{DB:db,COLLECT_FENCE_WORK:work,BUILD_SOURCE_ID:source,APP_ENVIRONMENT:'production',
        ADMIN_ORIGIN:MANAGED_SUPABASE_ORIGIN,SUPABASE_URL:MANAGED_SUPABASE_ORIGIN,COLLECT_DEPLOYMENT_PROFILE:profile,COLLECT_DEPLOYMENT_PROFILE_SHA256:hash(profile),
        BURIMUNSI_COLLECTION_ID:group,BURIMUNSI_PRODUCT_MODE:'standalone',ADMIN_ORIGINS:origin,...previewBindings,
        BURIMUNSI_DEFAULT_STAFF_PIN:initial,BURIMUNSI_PIN_PEPPER_ID:'fixture',BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32,29).toString('base64')});
      const parsed=await res.json();
      failed=false;
      return {status:res.status,data:parsed,errors,cookie:res.headers.get('set-cookie')?.match(/^__Host-collect_admin=([a-f0-9]{64});/)?.[1]};
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
  const viewers={};
  for(const [role,phone] of [['admin','+250780000058'],['staff','+250780000059']]){
    const made=await call('team/accounts',{...authorized,body:{requestId:randomUUID(),displayName:'Synthetic '+role,phone,role}});
    assert.equal(made.status,200,JSON.stringify(made.data));
    const signed=await call('auth/phone-passcode',{body:{phone,pin:initial}});
    assert.equal(signed.status,200,JSON.stringify(signed.data));
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
    if(!phoneOnboarding){
      const payments=await call('core/transactions?limit=5',view);
      assert.equal(payments.status,200,JSON.stringify(payments.data));
      assert.ok(Array.isArray(payments.data.rows));
    }
    const team=await call('team',view);
    assert.equal(team.status,role==='admin'?200:403,JSON.stringify(team.data));
    viewers[role]={...view,csrf:data.data.csrfToken,principalId:data.data.user.principalId};
  }
  const sessions={call,group,admin:viewers.admin,otherAdmin:authorized,staff:viewers.staff,
    inspect:enrollmentFixture.inspect,
    withoutGrant:(permission,verify)=>enrollmentFixture.withoutGrant(viewers.admin.principalId,permission,verify),
    relogin:async()=>{
      const fresh=await call('auth/phone-passcode',{body:{phone:'+250780000058',pin:initial}});
      assert.equal(fresh.status,200);
      const session=await call('auth/session',{cookie:fresh.cookie});
      return {cookie:fresh.cookie,csrf:session.data.csrfToken};
    }};
  if(phoneOnboarding)return verifyBrowserMemberOnboarding({...sessions,source,withPreviewBindings,inspectPreview:enrollmentFixture.inspectPreview});
  await verifyBrowserMemberEnrollment(sessions);
  if(!installSmsScopeRepair)return;
  const routes=['oversight/sms-health','oversight/health?evidenceVersion=2'];
  const restored={cookie:originalCookie};
  const primaryBefore={};
  for(const path of routes){
    const primary=await call(path,restored);
    assert.equal(primary.status,200,JSON.stringify({path,data:primary.data,errors:primary.errors}));
    primaryBefore[path]=primary.data.queues;
    const before=await call(path,viewers.admin);
    assert.equal(before.status,503,JSON.stringify({path,data:before.data,errors:before.errors}));
    assert.equal(before.data.error.code,'oversight_unavailable');
    assert.deepEqual(before.errors.map(({code,message})=>({code,message})),[{code:'42501',message:'group_access_denied'}]);
    assert.equal((await call(path,viewers.staff)).status,403);
    assert.equal((await call(path)).status,401);
  }
  await installSmsScopeRepair();
  for(const path of routes){
    const after=await call(path,viewers.admin);
    assert.equal(after.status,200,JSON.stringify({path,data:after.data,errors:after.errors}));
    assert.equal(after.data.contract_version,1);
    assert.deepEqual(after.data.queues,primaryBefore[path]);
    assert.ok(Object.hasOwn(after.data.queues,'burimunsi_sms'));
    assert.ok(Object.hasOwn(after.data.queues,'burimunsi_payer_sms'));
    const primary=await call(path,restored);
    assert.equal(primary.status,200,JSON.stringify({path,data:primary.data,errors:primary.errors}));
    assert.deepEqual(primary.data.queues,primaryBefore[path]);
    assert.equal((await call(path,viewers.staff)).status,403);
    assert.equal((await call(path)).status,401);
  }
  return {narrowAndFull:{primaryAdmin:[200,200],peerAdmin:[503,200],staff:[403,403],guest:[401,401]},sameCookies:true,sqlstateBefore:'42501',queueParity:true};
}

export async function verifyPhoneOperatorAccounts({owner,database,fixtureRoot,phoneSmsHealth=false,phoneOnboarding=false}) {
  const [{actual,local,cluster}] = (await owner.query("SELECT current_database() AS actual,inet_server_addr() IS NULL AS local,current_setting('cluster_name') AS cluster")).rows;
  assert.ok(local && actual===database && /^collect_archive_[0-9a-f]{24}_test$/.test(database) && cluster==='collect_archive_next_fixture');
  await primeJournalSchema(owner);
  await owner.query(await migration('20261119114600_burimunsi_admin_sms_health.sql'));
  await owner.query(await migration('20261122125000_burimunsi_browser_passcode.sql'));
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
  if(phoneOnboarding)await owner.query(await migration('20261119041000_burimunsi_ocr_disclosure_binding.sql'));
  if(phoneSmsHealth){
    // The topic fixture supplies its own scheduler predecessor. Install the
    // same financial projection and its production ACLs from the source migration.
    const performance=await migration('20261122180000_burimunsi_internal_query_performance.sql');
    const projection=performance.match(/CREATE FUNCTION private\.burimunsi_admin_transaction_facts\(p_transaction text\)[\s\S]+?GRANT EXECUTE ON FUNCTION private\.burimunsi_admin_transaction_facts\(text\) TO collect_runtime;/g);
    assert.equal(projection?.length,1);
    await owner.query(projection[0]);
    await installSmsHealthSchedulerFixture(owner);
    for(const name of ['20261117180000_burimunsi_observation_reconcile_status.sql','20261117190000_burimunsi_legacy_reconcile.sql',
      '20261122191000_burimunsi_sms_completeness.sql','20261122191100_burimunsi_payment_sms_obligations.sql',
      '20261122191200_burimunsi_known_device_login_budget.sql','20261122191300_burimunsi_event_driven_jobs.sql',
      '20261122200000_burimunsi_admin_handset_intake.sql','20261122201000_burimunsi_admin_inbox_coverage.sql',
      '20261122202000_burimunsi_current_admin_inbox_authority.sql','20261124080000_burimunsi_read_admission.sql'])await owner.query(await migration(name));
  }
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
  async function installSmsScopeRepair() {
    const current=(await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
    const args=[randomUUID(),current.epoch,current.source_sha256];
    await owner.query('SELECT private.collect_fence_begin_quiesce($1,$2,$3)',args);
    await owner.query('SELECT private.collect_fence_drain($1,$2,$3)',args);
    await owner.query(await migration('20261122203000_burimunsi_phone_admin_sms_read_scope.sql'));
    await owner.query('SELECT private.collect_fence_release_v3($1,$2,$3)',[randomUUID(),current.epoch,current.source_sha256]);
  }
  async function inspectEnrollment() {
    await owner.query('BEGIN READ ONLY');
    try {
      await owner.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
      return (await owner.query(`SELECT
        (SELECT count(*)::int FROM app.memberships WHERE collection_id=$1) AS members,
        (SELECT count(*)::int FROM private.burimunsi_rematch_jobs WHERE collection_id=$1) AS rematches,
        (SELECT count(*)::int FROM private.burimunsi_command_receipts WHERE collection_id=$1 AND operation='burimunsi.browser_member_enrollment') AS receipts,
        (SELECT count(*)::int FROM private.burimunsi_audit WHERE collection_id=$1 AND action='burimunsi.members_import.attested') AS attestations,
        (SELECT count(*)::int FROM app.ledger_entries WHERE collection_id=$1) AS financial`,[group])).rows[0];
    } finally { await owner.query('ROLLBACK'); }
  }
  async function withoutGrant(principal,permission,verify) {
    assert.ok(['users.manage','collections.manage'].includes(permission));
    const removed=await owner.query('DELETE FROM app.admin_grants WHERE user_id=$1 AND permission=$2 RETURNING *',[principal,permission]);
    assert.equal(removed.rowCount,1);
    try { await verify(); }
    finally {
      await owner.query('INSERT INTO app.admin_grants SELECT (jsonb_populate_record(NULL::app.admin_grants,$1::jsonb)).*',[JSON.stringify(removed.rows[0])]);
    }
  }
  async function inspectPreview(sourceHash) {
    await owner.query('BEGIN READ ONLY');
    try{
      await owner.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
      const {rows}=await owner.query(`SELECT response->>'state' AS state,response->>'ocrDisclosureVersion' AS disclosure,
        ((response->>'ciphertext')::jsonb->>'kid') AS kid,position('momoName' IN response::text)=0 AS encrypted
        FROM private.burimunsi_command_receipts WHERE collection_id=$1 AND operation='burimunsi.smart_import.v1'
        AND response->>'sourceSha256'=$2`,[group,sourceHash]);
      return rows;
    }finally{await owner.query('ROLLBACK');}
  }
  let smsHealth;
  try { smsHealth=await qualifyBrowserReads(pool,state.source_sha256,originalCookie,{inspect:inspectEnrollment,withoutGrant,inspectPreview},phoneSmsHealth?installSmsScopeRepair:undefined,phoneOnboarding); } finally { await pool.end(); }
  if(phoneSmsHealth){
    await owner.query(await fixture('burimunsi-phone-sms-read-scope.sql'));
    await owner.query(await fixture('burimunsi-screen-read-capacity.sql'));
  }
  assert.deepEqual(await receiverState(),originalReceiver);
  if(phoneOnboarding)return {phoneOnboarding:smsHealth,unchangedDisabledReceiver:true};
  return {existingBrowserSession:true,existingNativeSession:true,phoneAccountLifecycle:true,browserEnrollment:true,adminAndStaffGroupsAndPayments:true,unchangedDisabledReceiver:true,...(smsHealth?{smsHealth}:{})};
}
