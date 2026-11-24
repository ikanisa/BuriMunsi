import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function verifyRefusalRaces({db, independent, observer, source}) {
  const reply = JSON.stringify({code:'application_fence_unavailable', message:'The application is temporarily unavailable.'});
  const digest = createHash('sha256').update(reply).digest('hex');
  const {rows:[{pid:claimPid}]} = await db.query('SELECT pg_backend_pid() pid');
  const {rows:[{pid:reviewPid}]} = await independent.query('SELECT pg_backend_pid() pid');
  async function blocked(pid, blocker) {
    const until = performance.now() + 2000;
    while (performance.now()<until) {
      const result = await observer.query('SELECT $1::int = ANY(pg_blocking_pids($2)) AS waiting', [blocker,pid]);
      if (result.rows[0].waiting) return;
      await delay(10);
    }
    throw Error('concurrent_scheduler_operation_did_not_wait_for_original');
  }
  async function refusal(useWake) {
    const {rows:[{job}]} = useWake
      ? await independent.query('SELECT collect_ops.tick_jobs() job')
      : await independent.query("SELECT collect_ops.dispatch_jobs('scheduled',$1) job",[randomUUID()]);
    assert.equal(job.state,'awaiting');
    assert.ok(!job.replayed);
    const {rows:[envelope]} = await independent.query(`DELETE FROM net.http_request_queue WHERE id=$1
      RETURNING convert_from(body,'UTF8')::jsonb payload,substr(headers->>'Authorization',8) proof`,[job.net_request_id]);
    await independent.query('INSERT INTO net._http_response(id,status_code,content) VALUES($1,503,$2)',[job.net_request_id,reply]);
    return {id:job.dispatch_id, ...envelope};
  }
  async function beginClaim() {
    const admission = randomUUID();
    await db.query("INSERT INTO private.collect_fence_admissions VALUES($1,1,$2,'jobs','active')",[admission,source]);
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE collect_runtime');
    await db.query(`SELECT set_config('collect.edge_verified','true',true),set_config('collect.fence_admission_id',$1,true),
      set_config('collect.fence_epoch','1',true),set_config('collect.fence_source_sha256',$2,true)`,[admission,source]);
  }
  const claim = job => db.query('SELECT private.collect_managed_job_claim($1,$2,$3,$4) AS accepted',
    [job.id,source,job.payload,job.proof]);
  const reconcile = () => independent.query('SELECT collect_ops.reconcile_jobs() outcome');
  const journal = async id => (await independent.query(`SELECT d.state,d.reason,d.http_status,d.response_sha256,
    d.resolution_evidence_sha256 IS NOT NULL AS witnessed,t.claimed_at IS NOT NULL AS claimed,t.native_provider_calls,
    c.enabled FROM collect_ops.jobs_dispatches d JOIN private.collect_managed_job_tickets t ON t.dispatch_id=d.id
    CROSS JOIN collect_ops.jobs_config c WHERE d.id=$1`,[id])).rows[0];

  await delay(1050); // The scheduler issues at most one fresh dispatch per wall-clock second.
  const first = await refusal(false);
  await beginClaim();
  await independent.query('BEGIN');
  try {
    assert.deepEqual((await reconcile()).rows[0].outcome,{observed:1,unconfirmed:0});
    const lateClaim = claim(first);
    await blocked(claimPid,reviewPid);
    await independent.query('COMMIT');
    assert.equal((await lateClaim).rows[0].accepted,false);
  } finally {
    await independent.query('ROLLBACK');
    await db.query('ROLLBACK');
  }
  assert.deepEqual(await journal(first.id),{state:'rejected',reason:'admission_refused_before_claim',http_status:503,
    response_sha256:digest,witnessed:true,claimed:false,native_provider_calls:0,enabled:true});
  const due = async id => (await independent.query(`SELECT round(extract(epoch FROM (w.due_at-d.observed_at)))::int AS seconds
    FROM private.burimunsi_sms_wakes w JOIN collect_ops.jobs_dispatches d ON d.id=$1 WHERE w.wake_class=1`,[id])).rows;
  assert.deepEqual(await due(first.id),[{seconds:1}]);
  await delay(1050);
  const second = await refusal(true);
  assert.notEqual(second.id,first.id);
  assert.deepEqual((await reconcile()).rows[0].outcome,{observed:1,unconfirmed:0});
  assert.deepEqual(await due(second.id),[{seconds:2}]);

  // The opposite lock order represents a real claimed worker and ambiguous
  // transport. A 503 in this case must still pause subsequent work.
  await delay(2050);
  const third = await refusal(true);
  await beginClaim();
  try {
    assert.equal((await claim(third)).rows[0].accepted,true);
    const readWhileClaimed = reconcile();
    await blocked(reviewPid,claimPid);
    await db.query('COMMIT');
    assert.deepEqual((await readWhileClaimed).rows[0].outcome,{observed:1,unconfirmed:1});
  } finally {
    await db.query('ROLLBACK');
  }
  assert.deepEqual(await journal(third.id),{state:'unconfirmed',reason:'reply_unconfirmed',http_status:503,
    response_sha256:digest,witnessed:false,claimed:true,native_provider_calls:0,enabled:false});
  assert.deepEqual(await due(third.id),[]);
}
