// Use actual managed schema defaults in the disposable database. The source
// rows are rolled back before exercising the import and its postimage checks.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {GRAPH} from './compile.mjs';
import {TARGET_CATALOGUE_SQL} from './graph-catalogue.mjs';
import {insertGraph,verifyGraph} from './graph-transaction.mjs';
import {rehearseManagedShapeMaintenance} from './maintenance.mjs';

async function captureSyntheticGraph(db){
 const tables=Object.fromEntries(GRAPH.map(name=>[name,[]]));
 const {rows:[catalog]}=await db.query(TARGET_CATALOGUE_SQL);
 if(!catalog||Number(catalog.missing)!==0)throw Error('synthetic_graph_catalogue_incomplete');
 const at='2026-01-01T00:00:00.000Z',sourceOwnerId='synthetic-original-owner',group='synthetic-recovery-group',wallet='synthetic-wallet';
 await db.query('SAVEPOINT collect_synthetic_source');
 try{
  tables['app.users']=(await db.query(`INSERT INTO app.users AS record(id,public_id,created_at,updated_at)
   VALUES($1,'123456',$2,$2) RETURNING to_jsonb(record) AS value`,[sourceOwnerId,at])).rows.map(r=>r.value);
  tables['app.collections']=(await db.query(`INSERT INTO app.collections AS record(id,slug,creator_user_id,title,collection_type,created_at,updated_at)
   VALUES($1,$1,$2,'Synthetic recovery group','community',$3,$3) RETURNING to_jsonb(record) AS value`,[group,sourceOwnerId,at])).rows.map(r=>r.value);
  tables['app.momo_receiving_accounts']=(await db.query(`INSERT INTO app.momo_receiving_accounts AS record(id,provider,public_code,recipient_name,receiver_hash,timezone,created_at)
   VALUES($1,'mtn_momo','123456','Synthetic receiver',$2,'Africa/Kigali',$3) RETURNING to_jsonb(record) AS value`,[wallet,'c'.repeat(64),at])).rows.map(r=>r.value);
  await db.query("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
  tables['private.burimunsi_scopes']=(await db.query(`INSERT INTO private.burimunsi_scopes AS record(collection_id,receiving_account_id,created_at)
   VALUES($1,$2,1) RETURNING to_jsonb(record) AS value`,[group,wallet])).rows.map(r=>r.value);
  tables['private.burimunsi_accounts']=(await db.query(`INSERT INTO private.burimunsi_accounts AS record
   (id,collection_id,principal_user_id,phone,name,role,capabilities,pin_hash,active,created_at,updated_at)
   VALUES($1,$2,$3,'+250780000001','Synthetic original owner','admin',ARRAY['records.read'],'{}',false,1,1)
   RETURNING to_jsonb(record) AS value`,[randomUUID(),group,sourceOwnerId])).rows.map(r=>r.value);
 }finally{await db.query('ROLLBACK TO SAVEPOINT collect_synthetic_source');await db.query('RELEASE SAVEPOINT collect_synthetic_source');}
 return {snapshot:{tables},sourceCatalog:catalog.catalogue,sourceOwnerId};
}

async function rehearseGraph(owner, verify){
 const key=randomBytes(32),operationId=randomUUID(),proofHmac='b'.repeat(64);
 const fence=(await owner.query('SELECT operation_id::text,epoch::text,source_sha256 FROM private.collect_fence_control WHERE singleton')).rows[0];
 let capture,inserted;
 try{
  await rehearseManagedShapeMaintenance(owner,{operationId,fenceOperationId:fence.operation_id,epoch:fence.epoch,sourceSha256:fence.source_sha256},
   async db=>{capture=await captureSyntheticGraph(db);inserted=await insertGraph(db,{capture,key,operationId,cloudPrimaryId:'synthetic-primary',proof:{},proofHmac});},
   async db=>verify(db,{capture,key,operationId,proofHmac,inserted}));
  return {commands:inserted.plan.summary.commandCount,objects:inserted.counts.objects,sms:inserted.counts.sms};
 }finally{key.fill(0);}
}


export function exerciseManagedChainGraph(owner){
 return rehearseGraph(owner,verifyGraph);
}

const checkedRelations=[...GRAPH,'private.burimunsi_native_financial_work',
 'private.storage_namespace','private.collect_fence_control','private.collect_fence_admissions',
 'private.collect_migration_actor_lineage','private.collect_imported_native_history',
 'private.collect_migration_import_receipts','supabase_migrations.schema_migrations'];

// Privileged readback is confined to the owned, synthetic-only test database.
// Compare in memory; never emit row values, policies or function definitions.
async function readRollbackState(db){
 const identity=(await db.query(`SELECT pg_backend_pid() pid,current_database() name,
  inet_server_addr() IS NULL socket,current_setting('cluster_name') cluster`)).rows[0];
 if(!identity.socket||identity.cluster!=='collect_archive_next_fixture'||
    !/^collect_archive_[a-f0-9]{24}_test$/.test(identity.name))throw Error('rollback_readback_fixture_required');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  const relations={};
  for(const name of checkedRelations){
   const shape=(await db.query(`SELECT c.relrowsecurity rls,c.relforcerowsecurity forced,
    c.relacl::text acl,pg_get_userbyid(c.relowner) owner,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid) policies,
    (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname)
     FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers
    FROM pg_class c WHERE c.oid=to_regclass($1)`,[name])).rows[0];
   if(!shape){relations[name]=null;continue;}
   const quoted=name.split('.').map(part=>'"'+part+'"').join('.');
   const {rows}=await db.query(`SELECT to_jsonb(r)::text AS value FROM ONLY ${quoted} r ORDER BY to_jsonb(r)::text COLLATE "C" LIMIT 257`);
   if(rows.length>256)throw Error('rollback_readback_row_limit');
   relations[name]={shape,rows};
  }
  const {rows:functions}=await db.query(`SELECT p.oid::regprocedure::text signature,
   pg_get_functiondef(p.oid) definition,p.proacl::text acl,pg_get_userbyid(p.proowner) owner
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('app','private') AND p.prokind='f' ORDER BY 1`);
  return {identity,state:{relations,functions}};
 }finally{await db.query('ROLLBACK');}
}

