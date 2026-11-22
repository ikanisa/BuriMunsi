// Render one exact, fenced PostgreSQL transaction for a bounded SQL transport.
// Executing or retrying that transaction belongs to the release operator.
import assert from 'node:assert/strict';
import {canonical,HASH,sha} from '../current-archive/codec.mjs';
import {SOURCE,body,identity,profile} from './migrations.mjs';
import {historyDigest,projectRef,readRecordedHistory} from './recorded-history.mjs';
import {requireRevisionSchedulerReady} from './revise-runtime.mjs';
import {migrationBytes} from './retained-source.mjs';
import {loadWriterJournalCohort} from './writer-journal-plan.mjs';
import {expectedWriterJournalCatalog,verifyWriterJournalCatalog,writerJournalCatalogQueries} from './writer-journal-catalog.mjs';

const cleanup=[
  {name:'20261122043731_collect_sms_helper_paths.sql',sha256:'1c623acd017d1529874d1b7ffe07a8785af6b274ae8453382bff3b2af8d74130'},
  {name:'20261122045039_deduplicate_burimunsi_principal_scope.sql',sha256:'1e3c9928551d414d1c3814c59603c2182cc662767d9fd06d2a545ca7e77b207e'},
];
const smsHelpers=[
  ['collect_sms.json_each(text)','10a4149d58741d747c45712b9648ff60b065dcdee8a954f047521c4e61492cba'],
  ['collect_sms.json_extract(text,text)','281cde480dc006cfcc5b64bc11c24ea863112898db638a8f4b2989679334c130'],
  ['collect_sms.json_valid(text)','a266629e67212b00d56af781033b404d3aa830ed22b05b2c85774ad0cb16ba48'],
  ['collect_sms.max(bigint,bigint)','05370188210dbd450687a69db020a3edb212ab2408e314b567c4155900027962'],
];
const scopeConstraint='burimunsi_one_principal_per_scope';
const duplicateIndex='burimunsi_provisioning_one_principal_per_scope';
const fixedSearchPath=['search_path=pg_catalog, pg_temp'];
const plans=new WeakSet();

function exactLiteral(value,kind) {
  assert.equal(typeof value,'string');
  const delimiter=`$collect_${kind}_${sha(value).slice(0,24)}$`;
  assert.ok(!value.includes(delimiter),'forward_migration_literal_collision');
  return delimiter+value+delimiter;
}

export async function loadForwardMigrationPlan() {
  const cohort=await loadWriterJournalCohort();
  const {record}=await readRecordedHistory(cohort.plan.predecessor.file);
  const history=[...record.history],entries=[],prefixes=[];
  const addPrefix=()=>prefixes.push(Object.freeze({
    migration_count:history.length,ordered_sha256:historyDigest(history),
    last_version:history.at(-1).version,invalid_bodies:0,
  }));
  addPrefix();
  const extra=await Promise.all(cleanup.map(async source=>identity(source.name,(await migrationBytes(SOURCE,source)).toString('utf8'))));
  for(const candidate of [...cohort.entries,...extra]){
    assert.ok(candidate.version>history.at(-1).version&&body(candidate.sql)!==candidate.sql,'forward_migration_source_changed');
    history.push({version:candidate.version,name:candidate.name,sha256:candidate.sha256,entries:1});
    entries.push(Object.freeze(candidate));
    addPrefix();
  }
  const plan=Object.freeze({project_ref:projectRef,entries:Object.freeze(entries),prefixes:Object.freeze(prefixes)});
  plans.add(plan);
  return plan;
}

const historySql=`SELECT count(*)::int migration_count,max(version) last_version,
  count(*) FILTER (WHERE name IS NULL OR statements[1] IS NULL OR cardinality(statements) IS DISTINCT FROM 1)::int invalid_bodies,
  encode(sha256(convert_to(string_agg(version||':'||name||':'||
    encode(sha256(convert_to(statements[1],'UTF8')),'hex'),E'\\n' ORDER BY version COLLATE "C"),'UTF8')),'hex') ordered_sha256
  FROM supabase_migrations.schema_migrations`;

const controlSql=`SELECT f.project_ref,f.mode,f.epoch::text,f.operation_id::text,f.source_sha256,d.profile_sha256,
  session_user::text AS session_role,current_user::text AS current_role,current_database()::text AS database_name,
  current_setting('server_version_num')::int/10000 AS pg_major,private._collect_fence_operator() AS authority,
  inet_server_addr() IS NULL AND current_setting('cluster_name')='collect_archive_next_fixture' AS synthetic_fixture
  FROM private.collect_fence_control f JOIN private.collect_deployment_identity d USING(singleton) WHERE f.singleton`;

const schedulerSql=`SELECT s.status->'checked' checked,s.status->'coverageVerified' AS "coverageVerified",s.status->'blocking' blocking
  FROM (SELECT private._collect_fence_scheduler_status() status OFFSET 0) s`;

