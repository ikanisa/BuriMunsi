// Invoked by the disposable managed archive chain. All release SQL since the
// phone-directory migration runs unmodified on the same server as the HTTP reads.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readRecordedHistory, readRecordedSql} from '../../../scripts/supabase/cloud-release/recorded-history.mjs';

const root = new URL('../../../', import.meta.url);
const file = path => readFile(new URL(path,root),'utf8');
const migration = name => file('supabase/migrations/'+name);
// Current collection phone/session dependencies in the e714 source. The
// gateway-only 221915/222040 wake migrations are outside this read fixture.
const latest = [
  '20261122190000_burimunsi_phone_operator_accounts.sql',
  '20261122191000_burimunsi_sms_completeness.sql',
  '20261122191100_burimunsi_payment_sms_obligations.sql',
  '20261122191200_burimunsi_known_device_login_budget.sql',
  '20261122191300_burimunsi_event_driven_jobs.sql',
  '20261122191400_burimunsi_admin_realtime.sql',
  '20261122200000_burimunsi_admin_handset_intake.sql',
  '20261122201000_burimunsi_admin_inbox_coverage.sql',
  '20261122202000_burimunsi_current_admin_inbox_authority.sql',
  '20261122203000_burimunsi_phone_admin_sms_read_scope.sql',
  '20261123061132_burimunsi_single_admin.sql',
  '20261124080000_burimunsi_read_admission.sql',
  '20261124091329_burimunsi_idle_native_jobs.sql',
  '20261124100000_burimunsi_payment_activity_source_metadata.sql',
  '20261124100500_burimunsi_phone_renewal_lock.sql',
];