async function assertStateRestored(owner,baseline,openObserver){
 const {identity:beforeObserver,state:before}=baseline;
 const {rows:[{pid:writerPid}]}=await owner.query('SELECT pg_backend_pid() pid');
 const {identity:afterObserver,state:after}=await readRollbackState(await openObserver());
 if(afterObserver.name!==beforeObserver.name||[beforeObserver.pid,writerPid].includes(afterObserver.pid))
  throw Error('rollback_independent_observer_required');
 for(const name of checkedRelations){
  if(JSON.stringify(before.relations[name])!==JSON.stringify(after.relations[name]))
   throw Error('rollback_relation_postimage_changed:'+name);
 }
 if(JSON.stringify(before.functions)!==JSON.stringify(after.functions))throw Error('rollback_functions_postimage_changed');
}

export async function exercisePartialChainRefusal(owner,baselineObserver,openObserver){
 const baseline=await readRollbackState(baselineObserver);
 await assert.rejects(exerciseManagedChainGraph(owner),e=>e.code==='55000'&&
  e.message==='import_retention_preimage_changed'&&e.outcome==='rolled_back');
 await assertStateRestored(owner,baseline,openObserver);
}

export async function exerciseManagedChainRollback(owner,baselineObserver,openObserver){
 const baseline=await readRollbackState(baselineObserver);
 let writesVerified=false;
 await assert.rejects(rehearseGraph(owner,async(db,expected)=>{
  if(expected.inserted.counts.commands!==6||await verifyGraph(db,expected)!==true)throw Error('rollback_positive_postimage_missing');
  const {rows:[{active}]}=await db.query(`SELECT EXISTS(
   SELECT 1 FROM pg_policy WHERE polname='collect_transfer_maintenance'
    AND polrelid=to_regclass('private.burimunsi_accounts')) active`);
  if(!active)throw Error('rollback_maintenance_policy_not_exercised');
  writesVerified=true;
  // Deliberately give the real postimage verifier the wrong expectation in
  // memory, after it proved graph, actor lineage and receipt writes exist.
  // No test mutation to the receipt itself and no production path changes.
  return verifyGraph(db,{...expected,proofHmac:'a'.repeat(64)});
 }),e=>e.message==='import_receipt_postimage_mismatch'&&e.outcome==='rolled_back',
 'Late receipt verification failure must confirm pre-commit rollback');
 if(!writesVerified)throw Error('rollback_positive_postimage_not_exercised');
 await assertStateRestored(owner,baseline,openObserver);
}
