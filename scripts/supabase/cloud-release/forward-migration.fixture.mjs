// Exercise the one-statement SQL transport in the actual disposable PG17 chain.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareWriterJournalFixture} from './writer-journal-release.fixture.mjs';
import {readWriterJournalCatalog} from './writer-journal-catalog.mjs';
import {runManagedForwardRelease} from './managed-forward-release.mjs';
import {forwardMigrationSnapshotSql,loadForwardMigrationPlan,renderForwardMigrationReconciliationSql,
  renderForwardMigrationSql,validateForwardMigrationSnapshot} from './forward-migration.mjs';

const {Client}=createRequire(import.meta.url)('pg');

export async function verifyForwardMigrationRelease({owner,admin,database}) {
  const {actualSetupCount}=await prepareWriterJournalFixture({owner,admin,database});
  // The immutable catalog body serves as the fast in-transaction proof.
  // Execute its real compiled declaration separately to verify that pin.
  await owner.query('SET jit=off');
  const originalCatalog=await readWriterJournalCatalog(owner,0);
  const plan=await loadForwardMigrationPlan();
  const {host,port}=owner.connectionParameters;
  const witness=new Client({host,port,database,user:'postgres',connectionTimeoutMillis:5000});
  const evidence=await realpath(await mkdtemp(join(tmpdir(),'collect-forward-migration-fixture-')));
  await witness.connect();
  try {
    assert.notEqual((await owner.query('SELECT pg_backend_pid() pid')).rows[0].pid,
      (await witness.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    const fixtureDatabase=database,validate=snapshot=>validateForwardMigrationSnapshot(plan,snapshot,{requireFenced:true,fixtureDatabase});
    const snapshot=async db=>(await db.query(forwardMigrationSnapshotSql())).rows[0].snapshot;
    let reads=0,dispatches=0,interrupt=null;
    const api=async(path,options)=>{
      assert.equal(path,'database/query');
      assert.equal(options.method,'POST');
      const request=JSON.parse(options.body);
      const readOnly=request.query.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
      const applying=request.query.includes("RAISE EXCEPTION 'forward_migration_history_postcondition'");
      if(applying){
        dispatches++;
        if(interrupt==='before')throw Error('synthetic_transport_failed_before_dispatch');
      }
      const client=readOnly&&reads++%2===0?witness:owner;
      const result=await client.query(request.query);
      if(applying&&interrupt==='after')throw Error('synthetic_transport_lost_acknowledgement');
      return {json:()=>readOnly?result.find(item=>item.command==='SELECT').rows:result.rows};
    };
    const run=(action,options)=>runManagedForwardRelease([action,options.version,options.captureSha256,evidence],{api,fixtureDatabase});
    const initial=await snapshot(owner);
    assert.deepEqual(initial,await snapshot(witness));
    assert.equal(validate(initial).completed,0);
    assert.equal(validate(initial).retention_sha256,originalCatalog.retention_sha256);
    assert.throws(()=>validateForwardMigrationSnapshot(plan,initial),/target_changed/);
    const request=(before,version=validate(before).next)=>({version,captureSha256:validate(before).capture_sha256,fixtureDatabase});
    assert.throws(()=>renderForwardMigrationSql(plan,initial,request(initial,plan.entries[1].version)),/capture_or_version_mismatch/);
    const firstOptions=request(initial),first=renderForwardMigrationSql(plan,initial,firstOptions);
    await owner.query(renderForwardMigrationReconciliationSql(plan,initial,firstOptions));
    await owner.query('BEGIN');
    try {
      await owner.query(first.sql);
      assert.deepEqual(await snapshot(owner),first.after);
      assert.deepEqual(await snapshot(witness),initial);
    } finally {await owner.query('ROLLBACK');}
    assert.deepEqual(await snapshot(witness),initial);

    await owner.query("GRANT UPDATE ON private.burimunsi_accounts TO collect_runtime WITH GRANT OPTION");
    await assert.rejects(owner.query(first.sql),{code:'55000',message:'forward_migration_locked_preimage_changed'});
    await owner.query("REVOKE GRANT OPTION FOR UPDATE ON private.burimunsi_accounts FROM collect_runtime");
    assert.deepEqual(await snapshot(witness),initial);

    // Unexpected history normalization must roll back both the recorded SQL
    // and its preceding privilege changes in this same outer statement.
    await owner.query(`CREATE FUNCTION supabase_migrations.fixture_history_drift() RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN NEW.statements:=ARRAY['SELECT 1'];RETURN NEW; END;$fixture$;
      CREATE TRIGGER fixture_history_drift BEFORE INSERT ON supabase_migrations.schema_migrations
      FOR EACH ROW EXECUTE FUNCTION supabase_migrations.fixture_history_drift()`);
    await assert.rejects(owner.query(first.sql),{code:'55000',message:'forward_migration_history_postcondition'});
    await owner.query(`DROP TRIGGER fixture_history_drift ON supabase_migrations.schema_migrations;
      DROP FUNCTION supabase_migrations.fixture_history_drift()`);
    assert.deepEqual(await snapshot(witness),initial);

    const states=[];
    for(const entry of plan.entries){
      const before=await snapshot(witness),options=request(before,entry.version);
      const apply=renderForwardMigrationSql(plan,before,options);
      if(entry===plan.entries[0]){
        interrupt='before';
        await assert.rejects(run('apply',options),/forward_migration_reconcile_required/);
        interrupt=null;
        assert.equal((await run('reconcile',options)).status,'rolled_back');
        assert.equal((await run('retry',options)).status,'applied_and_read_back');
      }else if(entry===plan.entries[1]){
        interrupt='after';
        await assert.rejects(run('apply',options),/forward_migration_reconcile_required/);
        interrupt=null;
        const beforeRetry=dispatches;
        assert.equal((await run('retry',options)).status,'recorded');
        assert.equal(dispatches,beforeRetry,'independent readback resolves lost acknowledgement without replay');
      }else if(entry===plan.entries[2]){
        const both=await Promise.allSettled([owner.query(apply.sql),witness.query(apply.sql)]);
        assert.equal(both.filter(result=>result.status==='fulfilled').length,1);
        const loser=both.find(result=>result.status==='rejected').reason;
        assert.ok(loser.code==='55P03'||loser.code==='55000'&&loser.message==='forward_migration_locked_preimage_changed');
      } else await owner.query(apply.sql);
      const after=await snapshot(witness);
      assert.deepEqual(after,apply.after);
      assert.equal((await witness.query('SELECT statements[1] AS sql FROM supabase_migrations.schema_migrations WHERE version=$1',[entry.version])).rows[0].sql,entry.sql);
      await owner.query(renderForwardMigrationReconciliationSql(plan,before,options));
      await assert.rejects(owner.query(apply.sql),{code:'55000',message:'forward_migration_locked_preimage_changed'});
      states.push({version:entry.version,sql_sha256:entry.sha256,history:after.history});
    }
    assert.equal(validate(await snapshot(witness)).next,null);
    assert.equal((await admin.query('SELECT count(*)::int n FROM supabase_migrations.fixture_executed_chain')).rows[0].n,actualSetupCount);
    return {status:'synthetic_forward_migration_transaction_verified',states,
      checks:['exact_locked_preimage','explicit_rollback','post_history_drift_rollback',
        'concurrent_once','pinned_original_sql_bytes','separate_postcommit_readback','reconciliation_before_and_after',
        'managed_driver_retry_after_proven_rollback','managed_driver_lost_ack_readback_without_replay'],
      synthetic:true,productionDispatch:false};
  } finally {
    try {await witness.end();} finally {await rm(evidence,{recursive:true,force:true});}
  }
}
