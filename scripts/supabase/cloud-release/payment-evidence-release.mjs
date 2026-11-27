import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {connect,PROJECT} from './access.mjs';
import {applyEntry,hash,history,identity,SOURCE} from './migrations.mjs';
import {historyDigest,readRecordedHistory} from './recorded-history.mjs';
import {privateDirectory,readPrivateFile} from '../current-archive/bundle.mjs';
import {canonical} from '../current-archive/codec.mjs';
import {assertCleanEnvironment} from '../managed-cloud-migrations/operator-core.mjs';
import {writeReleaseEvidence} from './write-release-evidence.mjs';

const latest='20261126170200';
const baselineDigest='b23a11e79ae226be50b3f7450b02652e0075f09a4ee6f41426b3b8011e53a441';
const migration='20261127222536_burimunsi_payment_evidence_and_listing.sql';
const sourceDigest='662e65777a609d99af6fe02e70c2fb7e82a72f4ae21e03615d665d0d73ed8685';
const directory=join(SOURCE,'supabase/migrations');
const format='burimunsi.payment-evidence-release.v1';

export async function loadPaymentEvidencePlan(){
  const {record}=await readRecordedHistory('cloud-history-20261120-epoch44.json');
  const before=record.history.map(({version,name,sha256,entries})=>({version,name,sha256,entries}));
  for(const name of (await readdir(directory)).sort()){
    if(!/^\d{14}_.+\.sql$/.test(name)||name.slice(0,14)<=record.history.at(-1).version||name.slice(0,14)>latest)continue;
    const {version,name:label,sha256}=identity(name,await readFile(join(directory,name),'utf8'));
    before.push({version,name:label,sha256,entries:1});
  }
  assert.equal(before.length,128);assert.equal(before.at(-1).version,latest);
  assert.equal(historyDigest(before),baselineDigest,'payment_release_predecessor_source_changed');
  const entry=identity(migration,await readFile(join(directory,migration),'utf8'));
  assert.equal(entry.sha256,sourceDigest,'payment_release_source_changed');
  const after=[...before,{version:entry.version,name:entry.name,sha256:entry.sha256,entries:1}];
  return {entry,before,after,summary:{format,project:PROJECT,baselineCount:before.length,baselineLatest:latest,
    baselineDigest,version:entry.version,sourceDigest,successorCount:after.length,successorDigest:historyDigest(after)}};
}

const protectedTables=['burimunsi.payments','burimunsi.raw_sms','private.burimunsi_auto_sms_jobs','private.burimunsi_allocation_receipts'];
const digestRows=(table,fields,order)=>`(SELECT encode(sha256(coalesce(string_agg(sha256(convert_to(jsonb_build_array(${fields})::text,'UTF8')),
  ''::bytea ORDER BY ${order} COLLATE "C"),''::bytea)),'hex') FROM ${table})`;