const smsSql=`SELECT input.signature,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text acl,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_sha256,
  has_function_privilege('collect_sms_runtime',p.oid,'EXECUTE') AS runtime_execute,
  has_function_privilege('collect_sms_runtime',p.oid,'EXECUTE WITH GRANT OPTION') AS runtime_delegable,
  EXISTS(SELECT FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
    AND has_function_privilege(r.oid,p.oid,'EXECUTE')) exposed
  FROM unnest($1::text[]) WITH ORDINALITY input(signature,ordinal)
  JOIN pg_proc p ON p.oid=to_regprocedure(input.signature) ORDER BY input.ordinal`;

const scopeSql=`SELECT x.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,pg_get_userbyid(x.relowner) AS owner,
  COALESCE(c.conname,'') AS constraint_name,COALESCE(c.contype::text,'') AS constraint_type,
  COALESCE(c.convalidated,false) validated,i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate AS ready
  FROM pg_class x JOIN pg_index i ON i.indexrelid=x.oid LEFT JOIN pg_constraint c ON c.conindid=x.oid
  WHERE i.indrelid='private.burimunsi_accounts'::regclass AND x.relnamespace='private'::regnamespace
    AND x.relname=ANY($1) ORDER BY x.relname COLLATE "C"`;

function scalar(sql) {
  return '(SELECT to_jsonb(t) FROM ('+sql+') t)';
}

function jsonArray(sql) {
  return "(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ("+sql+") t)";
}

function argumentSql(sql,args) {
  return sql.replace(/\$(\d+)/g,(_match,pos)=>{
    const arg=args[Number(pos)-1];
    assert.ok(Array.isArray(arg)&&arg.length&&arg.every(x=>typeof x==='string'),'forward_migration_query_argument');
    return 'ARRAY['+arg.map(value=>exactLiteral(value,'arg')).join(',')+']::text[]';
  });
}

const catalogVerification={dispositionsFromPinnedBody:true};
const catalogQueries=Object.entries(writerJournalCatalogQueries()).filter(([key])=>key!=='dispositions');
const catalogSql='jsonb_build_object('+catalogQueries.map(([key,{single,sql,args}])=>
  "'"+key+"',"+(single?scalar:jsonArray)(argumentSql(sql,args))).join(',\n')+')';

const snapshotSql=`SELECT jsonb_build_object(
  'history',${scalar(historySql)},
  'fence',${scalar(controlSql)},
  'scheduler',${scalar(schedulerSql)},
  'outstanding',(SELECT count(*)::int FROM private.collect_fence_admissions a WHERE a.state<>'settled'
    AND NOT private._collect_stopped_matches(a.admission_id,a.epoch,a.source_sha256,a.kind)
    AND NOT private._collect_managed_retirement_matches(a.admission_id,a.epoch,a.source_sha256,a.kind)),
  'catalog',${catalogSql},
  'sms_helpers',${jsonArray(argumentSql(smsSql,[smsHelpers.map(([signature])=>signature)]))},
  'scope_indexes',${jsonArray(argumentSql(scopeSql,[[scopeConstraint,duplicateIndex]]))}
) AS snapshot`;

export function forwardMigrationSnapshotSql() {
  return `SELECT observed.snapshot, pg_backend_pid() AS backend_pid FROM (${snapshotSql}) observed`;
}

function verifyCleanup(snapshot,completed) {
  assert.equal(snapshot.sms_helpers.length,smsHelpers.length,'forward_migration_sms_helpers_missing');
  for(const [i,row] of snapshot.sms_helpers.entries()){
    const [signature,bodyHash]=smsHelpers[i];
    assert.ok(row.signature===signature&&row.body_sha256===bodyHash&&row.owner==='postgres'&&
      row.provolatile==='i'&&row.prosecdef===false&&row.runtime_execute===true&&row.runtime_delegable===false&&
      row.exposed===false&&typeof row.acl==='string','forward_migration_sms_helper_changed');
    assert.deepEqual(row.proconfig,completed<5?null:fixedSearchPath,'forward_migration_sms_search_path_changed');
  }
  const expectedNames=completed<6?[scopeConstraint,duplicateIndex]:[scopeConstraint];
  assert.deepEqual(snapshot.scope_indexes.map(row=>row.name),expectedNames,'forward_migration_principal_index_set_changed');
  for(const row of snapshot.scope_indexes){
    assert.ok(row.owner==='postgres'&&row.ready===true&&row.definition===
      `CREATE UNIQUE INDEX ${row.name} ON private.burimunsi_accounts USING btree (collection_id, principal_user_id)`,
    'forward_migration_principal_index_changed');
    const primary=row.name===scopeConstraint;
    assert.equal(row.constraint_name,primary?scopeConstraint:'','forward_migration_principal_constraint_changed');
    assert.equal(row.constraint_type,primary?'u':'','forward_migration_principal_constraint_changed');
    assert.equal(row.validated,primary,'forward_migration_principal_constraint_changed');
  }
}

