// Extend the managed import-lineage fixture with live jobs admissions and competing writers.
// The base fixture supplies two ordinary candidates and immutable historical transfers.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyIdleNativeJobs({owner,root,read:readFile,extract}) {
  const migration = name => readFile('supabase/migrations/'+name);
  const base = await migration('20261022195747_collect_application_mutation_fence.sql');
  const native = await migration('20261112200100_burimunsi_native_auto_transactions.sql');
  const posting = await migration('20261122180000_burimunsi_internal_query_performance.sql');
  const setup = await migration('20261110052756_burimunsi_dynamic_scope_setup.sql');
  const source = 'a'.repeat(64), jobs = randomUUID(), browser = randomUUID();
  await owner.query(`ALTER TABLE private.collect_fence_control ADD COLUMN epoch bigint DEFAULT 1, ADD COLUMN source_sha256 text;
    ALTER TABLE private.collect_fence_admissions ADD COLUMN admission_id uuid UNIQUE, ADD COLUMN epoch bigint DEFAULT 1,
      ADD COLUMN source_sha256 text, ADD COLUMN state text DEFAULT 'active'`);
  for(const fn of ['_collect_fence_require_runtime','_collect_fence_require_rc','_collect_fence_admission','collect_fence_assert_write'])
    await owner.query(extract(base,fn));
  for(const [sql,name] of [[setup,'burimunsi_setup_fence'],[native,'burimunsi_auto_jobs_guard'],
    [native,'burimunsi_auto_collections'],[posting,'burimunsi_native_sms_post_candidates']]) {
    await owner.query(extract(sql,name).replace(/^CREATE FUNCTION/,'CREATE OR REPLACE FUNCTION'));
  }
  await owner.query(`ALTER TABLE private.burimunsi_unresolved_observations ADD COLUMN consent_generation bigint DEFAULT 1;
    ALTER TABLE private.burimunsi_observation_consents ADD COLUMN generation bigint DEFAULT 1;
    CREATE TABLE private.burimunsi_held_observation_sources(source_id text PRIMARY KEY)`);
  await owner.query(extract(await migration('20261122191000_burimunsi_sms_completeness.sql'),'_burimunsi_observation_automatable'));
  const previous=(await owner.query("SELECT pg_get_functiondef('private.burimunsi_auto_candidates(text)'::regprocedure) AS def")).rows[0].def;
  const marker=' WHERE NOT private.collect_imported_native_source(o.source_id)';
  assert.equal(previous.split(marker).length,2);
  await owner.query(previous.replace(marker,' WHERE private._burimunsi_observation_automatable(o.source_id) AND NOT private.collect_imported_native_source(o.source_id)'));
  const install=(await migration('20261124091329_burimunsi_idle_native_jobs.sql')).trimEnd();
  assert.ok(install.endsWith('COMMIT;'));
  // Pause immediately before the actual final commit to inspect the installer's
  // deployment locks and independently attempt to change the same control row.
  await owner.query(install.slice(0,-'COMMIT;'.length));
  try {
    const {rows}=await owner.query(`SELECT objid::integer AS key FROM pg_locks
      WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=7346371 AND objsubid=2
        AND mode='ExclusiveLock' AND granted AND objid IN (1,2) ORDER BY objid`);
    assert.deepEqual(rows,[{key:1},{key:2}]);
    await assert.rejects(()=>root.query('SELECT 1 FROM private.collect_fence_control FOR UPDATE NOWAIT'),{code:'55P03'});
    await owner.query('COMMIT');
  } catch(error) { await owner.query('ROLLBACK');throw error; }
  await owner.query("UPDATE private.collect_fence_control SET mode='open',source_sha256=$1",[source]);
  await owner.query("INSERT INTO private.collect_fence_admissions(kind,admission_id,source_sha256) VALUES ('jobs',$1,$3),('http_collect',$2,$3)",[jobs,browser,source]);
  const selector = (lane,limit) => owner.query('SELECT private.burimunsi_native_job_candidates($1,$2) AS rows',[lane,limit]).then(r=>r.rows[0].rows);
  const original = (lane,limit) => owner.query(lane==='parse'
    ? 'SELECT private.burimunsi_auto_collections($1) AS rows' : 'SELECT private.burimunsi_native_sms_post_candidates($1) AS rows',[limit]).then(r=>r.rows[0].rows);
  async function frame(work,{id=jobs,epoch='1',hash=source,begin='BEGIN',role='collect_runtime',limit='150ms'}={}) {
    await owner.query(begin);
    try {
      await owner.query('SET LOCAL ROLE '+role);
      await owner.query(`SELECT set_config('collect.edge_verified','true',true),set_config('collect.fence_admission_id',$1,true),
        set_config('collect.fence_epoch',$2,true),set_config('collect.fence_source_sha256',$3,true),set_config('lock_timeout',$4,true),
        set_config('burimunsi.observation_frame','prior-obs',true),set_config('burimunsi.native_receipt_frame','prior-job',true)`,[id,epoch,hash,limit]);
      return await work();
    } finally { await owner.query('ROLLBACK'); }
  }
  const read = (lane,limit=1,options) => frame(()=>selector(lane,limit),options);
  const lock = async () => {
    await root.query('BEGIN');
    await root.query('SELECT pg_advisory_xact_lock(734636924058501::bigint)');
  };
  const readBoth = async () => [await read('parse'),await read('post',4)];
  const first = await frame(async()=>{
    const a=await selector('parse',1), b=await selector('post',4);
    assert.deepEqual(a,await original('parse',1));assert.deepEqual(b,await original('post',4));
    assert.deepEqual((await owner.query("SELECT current_setting('burimunsi.observation_frame') a,current_setting('burimunsi.native_receipt_frame') b")).rows,
      [{a:'prior-obs',b:'prior-job'}]);
    return [a,b];
  });
  assert.deepEqual(first,[['g'],[{groupId:'g',sourceId:'post-new',needsFacts:true}]]);
  const acl=(await root.query(`SELECT role,has_function_privilege(role,'private.burimunsi_native_job_candidates(text,integer)','EXECUTE') allowed
    FROM unnest(ARRAY['anon','authenticated','service_role','collect_importer','collect_runtime']) AS roles(role)`)).rows;
  assert.deepEqual(acl.filter(row=>row.allowed).map(row=>row.role),['collect_runtime']);
  await root.query(`INSERT INTO app.momo_transactions VALUES('tx-order-b','incoming_receipt',0,'unallocated'),('tx-order-a','incoming_receipt',0,'unallocated');
    INSERT INTO private.burimunsi_auto_sms_jobs(source_id,collection_id,state,relation,transaction_id,posting_next_attempt_at,posting_facts,created_at)
    VALUES('order-b','g','completed','accepted','tx-order-b',0,NULL,1),
          ('order-a','g','completed','accepted','tx-order-a',0,'{"event_kind":"incoming_receipt"}',1)`);
  await frame(async()=>{
    const ordered=await selector('post',4);
    assert.deepEqual(ordered,await original('post',4));
    assert.deepEqual(ordered.map(row=>[row.sourceId,row.needsFacts]),[['order-a',false],['order-b',true],['post-new',true]]);
    assert.deepEqual(await selector('post',1),[{groupId:'g',sourceId:'order-a'}]);
  });
  await root.query("UPDATE app.momo_transactions SET has_conflict=1 WHERE id IN('tx-order-a','tx-order-b')");

  await lock();
  try {
    await assert.rejects(()=>read('parse'),{code:'55P03'});
    await assert.rejects(()=>read('post',4),{code:'55P03'});
  } finally { await root.query('ROLLBACK'); }
  // The old selector obtains the exclusive mutex, then rereads up-to-date
  // state in READ COMMITTED. A positive hint must retain that ordering.
  await lock();
  let waiting;
  try {
    const pid=(await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    waiting=read('post',4,{limit:'5s'});
    let blocked=false;
    for(let attempt=0;attempt<1000&&!blocked;attempt++){
      const result=await root.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked',[pid]);
      blocked=result.rows[0].blocked;
      if(!blocked)await new Promise(resolve=>setTimeout(resolve,2));
    }
    assert.ok(blocked,'positive selection did not wait for the original mutation lock');
    await root.query("UPDATE app.momo_transactions SET has_conflict=1 WHERE id='tx-new'");
    await root.query('COMMIT');
    assert.deepEqual(await waiting,[]);
  } finally { await root.query('ROLLBACK'); if(waiting) await waiting.catch(()=>{}); }
  await root.query("UPDATE app.momo_transactions SET has_conflict=0 WHERE id='tx-new'");
  for(const lane of ['parse','post']){
    await assert.rejects(()=>read(lane,1,{id:browser}),{code:'42501'});
    await assert.rejects(()=>read(lane,1,{epoch:'2'}),{code:'55000'});
    await assert.rejects(()=>read(lane,1,{hash:'b'.repeat(64)}),{code:'55000'});
    await assert.rejects(()=>read(lane,1,{id:randomUUID()}),{code:'55000'});
    await assert.rejects(()=>read(lane,1,{begin:'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'}),{code:'55000'});
  }
  await assert.rejects(()=>read('parse',2),{code:'22023'});
  await assert.rejects(()=>read('post',5),{code:'22023'});
  await assert.rejects(()=>read('unexpected',1),{code:'22023'});
  await assert.rejects(()=>read('post',1,{role:'anon'}),{code:'42501'});

  // Make ordinary candidates terminal and prove the imported source/transaction
  // aliases cannot generate a new credit. A completed link is never selected again.
  await root.query("UPDATE private.burimunsi_auto_sms_jobs SET state='failed' WHERE source_id='auto-new'");
  await root.query("INSERT INTO app.momo_financial_links VALUES('tx-new','posted-new')");
  // The older fixture also contains an imported transaction under another source ID.
  assert.deepEqual(await readBoth(),[[],[]]);
  await assert.rejects(()=>read('parse',1,{id:browser}),{code:'42501'});
  await assert.rejects(()=>read('post',4,{epoch:'2'}),{code:'55000'});
  await lock();
  try {
    // The save and its matching post become visible at the next committed snapshot.
    // These two inserts represent a native observation and an independently parsed job.
    await root.query(`INSERT INTO private.burimunsi_unresolved_observations
      (source_id,collection_id,account_id,principal_user_id,grant_id,installation_id,grant_version,fingerprint,
       profile_sha256,created_at,object_key,object_sha256,profile_version,profile_tuple_sha256)
      SELECT 'after-idle',collection_id,account_id,principal_user_id,grant_id,installation_id,grant_version,fingerprint,
        profile_sha256,3,object_key,object_sha256,profile_version,profile_tuple_sha256
        FROM private.burimunsi_unresolved_observations WHERE source_id='auto-new';
      INSERT INTO app.momo_transactions VALUES('tx-after-idle','incoming_receipt',0,'unallocated');
      INSERT INTO private.burimunsi_auto_sms_jobs(source_id,collection_id,state,relation,transaction_id,posting_next_attempt_at,created_at)
        VALUES('post-after-idle','g','completed','accepted','tx-after-idle',0,3)`);
    assert.deepEqual(await readBoth(),[[],[]]);
    await root.query('COMMIT');
  } catch(error){await root.query('ROLLBACK');throw error;}
  assert.deepEqual(await readBoth(),[['g'],[{groupId:'g',sourceId:'post-after-idle',needsFacts:true}]]);
  // Held and future-due inputs do not contend with eligible work. Clearing
  // the hold makes the same still-unclaimed source eligible again.
  await root.query("INSERT INTO private.burimunsi_held_observation_sources VALUES('after-idle')");
  await lock();
  try { assert.deepEqual(await read('parse'),[]); }
  finally { await root.query('ROLLBACK'); }
  await root.query("DELETE FROM private.burimunsi_held_observation_sources WHERE source_id='after-idle'");
  assert.deepEqual(await read('parse'),['g']);
  await root.query("UPDATE private.burimunsi_observation_consents SET enabled=false");
  assert.deepEqual(await read('parse'),[]);
  await root.query("UPDATE private.burimunsi_auto_sms_jobs SET posting_next_attempt_at=9223372036854775807 WHERE source_id='post-after-idle'");
  await lock();
  try { assert.deepEqual(await read('post',4),[]); }
  finally { await root.query('ROLLBACK'); }
  await root.query("UPDATE private.collect_fence_admissions SET state='settled' WHERE admission_id=$1",[jobs]);
  await assert.rejects(()=>read('post'),{code:'55000'});
  console.log('PASS native job candidate parity, bounded limits, held positive candidates, held installation locks, original authority, restored transaction settings, next committed queue visibility and settled work refusal');
}
