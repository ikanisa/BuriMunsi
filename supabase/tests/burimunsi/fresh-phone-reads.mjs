// Runs on the socket-only managed archive fixture after its protected synthetic
// team is enrolled. These calls use the production HTTP gate and PostgreSQL stores.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {openApplicationWork, sqlFenceBackend} from '../../functions/_shared/application-fence.js';
import {prepareDeploymentCheck} from '../../functions/_shared/deployment-database.js';
import {CONTRACT_VERSION} from '../../functions/_shared/domain/burimunsi/wire/native-contract.mjs';
import {createPhonePinRequestGate, phonePinReadSelector, PIN_RENEW_SQL, PIN_SET_CONTEXT_SQL} from '../../functions/_shared/domain/burimunsi/phone-pin-request.js';
import {PostgresDatabase} from '../../functions/_shared/postgres.js';
import {storageApplicationPool} from '../../functions/_shared/storage/application-pool.js';
import {lockCollectMutation} from '../../functions/_shared/postgres-mutation-lock.js';
import {drainNativeAutoTransactions} from '../../functions/_shared/domain/burimunsi/postgres-native-auto-worker.js';
import {drainNativeSmsLedger} from '../../functions/_shared/domain/burimunsi/postgres-native-sms-ledger.js';
import {PostgresNativeAuthStore} from '../../functions/_shared/domain/burimunsi/postgres-auth-store.js';
import {PostgresPhonePinSessions} from '../../functions/_shared/domain/burimunsi/postgres-phone-pin-sessions.js';
import {PostgresOperatorDirectory} from '../../functions/_shared/domain/burimunsi/postgres-operator-directory.js';
import {PostgresRecordsStore} from '../../functions/_shared/domain/burimunsi/postgres-records-store.js';
import {RecordsService} from '../../functions/_shared/domain/burimunsi/records-service.js';
import {handleAdmin} from '../../functions/_shared/domain/admin_bridge.js';
import {createNativeHandler} from '../../functions/_shared/domain/burimunsi/http.js';
import {verifyBrowserHomeBootstrap} from './fresh-browser-home.mjs';

const group = 'browser-fixture-group';
const origin = 'https://synthetic.invalid';
const home = '/session?include=home';
const payments = '/payments?filter=all&sort=newest&limit=100';
const accounts = [
  {role:'staff', profile:'staff', id:'20000000-0000-4000-8000-000000000002', version:2},
  {role:'admin', profile:'internal_receiver', id:'20000000-0000-4000-8000-000000000001', version:1},
];
const token = () => randomBytes(32).toString('hex');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const unused = () => { throw Error('Unexpected write or external operation'); };