async function protectedSnapshot(db){
  const grants=(await db.query(`SELECT c.oid::regclass::text AS relation,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl,
    c.relrowsecurity,c.relforcerowsecurity,row_security_active(c.oid) AS partial,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AS columns
    FROM unnest($1::text[]) AS scope(name) JOIN pg_class c ON c.oid=to_regclass(scope.name) ORDER BY scope.name COLLATE "C"`,[protectedTables])).rows;
  assert.ok(grants.length===protectedTables.length&&grants.every(row=>row.partial===false),'payment_release_custody_visibility_required');
  const custody=(await db.query(`SELECT
    ${digestRows('burimunsi.payments p','to_jsonb(p)','p.id')} AS payments,
    ${digestRows('burimunsi.raw_sms r',"r.id,r.collection_id,r.object_sha256,encode(sha256(r.ciphertext),'hex')",'r.id')} AS originals,
    ${digestRows('private.burimunsi_auto_sms_jobs j','j.source_id,j.collection_id,j.receiving_account_id,j.state,j.relation,j.attempt_id,j.facts_sha256,j.payment_id,j.transaction_id','j.source_id')} AS evidence,
    ${digestRows('private.burimunsi_allocation_receipts d','to_jsonb(d)','d.payment_id')} AS confirmations`)).rows[0];
  const protections=(await db.query(`SELECT pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl,p.prosecdef,p.proconfig
    FROM pg_proc p WHERE p.oid='private._burimunsi_allocation_contact(text,text)'::regprocedure`)).rows[0];
  return {grants:hash(canonical({grants,protections})),custody:hash(canonical(custody))};
}
async function witness(db,plan){
  const installed=await history(db);
  const previous=installed.length===plan.before.length;
  assert.deepEqual(installed,previous?plan.before:plan.after,'payment_release_history_changed');
  const [target]=(await db.query(`SELECT f.project_ref AS project,f.mode,f.epoch::text AS epoch,f.source_sha256 AS source,
    session_user::text AS login,current_user::text AS actor,current_setting('server_version_num')::int/10000 AS major,
    pg_backend_pid() AS pid FROM private.collect_fence_control f WHERE singleton`)).rows;
  assert.ok(target?.project===PROJECT&&target.major===17&&target.actor==='postgres'&&target.login==='postgres','payment_release_wrong_target');
  const protectedState=await protectedSnapshot(db);
  if(!previous)await checkInstalled(db);
  const {pid,...frame}=target;
  const proof={...frame,phase:previous?'predecessor':'successor',ledger:historyDigest(installed),
    sourceDigest,...protectedState};
  return {pid,proof,fingerprint:hash(canonical(proof))};
}

export async function checkInstalled(db){
  const bodies={
    'private._burimunsi_hold_conflicting_payment()':'b3713e6a561becac44b6c6bf5e6710085d9150a18be07e2619088a1ee4809805',
    'private._burimunsi_guard_payment_allocation()':'18afa3a5504732b40238d9f5de54ff7ea47fa4efda7fb80f59e5187cd4102427',
    'private._burimunsi_allocation_contact(text,text)':'e25f8edb814ef69225e437045a198445d329183dd382ca7320c44fb90766430a',
    'burimunsi.payment_search_text(text)':'5ebc00f1e748cd4d494be4f6f507441a5bc8f2488462fd088f261ad73fcae6f7',
  };
  const routines=(await db.query(`SELECT expected.name,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source
    FROM unnest($1::text[]) expected(name) JOIN pg_proc p ON p.oid=to_regprocedure(expected.name)
    WHERE p.proowner='postgres'::regrole AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']`,[Object.keys(bodies)])).rows;
  assert.deepEqual(Object.fromEntries(routines.map(row=>[row.name,row.source])),bodies,'payment_release_routine_changed');
  const [guard]=(await db.query(`SELECT
    c.relrowsecurity AND c.relforcerowsecurity AND c.relowner='postgres'::regrole AS rls,
    has_table_privilege('collect_runtime',c.oid,'SELECT') AND NOT has_table_privilege('collect_runtime',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS runtime,
    NOT EXISTS(SELECT FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role','collect_importer','collect_sms_runtime') AND
      (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
       OR has_function_privilege(r.oid,'private._burimunsi_guard_payment_allocation()','EXECUTE')
       OR has_function_privilege(r.oid,'private._burimunsi_hold_conflicting_payment()','EXECUTE'))) AS private,
    NOT has_function_privilege('collect_runtime','private._burimunsi_guard_payment_allocation()','EXECUTE')
      AND NOT has_function_privilege('collect_runtime','private._burimunsi_hold_conflicting_payment()','EXECUTE') AS triggers_private,
    (SELECT count(*)=3 FROM pg_trigger t WHERE t.tgenabled='A' AND (t.tgrelid,t.tgname::text,t.tgfoid) IN (
      ('burimunsi.payments'::regclass,'burimunsi_guard_payment_allocation','private._burimunsi_guard_payment_allocation()'::regprocedure),
      ('private.burimunsi_auto_sms_jobs'::regclass,'burimunsi_hold_conflicting_payment','private._burimunsi_hold_conflicting_payment()'::regprocedure),
      (c.oid,'collect_fence_statement_v1','private._collect_fence_statement()'::regprocedure))) AS enabled,
    to_regcollation('burimunsi.payment_analysis_order') IS NOT NULL AND has_function_privilege('collect_runtime','burimunsi.payment_search_text(text)','EXECUTE') AS listing
    FROM pg_class c WHERE c.oid='burimunsi.payment_evidence_holds'::regclass`)).rows;
  assert.ok(guard&&Object.values(guard).every(value=>value===true),'payment_release_postcondition_changed');
}