export function validateForwardMigrationSnapshot(plan,snapshot,{requireFenced=false,fixtureDatabase=null}={}) {
  assert.ok(plans.has(plan),'forward_migration_plan_required');
  const {history,fence,scheduler,outstanding}=snapshot;
  const completed=history.migration_count-plan.prefixes[0].migration_count;
  assert.ok(Number.isInteger(completed)&&completed>=0&&completed<plan.prefixes.length,'forward_migration_history_outside_plan');
  assert.deepEqual(history,plan.prefixes[completed],'forward_migration_history_changed');
  const databaseMatches=fixtureDatabase===null
    ?fence.database_name==='postgres'&&fence.synthetic_fixture===false
    :/^collect_archive_[0-9a-f]{24}_test$/.test(fixtureDatabase)&&fence.database_name===fixtureDatabase&&fence.synthetic_fixture===true;
  assert.ok(fence.project_ref===projectRef&&fence.profile_sha256===sha(profile)&&fence.pg_major===17&&databaseMatches&&
    fence.session_role==='postgres'&&fence.current_role==='postgres'&&fence.authority===true&&
    /^[1-9][0-9]*$/.test(fence.epoch)&&/^[a-f0-9-]{36}$/.test(fence.operation_id)&&HASH.test(fence.source_sha256),
  'forward_migration_target_changed');
  assert.ok(Number.isSafeInteger(outstanding)&&outstanding>=0,'forward_migration_work_count_changed');
  if(requireFenced){
    assert.equal(fence.mode,'fenced','forward_migration_fenced_window_required');
    assert.equal(outstanding,0,'forward_migration_work_outstanding');
    requireRevisionSchedulerReady(scheduler);
  }
  const evidence=verifyWriterJournalCatalog(snapshot.catalog,Math.min(completed,4),catalogVerification);
  verifyCleanup(snapshot,completed);
  return {completed,next:plan.entries[completed]?.version??null,capture_sha256:sha(canonical(snapshot)),...evidence};
}

const acquireLocks=`
  PERFORM pg_catalog.set_config('lock_timeout','5s',true);
  PERFORM pg_catalog.set_config('jit','off',true);
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  PERFORM pg_catalog.pg_advisory_xact_lock(7346371,11);
  LOCK TABLE supabase_migrations.schema_migrations IN EXCLUSIVE MODE;
  PERFORM pg_catalog.pg_advisory_xact_lock(7346371,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(7346371,2);`;

function checkedCapture(plan,before,{version,captureSha256,fixtureDatabase}) {
  const evidence=validateForwardMigrationSnapshot(plan,before,{requireFenced:true,fixtureDatabase});
  assert.ok(version===evidence.next&&HASH.test(captureSha256)&&captureSha256===evidence.capture_sha256,
    'forward_migration_capture_or_version_mismatch');
  const entry=plan.entries[evidence.completed];
  const completed=evidence.completed+1,after=structuredClone(before);
  after.history=plan.prefixes[completed];
  after.catalog=expectedWriterJournalCatalog(before.catalog,Math.min(completed,4),catalogVerification);
  if(completed===5) for(const row of after.sms_helpers)row.proconfig=fixedSearchPath;
  if(completed===6) after.scope_indexes=after.scope_indexes.filter(row=>row.name!==duplicateIndex);
  validateForwardMigrationSnapshot(plan,after,{requireFenced:true,fixtureDatabase});
  return {entry,after};
}

function block(sql) {
  return 'DO '+exactLiteral('BEGIN'+acquireLocks+'\n'+sql+'\nEND;','transaction')+';';
}

function compare(snapshot) {
  return '('+snapshotSql+') IS NOT DISTINCT FROM '+exactLiteral(canonical(snapshot),'snapshot')+'::jsonb';
}

export function renderForwardMigrationSql(plan,before,options) {
  const {entry,after}=checkedCapture(plan,before,options);
  const afterBody={...after,history:before.history};
  const sql=block(`
  IF NOT (${compare(before)}) THEN
    RAISE EXCEPTION 'forward_migration_locked_preimage_changed' USING ERRCODE='55000';
  END IF;
  EXECUTE ${exactLiteral(body(entry.sql),'body')};
  PERFORM pg_catalog.set_config('search_path','pg_catalog, pg_temp',true);
  IF NOT (${compare(afterBody)}) THEN
    RAISE EXCEPTION 'forward_migration_body_postcondition' USING ERRCODE='55000';
  END IF;
  INSERT INTO supabase_migrations.schema_migrations (version,name,statements)
    VALUES (${exactLiteral(entry.version,'version')},${exactLiteral(entry.name,'name')},ARRAY[${exactLiteral(entry.sql,'original')}]);
  IF NOT (${compare(after)}) THEN
    RAISE EXCEPTION 'forward_migration_history_postcondition' USING ERRCODE='55000';
  END IF;`);
  return {sql,after,version:entry.version,sql_sha256:entry.sha256};
}

export function renderForwardMigrationReconciliationSql(plan,before,options) {
  const {after}=checkedCapture(plan,before,options);
  return block(`
  IF NOT (${compare(before)}) AND NOT (${compare(after)}) THEN
    RAISE EXCEPTION 'forward_migration_outcome_unrecognized' USING ERRCODE='55000';
  END IF;`);
}
