// Requalify the existing BuriMunsi worker after a core release or a pg_net restart.
// Every network write has an immutable local intent and a hosted readback.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {PROJECT, ROOT, management, record, sha} from './access.mjs';
import {parseManagedReadiness,paymentsMigrationHistorySql,paymentsRecordingInstalled} from './managed-jobs-operator.mjs';

const digest = /^[0-9a-f]{64}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,50}$/;
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const read = path => JSON.parse(readFileSync(path));
const must = (truth, message) => { if (!truth) throw Error(message); };
const only = rows => { must(Array.isArray(rows) && rows.length === 1, 'expected_one_row'); return rows[0]; };
const sqlLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
const timestamp = () => new Date().toISOString();
const fastMigration = new URL('../../../supabase/migrations/20261122191300_burimunsi_event_driven_jobs.sql',import.meta.url);
const evidence = name => join(ROOT, name);
const paths = label => {
  must(slug.test(label),'invalid_evidence_name');
  const file = suffix => 'scheduler-' + label + '-' + suffix + '.json';
  return {file, get:suffix=>read(evidence(file(suffix))), has:suffix=>existsSync(evidence(file(suffix))),
    put:(suffix,value)=>record(file(suffix),value), hash:suffix=>sha(readFileSync(evidence(file(suffix))))};
};
async function sql(query, parameters = []) {
  const result = await management('database/query',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({query, parameters, read_only:false})});
  return result.json();
}
const stateQuery = `SELECT current_user AS actor,f.project_ref,f.mode,f.epoch,f.source_sha256,
 c.enabled,j.active,j.jobname,j.schedule,j.command,j.username,j.database,
 (SELECT encode(sha256(convert_to(statements[1],'UTF8')),'hex') FROM supabase_migrations.schema_migrations WHERE version='20261122191300') AS fast_migration,
 ${paymentsMigrationHistorySql},
 c.native_provider_source_sha256 AS old_source,c.native_provider_model_id AS model,
 c.native_provider_approval_sha256 AS approval,c.native_provider_used AS used,c.native_provider_limit AS cap,
 c.native_provider_expires_at AS deadline,c.readiness->>'copy_inventory_evidence_sha256' AS previous_copy,
 private._collect_fence_scheduler_status() AS guard,
 (SELECT count(*) FROM private.collect_imported_native_history)::int AS protected_history,
 (SELECT count(*) FROM pg_trigger WHERE tgname='collect_imported_native_history_guard' AND tgenabled='A'
   AND tgrelid IN ('private.burimunsi_auto_sms_jobs'::regclass,'private.burimunsi_native_financial_work'::regclass,
    'app.momo_financial_links'::regclass,'app.ledger_entries'::regclass))::int AS history_triggers,
 (SELECT count(*) FROM private.collect_fence_admissions a WHERE kind='jobs' AND state IN('active','unresolved')
  AND NOT private._collect_stopped_matches(a.admission_id,a.epoch,a.source_sha256,a.kind))::int AS active_admissions,
 (SELECT count(*) FROM vault.decrypted_secrets WHERE name=c.vault_name)::int AS key_count,
 (SELECT encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex') FROM vault.decrypted_secrets WHERE name=c.vault_name LIMIT 1) AS vault_digest,
 (SELECT count(*) FROM private.burimunsi_scopes)::int AS configured_scopes,
 (SELECT encode(sha256(convert_to(min(collection_id),'UTF8')),'hex') FROM private.burimunsi_scopes) AS scope_digest,
 (SELECT count(*) FROM private.burimunsi_scopes WHERE enabled AND active_binding_id IS NOT NULL)::int AS receiving_scopes,
 (SELECT count(*) FROM private.burimunsi_auto_sms_jobs WHERE phase<>'finished')::int AS waiting_jobs,
 (SELECT count(*) FROM collect_sms.devices WHERE ready=1 AND revoked_at IS NULL)::int AS ready_gateways,
 (SELECT max(last_seen_at) FROM collect_sms.devices WHERE ready=1 AND revoked_at IS NULL) AS gateway_seen
 FROM private.collect_fence_control f JOIN collect_ops.jobs_config c ON c.singleton=f.singleton
 JOIN cron.job j ON j.jobid=c.cron_job_id WHERE f.singleton`;