export async function verifyFreshPhoneReads({owner,admin,database,fixtureRoot}) {
  assert.match(database,/^collect_archive_[a-f0-9]{24}_test$/);
  assert.match(fixtureRoot,/^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+$/);
  assert.equal(owner.connectionParameters?.host,fixtureRoot+'/s');
  assert.equal(owner.connectionParameters?.database,database);
  assert.equal(owner.connectionParameters?.user,'postgres');
  const [target] = (await owner.query(`SELECT inet_server_addr() IS NULL AS local,
    current_setting('cluster_name') AS cluster,current_database() AS db,current_user AS role,
    session_user AS login,current_setting('server_version_num')::integer/10000 AS major`)).rows;
  assert.deepEqual(target,{local:true,cluster:'collect_archive_next_fixture',db:database,role:'postgres',login:'postgres',major:17});
  const apply = async name => {
    await owner.query(await migration(name));
    console.log('Applied',name);
  };
  await apply('20261117071343_collect_burimunsi_import_lineage_guard.sql');

  // Reuse the repository's private Cron, pg_net and Vault doubles and the real
  // scheduler logic. The fixture never configures a gateway or external worker.
  await admin.query('GRANT CREATE ON DATABASE '+database+' TO postgres');
  const maintenance = await file('scripts/supabase/sql-maintenance/install.sql.in');
  const start = maintenance.indexOf('CREATE SCHEMA collect_ops AUTHORIZATION'), end = maintenance.indexOf('DO $acl$');
  assert.ok(start >= 0 && end > start);
  await owner.query(maintenance.slice(start,end).replaceAll('__OPERATOR_ROLE__','postgres').replaceAll('__DATABASE__',database));
  await owner.query(await file('supabase/jobs/test-fixture.sql'));
  await owner.query('ALTER TABLE cron.job_run_details ADD COLUMN status text,ADD COLUMN start_time timestamptz');
  const [local] = (await owner.query(`SELECT
    encode(sha256(convert_to(pg_get_functiondef('collect_ops.cleanup_google_expired()'::regprocedure),'UTF8')),'hex') AS cleanup,
    (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc
     WHERE oid='private._retention_manifest_catalog_v2()'::regprocedure) AS manifest`)).rows;
  // Only the historical provider bootstrap pins depend on this disposable
  // database name and catalog. Current release migration bytes stay intact.
  const scheduler = await migration('20261117073850_collect_managed_jobs_hmac.sql');
  const cleanupPin = 'f70925051147096cfb72869b401fdb69c976b68034c87e8c3e98ee8b5f350ed0';
  const manifestPin = '09ecc11aca46af15d7f981b5d5c7c7d3775be6fc245c8ff73f48f61269e37671';
  for (const pin of [cleanupPin,manifestPin]) assert.equal(scheduler.split(pin).length,2);
  await owner.query(scheduler.replace(cleanupPin,local.cleanup).replace(manifestPin,local.manifest));
  for (const name of [
    '20261117081411_collect_native_provider_budget.sql','20261117090952_burimunsi_native_parse_review.sql',
    '20261117134926_collect_native_provider_policy.sql','20261117134954_burimunsi_observation_processing_status.sql',
    '20261117135049_collect_sms_schedule_one_minute.sql','20261117180000_burimunsi_observation_reconcile_status.sql',
    '20261117190000_burimunsi_legacy_reconcile.sql','20261118090305_burimunsi_automatic_payment_sms.sql',
    '20261119041100_burimunsi_payment_sms_status.sql',
  ]) await apply(name);
  const {record} = await readRecordedHistory('cloud-history-20261120-epoch44.json');
  for (const version of ['20261119114700','20261120104500']) {
    await owner.query(await readRecordedSql(record.history.find(row=>row.version===version)));
  }
  for (const name of ['20261119114600_burimunsi_admin_sms_health.sql',
    '20261122125000_burimunsi_browser_passcode.sql','20261122140000_burimunsi_batch_payment_projections.sql',
    '20261122180000_burimunsi_internal_query_performance.sql']) await apply(name);

  // Start from the actual protected owner and delegated staff rows predating
  // the phone-only directory release, then fence and migrate them together.
  const seed = (await file('scripts/supabase/cloud-release/fixtures/burimunsi-browser-passcode.sql')).split('\nDO $exercise$\n');
  assert.equal(seed.length,2);
  const [schedulerState] = (await owner.query('SELECT private._collect_fence_scheduler_status() AS state')).rows;
  assert.equal(schedulerState.state.blocking,false);
  assert.equal(schedulerState.state.coverageVerified,true);
  await owner.query(seed[0]+'\nCOMMIT;');
  const [control] = (await owner.query('SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows;
  const source = control.source_sha256, hold = [randomUUID(),control.epoch,source];
  await owner.query('SELECT private.collect_fence_begin_quiesce($1,$2,$3)',hold);
  await owner.query('SELECT private.collect_fence_drain($1,$2,$3)',hold);
  // Gateway and outbound providers run elsewhere. These empty relations are
  // enough for the unconfigured monitor branches; never run a gateway here.
  await admin.query(`CREATE SCHEMA IF NOT EXISTS collect_sms;
    CREATE TABLE IF NOT EXISTS collect_sms.messages(message_id text PRIMARY KEY,application_id text,kind text,idempotency_key text,state text,text text);
    CREATE TABLE IF NOT EXISTS collect_sms.devices(last_seen_at text,ready bigint,revoked_at text,allowed_kinds text);
    ALTER TABLE collect_sms.messages OWNER TO postgres;ALTER TABLE collect_sms.devices OWNER TO postgres;
    GRANT USAGE ON SCHEMA collect_sms TO postgres`);
  for (const name of latest) await apply(name);
  await owner.query('SELECT private.collect_fence_release_v3($1,$2,$3)',[randomUUID(),control.epoch,source]);
  // Reuse the checked-in lock with cached-only imports. The child may connect
  // to this one disposable UNIX socket, never to the internet or another DB.
  const {host:socket,port:actualPort} = owner.connectionParameters;
  const endpoint = socket+'/.s.PGSQL.'+actualPort;
  const deno = process.env.DENO_BIN ?? 'deno';
  const env = {PATH:process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',NO_COLOR:'1',DENO_NO_UPDATE_CHECK:'1'};
  const denoVersion = execFileSync(deno,['--version'],{env,encoding:'utf8',timeout:5000,maxBuffer:2048});
  assert.match(denoVersion,/^deno 2\.9\.6\s/m);
  const lock = fileURLToPath(new URL('supabase/functions/deno.lock',root));
  const entry = fileURLToPath(new URL('./fresh-phone-driver.mjs',import.meta.url));
  execFileSync(deno,['run','--no-prompt','--node-modules-dir=none','--lock='+lock,'--frozen','--cached-only',
    '--allow-read='+fixtureRoot,'--allow-env','--allow-sys=uid','--allow-net=unix:'+endpoint,'--allow-write='+endpoint,
    entry,socket,String(actualPort),database,source],{
    env,stdio:'inherit',timeout:90000,
  });
}