async function read(db,plan){
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{await db.query("SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO,YMD'");return await witness(db,plan);}finally{await db.query('ROLLBACK');}
}
const sameCustody=(prior,now)=>assert.ok(now.grants===prior.grants&&now.custody===prior.custody,'payment_release_custody_or_grants_changed');

export async function runPaymentEvidenceRelease(args,{open=connect}={}){
  const [action,preimage,path]=args,plan=await loadPaymentEvidencePlan();
  if(action==='plan'&&args.length===1)return plan.summary;
  assert.ok(action==='inspect'&&args.length===1||['apply','reconcile'].includes(action)&&args.length===3&&/^[a-f0-9]{64}$/.test(preimage)&&isAbsolute(path),
    'usage: apply.mjs --payment-evidence {plan|inspect|apply PREIMAGE PRIVATE_DIRECTORY|reconcile PREIMAGE PRIVATE_DIRECTORY}');
  assertCleanEnvironment(process.env);
  const db=await open();let peer;
  try{
    const first=await read(db,plan);
    if(action==='inspect')return {status:'observed',...first};
    const dest=await privateDirectory(path),file=plan.entry.version+'-intent.json';
    if(action==='reconcile'){
      const intent=JSON.parse(await readPrivateFile(join(dest,file),32768));
      assert.equal(intent.fingerprint,preimage);assert.equal(intent.proof.sourceDigest,sourceDigest);
      assert.equal(hash(canonical(intent.proof)),preimage);
      if(first.proof.phase==='predecessor')assert.equal(first.fingerprint,preimage);
      else sameCustody(intent.proof,first.proof);
    }else{
      assert.ok(first.fingerprint===preimage&&first.proof.phase==='predecessor'&&first.proof.mode==='fenced','payment_release_preimage_changed');
      await writeReleaseEvidence(dest,file,first);
      await applyEntry(db,plan.entry,{before:plan.before,
        beforeBody:async tx=>{
          await tx.query("SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO,YMD'");
          assert.equal((await witness(tx,plan)).fingerprint,preimage,'payment_release_preimage_changed');
        },afterBody:async tx=>{await checkInstalled(tx);sameCustody(first.proof,await protectedSnapshot(tx));}});
    }
    peer=await open();
    const independent=await read(peer,plan);
    assert.notEqual(first.pid,independent.pid,'payment_release_independent_session_required');
    sameCustody(first.proof,independent.proof);
    for(const key of ['project','source','epoch','mode'])assert.equal(independent.proof[key],first.proof[key],'payment_release_fence_changed');
    if(action==='apply')assert.equal(independent.proof.phase,'successor');
    else assert.equal(independent.fingerprint,first.fingerprint,'payment_release_readback_changed');
    const result={status:independent.proof.phase==='successor'?'recorded_and_verified':'predecessor_verified',preimage,...independent};
    await writeReleaseEvidence(dest,plan.entry.version+'-'+action+'-'+result.fingerprint+'.json',result);
    return result;
  }finally{try{await peer?.end();}finally{await db.end();}}
}