const identity = row => ({slug:row.slug,id:row.id,status:row.status,verify_jwt:row.verify_jwt,ezbr_sha256:row.ezbr_sha256});
const sorted = rows => rows.map(identity).sort((a,b)=>a.slug.localeCompare(b.slug));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function live() {
  const [state,functions,secrets] = await Promise.all([sql(stateQuery).then(only),
    management('functions').then(r=>r.json()),management('secrets').then(r=>r.json())]);
  return {state,functions,keys:new Map(secrets.map(row=>[row.name,row.value]))};
}
function checkIdle(s) {
  must(!s.fast_migration || s.fast_migration===sha(readFileSync(fastMigration)),'unqualified_fast_scheduler_migration');
  paymentsRecordingInstalled(s);
  must(s.actor==='postgres' && s.project_ref===PROJECT && s.mode==='open' && !s.enabled && !s.active &&
    s.schedule===(s.fast_migration?'1 second':'* * * * *') && s.jobname==='collect-jobs-maintenance-v1' && s.command==='SELECT collect_ops.tick_jobs();' &&
    s.username==='postgres' && s.database==='postgres' && s.guard.coverageVerified && !s.guard.blocking &&
    !s.guard.awaitingDispatches && !s.guard.unconfirmedDispatches && !s.guard.pendingNativeRequests &&
    s.active_admissions===0 && s.history_triggers===4 && s.configured_scopes===1,'unexpected_scheduler_preimage');
}
function checkSettings(x) {
  const s=x.state;
  const recordsPayments=paymentsRecordingInstalled(s);
  const expected={BUILD_SOURCE_ID:s.source_sha256,COLLECT_SMS_CORE_SOURCE_SHA256:s.source_sha256,
    COLLECT_JOB_AUTH_MODE:'supabase_dispatch_hmac_v1',BURIMUNSI_PRODUCT_MODE:'standalone',
    BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'true',MOMO_AI_ENABLED:'true',MOMO_AI_MODEL:s.model,
    MOMO_PROCESSING_PAUSED:'true',COLLECT_SMS_ENABLED:'true',COLLECT_SMS_DISPATCH_PAUSED:'false',
    BURIMUNSI_PAYMENT_SMS_ENABLED:recordsPayments?'false':'true'};
  must(Object.entries(expected).every(([k,v])=>x.keys.get(k)===sha(v)) && x.keys.has('OPENAI_API_KEY') &&
    x.keys.get('BURIMUNSI_COLLECTION_ID')===s.scope_digest &&
    (recordsPayments||x.keys.get('BURIMUNSI_PAYMENT_SMS_COLLECTION_ID')===s.scope_digest) &&
    s.key_count===1 && digest.test(s.vault_digest) && x.keys.get('COLLECT_JOB_SIGNING_KEY')===s.vault_digest,
    'edge_settings_or_scheduler_key_changed');
}
export function validateQuota(q, now=Date.now()) {
  const observed=Date.parse(q.verifiedAt);
  must(q.project===PROJECT && q.scope==='all projects' && q.source?.startsWith('https://supabase.com/dashboard/org/') &&
    Number.isFinite(observed) && observed>=now-3600000 && observed<=now+30000 &&
    Number.isSafeInteger(q.included) && Number.isSafeInteger(q.used) && q.used>=0 &&
    q.included-q.used>=50000 && Date.parse(q.period?.[0])<=now && Date.parse(q.period?.[1])>now,'fresh_invocation_quota_required');
  return q.included-q.used;
}
export function verifyNativeSourceHistory(from, target, rows) {
  must(digest.test(from) && digest.test(target) && Array.isArray(rows) && rows.length<=50,'native_source_history_invalid');
  const seen=new Set([from]);
  let source=from, lastEpoch=0;
  for(const row of rows){
    must(row.previous===source && digest.test(row.source) && !seen.has(row.source) &&
      Number.isSafeInteger(row.epoch) && row.epoch>lastEpoch && row.next_epoch===row.epoch+1 &&
      digest.test(row.qualification) && digest.test(row.deployment) && row.signed_dispatch===true,
      'native_source_history_invalid');
    source=row.source;lastEpoch=row.epoch;seen.add(source);
  }
  must(source===target,'native_source_history_incomplete');
  return rows;
}
async function nativeSourceHistory(previous,s) {
  if(previous.sourceSha256===s.old_source) return [];
  // Each retained upgrade must have run the same scoped, signed native contract
  // afterwards. A release receipt alone carries no provider authorization.
  const rows=await sql(`WITH RECURSIVE path AS (
    SELECT u.*,1 AS depth,ARRAY[u.old_source_sha256,u.new_source_sha256] AS visited
    FROM private.collect_fence_source_upgrades u WHERE u.project_ref=$1 AND u.old_source_sha256=$2
    UNION ALL
    SELECT u.*,p.depth+1,p.visited||u.new_source_sha256 FROM path p
    JOIN private.collect_fence_source_upgrades u ON u.project_ref=$1 AND u.old_source_sha256=p.new_source_sha256
      AND u.old_epoch>p.new_epoch AND NOT u.new_source_sha256=ANY(p.visited)
    WHERE p.new_source_sha256<>$3 AND p.depth<50)
    SELECT p.old_source_sha256 AS previous,p.new_source_sha256 AS source,p.old_epoch::int AS epoch,p.new_epoch::int AS next_epoch,
      p.qualification_sha256 AS qualification,p.deployment_readback_sha256 AS deployment,
      EXISTS(SELECT 1 FROM collect_ops.jobs_dispatches d JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id
        WHERE d.state='confirmed' AND d.http_status=200 AND d.created_at>=p.recorded_at AND t.completed_at IS NOT NULL
          AND t.source_sha256=p.new_source_sha256 AND t.response_sha256=d.response_sha256
          AND d.native_contract=jsonb_build_object('contract','collect.native-sms-automation.v1','model_id',$4::text,
            'approval_sha256',$5::text,'source_sha256',p.new_source_sha256,'batch_limit',1)) AS signed_dispatch
    FROM path p ORDER BY p.old_epoch LIMIT 51`,[PROJECT,previous.sourceSha256,s.old_source,s.model,s.approval]);
  return verifyNativeSourceHistory(previous.sourceSha256,s.old_source,rows);
}
async function prepare(p, [priorFile,bundlesFile,gatewayFile,quotaFile]) {
  const previous=read(priorFile), bundles=read(bundlesFile), gateway=read(gatewayFile), quota=read(quotaFile);
  const x=await live(), s=x.state;
  checkIdle(s); checkSettings(x); validateQuota(quota);
  must(previous.format==='collect.native-sms.owner-approval.v1' && previous.project===PROJECT &&
    digest.test(previous.sourceSha256) && sha(readFileSync(priorFile))===s.approval &&
    previous.model===s.model && (previous.applicationLimit??null)===s.cap &&
    (previous.applicationDeadline??null)===(s.deadline??null) && x.keys.get('COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256')===sha(s.approval),
    'prior_native_authorization_changed');
  const nativeSourceTransitions=await nativeSourceHistory(previous,s);
  must(bundles.project===PROJECT && bundles.sourceSha256===s.source_sha256 && bundles.checked?.status==='passed' &&
    bundles.checked.sourceSha256===s.source_sha256 && bundles.staged?.length===3 &&
    ['collect-api','admin-api','collect-jobs'].every(name=>bundles.staged.some(b=>b.slug===name && b.status===201 &&
      x.functions.some(f=>f.slug===name && f.ezbr_sha256===b.ezbr_sha256))), 'current_core_bundle_unqualified');
  must(gateway.project===PROJECT && gateway.sourceSha256===s.source_sha256 && x.keys.get('COLLECT_SMS_RELEASE_SHA256')===sha(gateway.gatewayReleaseSha256) &&
    x.functions.length===4 && x.functions.every(f=>f.status==='ACTIVE' && f.verify_jwt===false) &&
    sha((await management('functions/collect-sms/body')).bytes)===gateway.gatewayArchiveSha256,'current_gateway_unqualified');
  const journal=await sql(`SELECT d.created_at,d.reason,d.resolution_evidence_sha256 IS NOT NULL AS reviewed,
    t.claimed_at IS NOT NULL AS claimed,t.completed_at IS NOT NULL AS completed,t.native_provider_calls
    FROM collect_ops.jobs_dispatches d LEFT JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id
    WHERE d.state='reviewed_unknown' ORDER BY d.created_at DESC LIMIT 16`);
  const copyInventory=readFileSync(new URL('../../../supabase/retention-inventory.json',import.meta.url));
  const recordsPayments=paymentsRecordingInstalled(s);
  const guards=await sql(`SELECT p.oid::regprocedure::text AS routine,p.proowner::regrole::text AS owner,
     encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS digest FROM pg_proc p
     WHERE p.pronamespace='collect_ops'::regnamespace OR p.proname IN ('collect_native_provider_reserve','collect_managed_job_complete','collect_managed_job_claim','burimunsi_auto_finish')
     ORDER BY 1`);
  must(guards.length>=14 && guards.every(g=>g.owner==='postgres') && journal.every(r=>r.reviewed),'runtime_or_dispatch_evidence_incomplete');
  const qualification={project:PROJECT,at:timestamp(),bundlesSha256:sha(readFileSync(bundlesFile)),
    gatewayApprovalSha256:sha(readFileSync(gatewayFile)),gatewayReleaseSha256:gateway.gatewayReleaseSha256,
    functions:sorted(x.functions),state:s,dbRoutines:guards,previousDispatches:journal,nativeSourceTransitions,
    copyInventorySha256:sha(copyInventory),quota,sourceSha256:s.source_sha256};
  const reuse=s.source_sha256===s.old_source;
  p.put('qualification',qualification);
  // The prior approval expressly fixes the model, spend and collection scope. A release
  // changes the source digest, so retain a separate continuation for the new source.
  p.put('approval',reuse?readFileSync(priorFile,'utf8'):{
    format:'collect.native-sms.owner-approval.v1',project:PROJECT,sourceSha256:s.source_sha256,
    previousSourceSha256:s.old_source,previousApprovalSha256:s.approval,model:s.model,
    providerUsedPreserved:s.used,applicationLimit:s.cap,applicationDeadline:s.deadline,
    qualificationSha256:p.hash('qualification'),
    scope:recordsPayments
     ?'Continue authorized M-Money SMS extraction and recording in BuriMunsi Payments on this verified release. Preserve the collection, model and provider limits.'
     :'Continue the existing authorized BuriMunsi automatic payment processing on this verified release. Preserve collection, model, provider limits and verified payer delivery.',
    at:timestamp()});
  console.log(JSON.stringify({ready:true,epoch:s.epoch,readyGateways:s.ready_gateways,waiting:s.waiting_jobs,remainingInvocations:validateQuota(quota)}));
}
async function bind(p) {
  const q=p.get('qualification'), a=p.hash('approval'), x=await live(), s=x.state;
  checkIdle(s);checkSettings(x);validateQuota(q.quota);
  must(s.source_sha256===q.sourceSha256 && s.epoch===q.state.epoch && same(sorted(x.functions),q.functions),'release_changed');
  const current=x.keys.get('COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256');
  if (current!==sha(a)) {
    must(current===sha(q.state.approval) && !p.has('secret-attempt'),'reconcile_original_secret_write');
    p.put('secret-attempt',{expected:s.approval,next:a,at:timestamp()});
    await management('secrets',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify([{name:'COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256',value:a}])});
  }
  const after=await live();checkIdle(after.state);checkSettings(after);
  must(same(sorted(after.functions),q.functions) && after.keys.get('COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256')===sha(a),'secret_readback_changed');
  if (!p.has('bound')) p.put('bound',{source:q.sourceSha256,functions:after.functions.map(({slug,version,ezbr_sha256})=>({slug,version,ezbr_sha256})),at:timestamp()});
  console.log(JSON.stringify({sourceBound:true,functions:after.functions.length}));
}
async function probe(p) {
  const q=p.get('qualification'), approval=p.hash('approval'), x=await live(), s=x.state;
  must(p.has('bound') && same(sorted(x.functions),q.functions) && x.keys.get('COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256')===sha(approval),'bind_first');
  checkSettings(x);
  if (p.has('probe')) {
    const prior=p.get('probe');
    const rows=await sql('SELECT state FROM collect_ops.jobs_dispatches WHERE id=$1::uuid',[prior.id]);
    if(rows.length) {console.log(JSON.stringify({id:prior.id,state:rows[0].state}));return;}
  }
  checkIdle(s);
  must(s.epoch===q.state.epoch && s.source_sha256===q.sourceSha256 && s.old_source===q.state.old_source &&
    s.approval===q.state.approval && s.used===q.state.used && s.cap===q.state.cap && s.deadline===q.state.deadline,'budget_or_release_changed');
  const readiness={format:'collect.jobs.readiness.v1',project_ref:PROJECT,endpoint:'https://'+PROJECT+'.supabase.co/functions/v1/collect-jobs',
    deployment_sha256:q.bundlesSha256,runtime_evidence_sha256:p.hash('qualification'),token_custody_evidence_sha256:sha(bytes({vault:s.vault_digest,count:s.key_count})),
    copy_inventory_evidence_sha256:q.copyInventorySha256,quota_evidence_sha256:sha(bytes(q.quota)),verified_at:q.at,
    momo_processing_paused:true,remaining_invocations:validateQuota(q.quota),remaining_native_provider_requests:s.cap===null?null:s.cap-s.used,
    native_sms_admission:{contract:'collect.native-sms-automation.v1',source_sha256:s.source_sha256,approval_sha256:approval,model_id:s.model,batch_limit:1},
    native_provider_evidence_sha256:approval,native_guard_evidence_sha256:sha(bytes(q.dbRoutines))};
  const valid=parseManagedReadiness(Buffer.from(bytes(readiness))).readiness;
  if(!p.has('probe')) p.put('probe',{id:randomUUID(),readiness:valid,at:timestamp()});
  const op=p.get('probe');
  must(same(valid,op.readiness),'probe_input_changed');
  // All calls share the same transaction and advisory-lock order as the normal release.
  // The original UUID is safe to query after a lost response.
  const literal = sqlLiteral;
  await sql(`DO $requalify$
    DECLARE c collect_ops.jobs_config%ROWTYPE; f private.collect_fence_control%ROWTYPE; result jsonb;
    BEGIN
      PERFORM set_config('lock_timeout','5s',true);
      PERFORM private._collect_fence_require_operator(); PERFORM private.collect_fence_assert_write(NULL,NULL,NULL);
      PERFORM pg_advisory_xact_lock(hashtextextended('collect.scheduler.rrlduytparvsjfmegalh',0));
      PERFORM pg_advisory_xact_lock(734636924058501::bigint);
      SELECT * INTO STRICT f FROM private.collect_fence_control WHERE singleton;
      SELECT * INTO STRICT c FROM collect_ops.jobs_config WHERE singleton FOR UPDATE;
      IF f.mode<>'open' OR f.epoch<>${s.epoch} OR f.source_sha256<>${literal(s.source_sha256)}
       OR c.enabled OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobid=c.cron_job_id AND NOT active AND command='SELECT collect_ops.tick_jobs();' AND schedule=${literal(s.schedule)})
       OR c.native_provider_source_sha256 IS DISTINCT FROM ${literal(s.old_source)}
       OR c.native_provider_approval_sha256 IS DISTINCT FROM ${literal(s.approval)}
       OR c.native_provider_model_id IS DISTINCT FROM ${literal(s.model)} OR c.native_provider_used<>${s.used}
       OR c.native_provider_limit IS DISTINCT FROM ${s.cap===null?'NULL':s.cap}::bigint
       OR c.native_provider_expires_at IS DISTINCT FROM ${s.deadline===null?'NULL':literal(s.deadline)}::timestamptz
       OR EXISTS(SELECT 1 FROM collect_ops.jobs_dispatches WHERE state IN ('awaiting','unconfirmed'))
       OR EXISTS(SELECT 1 FROM private.collect_fence_admissions a WHERE kind='jobs' AND state IN('active','unresolved') AND NOT private._collect_stopped_matches(a.admission_id,a.epoch,a.source_sha256,a.kind))
      THEN RAISE EXCEPTION 'scheduler_preimage_changed'; END IF;
      UPDATE collect_ops.jobs_config SET native_provider_source_sha256=f.source_sha256,
       native_provider_approval_sha256=${literal(approval)} WHERE singleton;
      PERFORM collect_ops.record_jobs_readiness(${literal(JSON.stringify(valid))}::jsonb);
      result:=collect_ops.dispatch_jobs('probe',${literal(op.id)}::uuid);
      IF result->>'state' IS DISTINCT FROM 'awaiting' THEN RAISE EXCEPTION 'probe_was_not_queued';END IF;
    END $requalify$;`);
  console.log(JSON.stringify({id:op.id,state:'awaiting'}));
}
async function reconcile(p,activate) {
  const op=p.get('probe'),q=p.get('qualification');
  await sql('SELECT collect_ops.reconcile_jobs() AS result');
  const d=only(await sql(`SELECT d.state,d.reason,d.http_status,d.created_at,
    d.response_sha256=t.response_sha256 AND t.completed_at IS NOT NULL AS attested
    FROM collect_ops.jobs_dispatches d LEFT JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id WHERE d.id=$1::uuid`,[op.id]));
  if(activate){
    must(d.state==='confirmed' && d.attested && d.http_status===200,'confirmed_original_probe_required');
    const x=await live();checkSettings(x);
    must(same(sorted(x.functions),q.functions) && x.state.source_sha256===q.sourceSha256 && x.state.approval===p.hash('approval'),'release_changed');
    if(!x.state.enabled) await sql('SELECT collect_ops.activate_jobs($1::text) AS result',[op.readiness.evidence_file_sha256]);
    const {state:s}=await live();
    must(s.enabled && s.active,'activation_unconfirmed');
    if(!p.has('active')) p.put('active',{id:op.id,source:q.sourceSha256,at:timestamp(),...d});
  }
  console.log(JSON.stringify(d));
}
async function verifyRecurring(p) {
  const original=p.get('probe'), q=p.get('qualification');
  const x=await live();checkSettings(x);
  must(x.state.enabled && x.state.active && x.state.source_sha256===q.sourceSha256,'scheduler_is_not_active');
  const runs=await sql(`SELECT d.slot,d.observed_at,d.http_status,d.response_sha256,
    t.completed_at,t.native_provider_calls
    FROM collect_ops.jobs_dispatches d JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id
    WHERE d.kind='scheduled' AND d.state='confirmed' AND d.http_status=200 AND t.completed_at IS NOT NULL
      AND d.response_sha256=t.response_sha256 AND t.source_sha256=$1
      AND d.created_at>(SELECT created_at FROM collect_ops.jobs_dispatches WHERE id=$2::uuid)
    ORDER BY d.slot DESC LIMIT 3`,[q.sourceSha256,original.id]);
  const interval=runs.length>=2?Date.parse(runs[0].slot)-Date.parse(runs[1].slot):0;
  must(runs.length>=2 && (x.state.fast_migration?interval>=1000 && interval<=75000:interval===60000) &&
    Date.now()-Date.parse(runs[0].observed_at)<180000,'two_recent_consecutive_confirmations_required');
  const [cadence]=await sql(`SELECT count(*)::int AS ticks_in_last_ten_seconds FROM cron.job_run_details r
     JOIN collect_ops.jobs_config c ON c.cron_job_id=r.jobid WHERE r.start_time>clock_timestamp()-interval '10 seconds'`);
  if (x.state.fast_migration) must(cadence.ticks_in_last_ten_seconds>=5,'fast_cron_cadence_unconfirmed');
  const result={project:PROJECT,epoch:x.state.epoch,checkedAt:timestamp(),cronActive:x.state.active,schedule:x.state.schedule,...cadence,runs,
    protectedHistory:x.state.protected_history,queuedNativeJobs:x.state.waiting_jobs,
    readyGateways:x.state.ready_gateways,lastGatewayHeartbeat:x.state.gateway_seen};
  if(!p.has('recurring')) p.put('recurring',result);
  console.log(JSON.stringify(result));
}
async function main([action,label,...args]){
  const p=paths(label);
  if(action==='prepare' && args.length===4) return prepare(p,args);
  if(args.length) throw Error('invalid_arguments');
  if(action==='bind') return bind(p);
  if(action==='probe') return probe(p);
  if(action==='reconcile' || action==='activate') return reconcile(p,action==='activate');
  if(action==='verify') return verifyRecurring(p);
  throw Error('expected_prepare_bind_probe_reconcile_activate_or_verify');
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url)
  main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