export async function qualifyNativeReads({pool, competingPool, admissionPool, businessStatements, inspect, source}) {
  const [deployment] = await inspect('SELECT profile_raw, profile_sha256 FROM private.collect_deployment_identity WHERE singleton', []);
  const check = await prepareDeploymentCheck({COLLECT_DEPLOYMENT_PROFILE:deployment.profile_raw,
    COLLECT_DEPLOYMENT_PROFILE_SHA256:deployment.profile_sha256}, group);
  const regular = sqlFenceBackend(admissionPool, admissionPool, check);
  const nativeRead = sqlFenceBackend(admissionPool, admissionPool, check, new AbortController().signal, true);
  async function admitted(fn, kind = 'http_collect', backend = regular, businessPool = pool) {
    const admission = await openApplicationWork({backend, sourceSha256:source, kind});
    let failed = true;
    try {
      const result = await fn(new PostgresDatabase(businessPool, {}, admission));
      failed = false;
      return result;
    } finally {
      assert.equal((await admission.finish({failed})).state, 'settled');
    }
  }

  // Both scheduler lanes used to wait on this mutex for five seconds each
  // before discovering an empty queue. Keep the writer alive through both calls.
  const writer = await admissionPool.reserve();
  try {
    await writer.unsafe('BEGIN');
    await lockCollectMutation(writer);
    await admitted(async db => {
      const env = {DB:db, BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'true', MOMO_AI_ENABLED:'true',
        MOMO_AI_MODEL:'fixture-model', OPENAI_API_KEY:'fixture', AI:{run:unused}};
      const expected = {status:'complete',processed:0,results:[]};
      assert.deepEqual(await drainNativeAutoTransactions(env,{limit:1}),expected);
      assert.deepEqual(await drainNativeSmsLedger(env,{limit:4}),expected);
    },'jobs');
    await admitted(db=>assert.rejects(db.transaction(async tx=>{
      await db.context(tx);
      await tx.unsafe("SELECT private.burimunsi_native_job_candidates('post',4)");
    }),{code:'42501'}));
  } finally {
    await writer.unsafe('ROLLBACK');writer.release();
  }
  console.log('PASS pinned jobs alone discover empty queues under a concurrent writer without provider or financial work');

  async function issue(account, ttl) {
    const actor = {...account, session:randomUUID(), installation:randomUUID(), device:token(), bearer:token()};
    await admitted(db => db.transaction(async sql => {
      await db.context(sql);
      const now = Date.now();
      const rows = await sql.unsafe(`SELECT private.burimunsi_pin_create_session(
        $1,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,$9,$10,$6) AS result`,
      [group, actor.id, actor.installation, actor.profile, hash(actor.device), actor.version,
        actor.session, hash(actor.bearer), now, now+ttl]);
      assert.equal(rows[0].result.created, true);
    }));
    return actor;
  }

  async function read(actor, path, device = actor.device, {requestedGroup=group,clock=Date.now,status=200,businessPool=pool}={}) {
    return admitted(async db => {
      const sessions = new PostgresPhonePinSessions({db, groupId:group});
      const directory = new PostgresOperatorDirectory({db, groupId:group, managedSessions:sessions});
      const authority = new PostgresNativeAuthStore({db, groupId:group, sessionBinding:sessions,
        operatorDirectory:directory, createOperatorPrincipal:unused,clock});
      const store = new PostgresRecordsStore({authority, nativeAutoRecordsEnabled:true,
        sourceReader:{revision:unused, page:unused, detail:unused}});
      const records = new RecordsService({store, groupId:group, cursor:{create:unused, read:unused}});
      const handler = createNativeHandler({origin, groupId:group, strictContract:true, records,
        auth:{login:unused, authenticate:unused, logout:unused, changePasscode:unused, manageStaff:unused},
        members:{enroll:unused, setActive:unused}, contributions:{allocate:unused},
        gateway:{status:unused, replace:unused}, networkBucket:unused,
        readRecordActor:request => phonePinReadSelector(db, request)});
      const request = new Request(origin+'/v1/burimunsi'+path, {headers:{
        'X-BuriMunsi-Contract':CONTRACT_VERSION, 'X-BuriMunsi-Request':randomUUID(),
        'X-BuriMunsi-Generation':'1', 'X-BuriMunsi-Auth':'phone_pin',
        'X-BuriMunsi-Installation':actor.installation, 'X-BuriMunsi-Profile':actor.profile,
        'X-BuriMunsi-Device':device, 'X-BuriMunsi-Group':requestedGroup, Authorization:'Bearer '+actor.bearer,
      }});
      const gate = createPhonePinRequestGate({origin, secrets:{}, networkBucket:unused});
      const response = await gate({request, env:{DB:db, BURIMUNSI_PRODUCT_MODE:'standalone'}},
        (_principal, _env, boundRequest) => handler(boundRequest ?? request));
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      return body.data;
    }, 'http_collect', nativeRead, businessPool);
  }

  async function lease(actor) {
    const rows = await inspect(`SELECT expires_at AS initial, pin_lease_expires_at AS renewed,
      floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now
      FROM private.burimunsi_sessions WHERE id=$1`, [actor.session]);
    assert.equal(rows.length, 1);
    return {initial:Number(rows[0].initial), renewed:rows[0].renewed===null ? null : Number(rows[0].renewed), now:Number(rows[0].now)};
  }

  async function assertHome(actor, businessPool = pool) {
    const data = await read(actor, home, actor.device, {businessPool});
    assert.equal(data.profile.role, actor.role);
    assert.equal(data.home.groupBalanceRwf, 0);
    assert.ok(data.expiresAt > Date.now());
    return data.expiresAt;
  }

  async function assertPayments(actor) {
    const page = await read(actor, payments);
    assert.deepEqual(page.items, []);
    assert.equal(page.totalCount, 0);
  }


  async function verifyAdminIncoming() {
    const adminOrigin = 'https://burimunsi-admin.ikanisa.com';
    const cookie = token();
    await admitted(db => db.transaction(async sql => {
      await db.context(sql);
      await sql.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)", [group]);
      const result = await sql.unsafe('SELECT private.burimunsi_browser_pin_issue($1,$2,1,1,$3,$4,$5,$6) AS ok',
        [group, accounts[1].id, hash(cookie), randomUUID(), randomUUID(), adminOrigin]);
      assert.equal(result[0].ok, true);
    }), 'http_admin');
    await admitted(async db => {
      const request = new Request(adminOrigin+'/api/admin/sms/receipts?limit=2&offset=2', {headers:{
        Origin:adminOrigin, Cookie:'__Host-collect_admin='+cookie,
      }});
      const response = await handleAdmin(request, {DB:db, BURIMUNSI_COLLECTION_ID:group,
        BURIMUNSI_PRODUCT_MODE:'standalone', ADMIN_ORIGINS:adminOrigin,
        BURIMUNSI_DEFAULT_STAFF_PIN:'8237', BURIMUNSI_PIN_PEPPER_ID:'fixture',
        BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32,29).toString('base64')});
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.rows, []);
      assert.equal(body.total, 0);
      assert.equal(body.next_offset, null);
    }, 'http_admin');
    console.log('PASS scoped Incoming SMS list and total on real PostgreSQL through the authenticated Admin phone-session handler');
  }

  await admitted(db => assert.rejects(db.transaction(async sql => {
    await sql.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE');
    await db.context(sql);
  }), {code:'application_fence_unavailable'}));
  console.log('PASS original PostgreSQL write fence rejects the former repeatable-read write transaction');
  await admitted(async db => {
    const marker = randomUUID();
    const failedRead = new Error('synthetic consumer rejection');
    let firstPid;
    await assert.rejects(db.withNativeReadSnapshot(async sql => {
      const [context] = await sql.unsafe(`SELECT current_user AS role, current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation, current_setting('lock_timeout') AS lock_limit,
        current_setting('statement_timeout') AS statement_limit,current_setting('search_path') AS path,
        current_setting('request.jwt.claims') AS claims,current_setting('collect.edge_verified') AS verified,
        pg_backend_pid() AS pid`);
      const {pid,...scope}=context;firstPid=pid;
      assert.ok(Number.isInteger(pid));
      assert.deepEqual(scope,{role:'collect_runtime',read_only:'on',isolation:'repeatable read',lock_limit:'5s',
        statement_limit:'15s',path:'app,public,pg_catalog',claims:'{}',verified:'true'});
      assert.equal(await db.withNativeReadSnapshot(inner=>inner===sql),true);
      assert.throws(()=>db.transaction(()=>{}),/read_snapshot_cannot_write/);
      await sql.unsafe("SELECT set_config('burimunsi.fixture_read_rollback',$1,true)",[marker]);
      throw failedRead;
    }),error=>error===failedRead);
    await db.withNativeReadSnapshot(async sql => {
      const [context] = await sql.unsafe("SELECT pg_backend_pid() AS pid,current_setting('burimunsi.fixture_read_rollback',true) AS prior");
      assert.equal(context.pid,firstPid,'one runtime connection must be demonstrably reused');
      assert.notEqual(context.prior,marker);
    });
  });
  console.log('PASS read-only context, nested snapshot, write refusal and rollback on the same postgres.js connection');

  const scopeSettings = `SELECT current_user AS role, current_setting('statement_timeout') AS statement_limit,
    current_setting('lock_timeout') AS lock_limit, current_setting('search_path') AS path,
    current_setting('request.jwt.claims',true) AS claims, current_setting('collect.edge_verified',true) AS verified`;
  for (const wrongMode of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE','BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY']) {
    await admitted(async db => {
      let before,atRollback;
      const wrongModePool = {async reserve() {
        const connection = await pool.reserve();
        const tx = (...args) => connection(...args);
        tx.unsafe = async (text,...values) => {
          if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
            const result = await connection.unsafe(wrongMode);
            [before] = await connection.unsafe(scopeSettings);
            return result;
          }
          if (text === 'ROLLBACK') [atRollback] = await connection.unsafe(scopeSettings);
          return connection.unsafe(text,...values);
        };
        tx.release = () => connection.release();
        return tx;
      }};
      for(const claims of [{},{sub:'wrong_mode_fixture'}]) {
        const restricted = new PostgresDatabase(wrongModePool,claims,db.applicationWork);
        await assert.rejects(restricted.withNativeReadSnapshot(() => assert.fail('wrong-mode read was dispatched')),
          {code:'application_fence_unavailable'});
        assert.ok(before && atRollback);
        assert.deepEqual({...atRollback},{...before},'a rejected mode must install no role, claims or local settings');
      }
    });
  }
  console.log('PASS wrong native isolation and writable mode install no scope before rollback');
  for (const account of accounts) {
    for (const [state, ttl] of [['current',1800000], ['due',45000], ['expired',2500]]) {
      const actor = await issue(account, ttl);
      if(state==='current'){
        for(const path of [home,payments]){
          let start=businessStatements.length;
          await read(actor,path);
          const statements=businessStatements.slice(start);
          assert.equal(statements.length,5);
          assert.match(statements[0],/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/);
          assert.match(statements[1],/set_config\('request.jwt.claims','\{\}',true\)/);
          assert.match(statements[2],/^WITH bound AS MATERIALIZED/);
          assert.match(statements[3],/app\.momo_transactions/);
          assert.equal(statements[4],'COMMIT');
          start=businessStatements.length;
          await assert.rejects(read(actor,path,actor.device,{requestedGroup:'another-group'}),{code:'native_scope_changed'});
          await read(actor,path,actor.device,{clock:()=>Date.now()+7200000,status:401});
          assert.ok(!businessStatements.slice(start).includes(statements[3]),'no ledger query after wrong scope or expired actor');
        }
        console.log('PASS five business statements per fresh '+account.role+' screen; wrong collection and consumption-time expiry deny ledger access');
      }
      const before = await lease(actor);
      assert.equal(before.renewed, null);
      if (state === 'expired') {
        await delay(Math.max(0, before.initial-before.now+50));
        assert.ok((await lease(actor)).now >= before.initial);
        await assert.rejects(read(actor, payments), {code:'session_unavailable'});
      } else {
        await assertPayments(actor);
      }
      for (const path of [home,payments]) {
        await assert.rejects(read(actor, path, token()), {code:'session_unavailable'});
      }
      assert.equal((await lease(actor)).renewed, null);
      const expires = await assertHome(actor);
      const after = await lease(actor);
      assert.equal(after.initial, before.initial);
      if (state === 'current') {
        assert.equal(after.renewed, null);
        assert.equal(expires, before.initial);
      } else {
        assert.ok(after.renewed > before.initial);
        assert.equal(expires, after.renewed);
      }
      await assertPayments(actor);
      assert.equal((await lease(actor)).renewed, after.renewed);
      if(state==='current'){
        await admitted(db=>db.transaction(async sql=>{
          await db.context(sql);await lockCollectMutation(sql);
          const [logout]=await sql.unsafe('SELECT private.burimunsi_pin_logout_barrier($1,$2::uuid,$3,$4,$5,$6) AS result',
            [actor.bearer,actor.installation,actor.device,actor.profile,group,null]);
          assert.equal(logout.result.accountId,actor.id);
        }));
        const start=businessStatements.length;
        for(const path of [home,payments])await assert.rejects(read(actor,path),{code:'session_unavailable'});
        assert.ok(!businessStatements.slice(start).some(text=>text.includes('app.momo_transactions')));
        console.log('PASS real logout revokes '+account.role+' Home and Payments before financial data is read');
      }
      console.log('PASS', account.role, account.profile, state, 'Home and Payments; wrong-device denied; original lease and renewal verified');
    }
  }
  await verifyAdminIncoming();

  // Hold the same shared transaction used for encrypted object metadata. A
  // session that genuinely needs renewal must render before the reader releases it.
  for (const account of accounts) {
    const due = await issue(account,45000), expired = await issue(account,1500);
    let disabledConsent;
    if (account.role==='admin') {
      disabledConsent=await admitted(db=>db.transaction(async tx=>{
        await db.context(tx);
        await tx.unsafe(PIN_SET_CONTEXT_SQL,[due.bearer,due.installation,due.device,due.profile]);
        const [{result:consent}]=await tx.unsafe('SELECT private.burimunsi_observation_consent_current() AS result');
        const [{result}]=await tx.unsafe('SELECT private.burimunsi_observation_set_consent(false,$1) AS result',[consent.generation+1]);
        assert.equal(result.enabled,false);
        return result;
      }));
    }
    await delay(1600);
    await admitted(async db => {
      const journal = await storageApplicationPool(db).connectJournal();
      try {
        await journal.query('BEGIN');
        await journal.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7346369))',['synthetic-receipt-key']);
        for (const [state, actor] of [['due',due],['expired',expired]]) {
          if (state==='expired') await assert.rejects(read(actor,payments),{code:'session_unavailable'});
          const start=performance.now(), expiry=await assertHome(actor);
          const elapsedMs=Math.round(performance.now()-start);
          assert.equal((await lease(actor)).renewed,expiry);
          await assertPayments(actor);
          console.log('PASS receipt journal held during '+account.role+' '+state+' Home renewal',elapsedMs,'ms');
        }
      } finally {
        await journal.query('ROLLBACK');
        journal.release();
      }
    },'http_collect',regular,competingPool);
    if(disabledConsent){
      const [{enabled,generation}]=await inspect('SELECT enabled,generation::int FROM private.burimunsi_observation_consents WHERE collection_id=$1 AND account_id=$2 AND installation_id=$3',[group,due.id,due.installation]);
      assert.deepEqual({enabled,generation},disabledConsent);
    }
  }

  async function waitForLock(blockerPid,mode) {
    const deadline=performance.now()+4000;
    while(performance.now()<deadline) {
      const [{waiting}]=await inspect("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode=$2 AND $1::int=ANY(pg_blocking_pids(pid))) AS waiting",[blockerPid,mode]);
      if(waiting) return;
      await delay(15);
    }
    assert.fail('expected a '+mode+' waiter on the held transaction');
  }

  const sameDevice=await issue(accounts[0],45000);
  const renewArgs=[sameDevice.bearer,sameDevice.installation,sameDevice.device,sameDevice.profile,group,1800000];
  for (const [setting,value] of [['admission_id',''],['admission_id','invalid'],['epoch','0'],['source_sha256','invalid']]) {
    await assert.rejects(admitted(db=>db.transaction(async tx=>{
      await db.context(tx);
      await tx.unsafe('SELECT set_config($1,$2,true)',['collect.fence_'+setting,value]);
      await tx.unsafe(PIN_RENEW_SQL,renewArgs);
    })),{code:'55000',message:'burimunsi_setup_unavailable'});
  }
  assert.equal((await lease(sameDevice)).renewed,null);
  const otherDevice=await issue(accounts[0],45000);
  let second;
  const first=await admitted(db=>db.transaction(async tx=>{
    await db.context(tx);
    const [renewed]=await tx.unsafe(PIN_RENEW_SQL,renewArgs);
    const [{pid}]=await tx.unsafe('SELECT pg_backend_pid() AS pid');
    second=assertHome(sameDevice);
    void second.catch(()=>{});
    await waitForLock(pid,'ExclusiveLock');
    await assertHome(otherDevice,competingPool);
    return renewed.expires_at;
  }),'http_collect',regular,competingPool);
  assert.equal(await second,first);
  assert.equal((await lease(sameDevice)).renewed,first);

  // Commit a genuine logout while renewal is waiting behind an exclusive
  // writer. The waiter must observe the revocation before extending the lease.
  const revoked=await issue(accounts[0],45000);
  let denial;
  await admitted(db=>db.transaction(async tx=>{
    await db.context(tx);
    await lockCollectMutation(tx);
    const [{pid}]=await tx.unsafe('SELECT pg_backend_pid() AS pid');
    denial=assert.rejects(assertHome(revoked),{code:'session_unavailable'});
    void denial.catch(()=>{});
    await waitForLock(pid,'ShareLock');
    const [logout]=await tx.unsafe('SELECT private.burimunsi_pin_logout_barrier($1,$2::uuid,$3,$4,$5,NULL) AS result',
      [revoked.bearer,revoked.installation,revoked.device,revoked.profile,group]);
    assert.equal(logout.result.accountId,revoked.id);
  }),'http_collect',regular,competingPool);
  await denial;
  assert.equal((await lease(revoked)).renewed,null);
  console.log('PASS per-installation renewals serialize, another installation proceeds, logout denies renewal and disabled SMS consent persists');
  await verifyBrowserHomeBootstrap({admitted,pool,fixtureSql:inspect,businessStatements,group,accounts});
}
