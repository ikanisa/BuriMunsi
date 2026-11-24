// Run with the pinned Deno lock and an explicitly owned PostgreSQL 17 fixture.
// The two modes use the same server, account, controls and pinned wire driver.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { chmod, readFile } from 'node:fs/promises';
import postgres from 'npm:postgres@3.4.7';
import { createOwnedFixture } from './fixture.mjs';
import {
  canonicalProfile,
  legacyDeploymentProfile,
} from '../../../../supabase/functions/_shared/deployment-profile.js';
import { prepareDeploymentCheck } from '../../../../supabase/functions/_shared/deployment-database.js';
import {
  openApplicationWork,
  sqlFenceBackend,
} from '../../../../supabase/functions/_shared/application-fence.js';
import { leaseOwnedControlPool } from '../../../../supabase/functions/_shared/postgres-connections.js';

const source = 'a'.repeat(64), kind = 'http_collect', group = 'group-one';
const profile = canonicalProfile(legacyDeploymentProfile(true));
const digest = createHash('sha256').update(profile).digest('hex');
const env = { COLLECT_DEPLOYMENT_PROFILE: profile, COLLECT_DEPLOYMENT_PROFILE_SHA256: digest };
const db = await createOwnedFixture();
const owner = postgres({
  path: db.socketPath,
  user: 'postgres',
  database: 'postgres',
  prepare: false,
  max: 1,
  onnotice: () => {},
});
const role = 'burimunsi_admission_test';

async function delayedSocket(oneWayMs) {
  const path = join(dirname(db.socketPath), 'admission-wire-' + oneWayMs);
  const peers = new Set();
  function relay(a, b) {
    a.on('data', (chunk) => {
      setTimeout(() => {
        if (b.writable) b.write(chunk);
      }, oneWayMs);
    });
    a.on('end', () => setTimeout(() => b.end(), oneWayMs));
    a.on('error', () => b.destroy());
    a.on('close', () => peers.delete(a));
  }
  const server = net.createServer((client) => {
    const serverSide = net.connect(db.socketPath);
    peers.add(client);
    peers.add(serverSide);
    relay(client, serverSide);
    relay(serverSide, client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function clients(path, user = role) {
  const commands = [];
  const options = {
    path,
    user,
    database: 'postgres',
    prepare: false,
    max: 1,
    onnotice: () => {},
    debug(_pid, query) {
      commands.push(query);
    },
  };
  const business = postgres(options),
    control = leaseOwnedControlPool(() => postgres(options), { reuse: true, capacity: 2 });
  return {
    business,
    control,
    commands,
    async close() {
      await control.end();
      await business.end();
    },
  };
}
const open = (backend, id = randomUUID(), extra = {}) =>
  openApplicationWork({ backend, sourceSha256: source, kind, id, ...extra });
const stored = async (id) =>
  (await owner`SELECT state,reason FROM private.collect_fence_admissions WHERE admission_id=${id}::uuid`)[0];
const check = await prepareDeploymentCheck(env, group);
function readBackend(business, control, verify, fast, signal = new AbortController().signal) {
  return sqlFenceBackend(business, control, verify, signal, fast);
}

const pending = () => {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
};
function pauseCommit(business) {
  const committed = pending(), ack = pending();
  return {
    committed,
    ack,
    business: {
      async begin(options, fn) {
        const result = await business.begin(options, fn);
        if (result?.state === 'active' && result.kind === kind) {
          committed.resolve();
          if (await ack.promise === 'lost') throw Error('injected_lost_commit_ack');
        }
        return result;
      },
    },
  };
}
async function denyWithoutRegistration(backend) {
  const id = randomUUID();
  await assert.rejects(open(backend, id), { code: 'application_fence_unavailable' });
  assert.equal(await stored(id), undefined);
}

// Keep six original rows active and one protected screen open. Eighteen more
// screens must observe a genuine PG capacity refusal while a jobs request uses slot eight.
async function contention(fast) {
  const clientsForBurst = await Promise.all(Array.from({length:20}, () => clients(db.socketPath)));
  const ordinary=sqlFenceBackend(clientsForBurst[0].business,clientsForBurst[0].control,check);
  const holders=[], waits=[], controllers=[], cleanup=[];
  let screen,job;
  try {
    for(let i=0;i<6;i++) {
      const id=randomUUID(),row=await ordinary.register(id,source,kind);
      holders.push({id,epoch:row.epoch});
    }
    const first=clientsForBurst[0];
    screen=await open(readBackend(first.business,first.control,check,fast));
    const started=clientsForBurst.slice(1,19).map((client,index)=>{
      const controller=new AbortController(), id=randomUUID(), rejected=pending();
      controllers.push(controller);
      // Record the server's exact exception before the runtime decides to retry.
      const business={begin:(...args)=>client.business.begin(...args).catch(error=>{
        if(error.code==='55000' && error.message==='burimunsi_read_capacity') rejected.resolve();
        throw error;
      })};
      const isAdmin=index%2===1;
      const back=readBackend(business,client.control,check,fast&&!isAdmin,controller.signal);
      const attempt=open(back,id,{kind:isAdmin?'http_admin':'http_collect',signal:controller.signal})
        .then(async work=>{await work.finish();return 'served';},error=>{
          assert.equal(error.code,'application_fence_unavailable');return 'denied';});
      waits.push(attempt);
      return {id, rejected:rejected.promise};
    });
    let timer;
    try {
      await Promise.race([Promise.all(started.map(x=>x.rejected)),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Missing protected read capacity refusal')),4500);})]);
    }finally{clearTimeout(timer);}
    const last=clientsForBurst[19];
    job=await open(sqlFenceBackend(last.business,last.control,check),randomUUID(),{kind:'jobs'});
    const [total]=await owner`SELECT count(*)::int AS n FROM private.collect_fence_admissions WHERE state='active'`;
    assert.equal(total.n,8);
    for(const {id} of started)assert.equal(await stored(id),undefined);
    // Cancel all but one waiting read. That original request must retry successfully
    // after the job and the first screen settle, with no extra durable admissions.
    for(const c of controllers.slice(1))c.abort();
    await job.finish(); job=undefined;
    await screen.finish(); screen=undefined;
    assert.deepEqual(await Promise.all(waits),['served',...new Array(17).fill('denied')]);
    for(const [index,item] of started.entries()){
      assert.equal((await stored(item.id))?.state,index===0?'settled':undefined);
    }
    for(const {id} of holders) assert.equal((await stored(id)).state,'active');
    console.log('PASS six occupied plus 20 overlapping Staff/Admin read and jobs requests: exact read-capacity denial, slot eight belongs to jobs, cancellation leaves no row and the original read recovers; fast='+fast);
  }finally{
    for(const c of controllers)c.abort();
    await Promise.allSettled(waits);
    if(job)cleanup.push(job.finish());
    if(screen)cleanup.push(screen.finish());
    await Promise.all(cleanup);
    for(const {id,epoch} of holders) await ordinary.close(id,epoch,source,'settled','cancelled_before_work',0,0);
    await Promise.all(clientsForBurst.map(client=>client.close()));
  }
}
async function verifyBoundReadLease(client) {
  let reservation;
  const releasedSettings=[];
  const capture={async reserve(){
    reservation=await client.control.reserve();
    const [prior]=await reservation.unsafe(`SELECT pg_backend_pid() AS pid,
      current_setting('burimunsi.read_work_id',true) AS id,
      current_setting('burimunsi.read_work_epoch',true) AS epoch,
      current_setting('burimunsi.read_work_source',true) AS source`);
    releasedSettings.push(prior);
    return reservation;
  }};
  const backend=readBackend(client.business,capture,check,true);
  for(let i=0;i<2;i++){
    const work=await open(backend);
    assert.equal((await work.assert()).admissionId,work.id);
    await work.finish();
  }
  assert.equal(releasedSettings[0].pid,releasedSettings[1].pid);
  assert.ok(releasedSettings.every(row=>!row.id&&!row.epoch&&!row.source));
  const otherId=randomUUID(),other=await backend.register(otherId,source,kind);
  try{
    for(const [field,value] of [['id',otherId],['epoch',String(other.epoch+1)],['source','b'.repeat(64)]]){
      const work=await open(backend);
      await reservation.unsafe('SELECT pg_catalog.set_config($1,$2,true)',['burimunsi.read_work_'+field,value]);
      await assert.rejects(work.assert(),{code:'application_fence_unavailable'});
      await work.finish({failed:true});
      assert.equal((await stored(otherId)).state,'active');
    }
  }finally{
    await backend.close(otherId,other.epoch,source,'settled','cancelled_before_work',0,0);
  }
  const next=await open(backend);
  assert.equal((await next.assert()).admissionId,next.id);
  await next.finish();
  console.log('PASS original lease tuple checked on every protected use, changed id/epoch/source denied, pooled rollback clears all settings');
}

async function regressions() {
  const c = await clients(db.socketPath);
  try {
    await verifyBoundReadLease(c);
    const base = readBackend(c.business, c.control, check, true);
    const unmarkedId=randomUUID();
    const unmarked=await c.business.begin('ISOLATION LEVEL READ COMMITTED',async tx=>{
      await tx.unsafe("SET LOCAL ROLE collect_runtime; SELECT pg_catalog.set_config('collect.edge_verified','true',true)");
      return check(tx,{id:unmarkedId,source,kind});
    });
    assert.equal(unmarked,null);
    assert.equal(await stored(unmarkedId),undefined);
    console.log('PASS a missing protected-read marker cannot register through the combined query');
    const success = await open(base);
    const lockAvailable = async () =>
      (await owner`SELECT pg_try_advisory_xact_lock(7346371,1) AS available`)[0].available;
    assert.equal(await lockAvailable(), false);
    await success.finish();
    assert.equal(await lockAvailable(), true);
    assert.equal((await stored(success.id)).state, 'settled');
    const bad = await prepareDeploymentCheck(env, 'another-group');
    await denyWithoutRegistration(readBackend(c.business, c.control, bad, true));
    await owner`INSERT INTO app.collections(id) VALUES ('extra-group')`;
    await denyWithoutRegistration(base);
    await owner`DELETE FROM app.collections`;
    await denyWithoutRegistration(base);
    await owner`INSERT INTO app.collections(id) VALUES (${group})`;
    const otherProfile = canonicalProfile({ ...legacyDeploymentProfile(true), id: 'another-installation' });
    const other = await prepareDeploymentCheck({
      COLLECT_DEPLOYMENT_PROFILE: otherProfile,
      COLLECT_DEPLOYMENT_PROFILE_SHA256: createHash('sha256').update(otherProfile).digest('hex'),
    }, group);
    await denyWithoutRegistration(readBackend(c.business, c.control, other, true));
    const wrongId = randomUUID();
    await assert.rejects(open(base, wrongId, { sourceSha256: 'b'.repeat(64) }));
    assert.equal(await stored(wrongId), undefined);
    const denied = await clients(db.socketPath, 'burimunsi_admission_denied');
    try {
      await denyWithoutRegistration(readBackend(denied.business, denied.control, check, true));
    } finally {
      await denied.close();
    }
    console.log(
      'PASS one, absent, wrong and duplicate collection, mismatched deployment or source, failed SET ROLE, and WORK lock lifetime',
    );

    const duplicated = randomUUID(), held = await open(base, duplicated);
    await assert.rejects(open(base, duplicated));
    assert.equal((await stored(duplicated)).state, 'active');
    await held.finish();
    for (const scenario of ['cancel', 'lost']) {
      const id = randomUUID(), control = new AbortController(), f = pauseCommit(c.business);
      const b = readBackend(f.business, c.control, check, true, control.signal);
      const opening = open(b, id, { signal: control.signal }).then(() => {
        throw Error('unexpected work');
      }, (e) => e);
      await f.committed.promise;
      assert.equal((await stored(id)).state, 'active');
      if (scenario === 'cancel') control.abort();
      f.ack.resolve(scenario);
      assert.equal((await opening).code, 'application_fence_unavailable');
      const r = await stored(id);
      assert.equal(r.state, scenario === 'cancel' ? 'settled' : 'active');
      if (scenario === 'cancel') assert.equal(r.reason, 'cancelled_before_work');
    }
    const late = randomUUID(), f = pauseCommit(c.business), holds = [], prior = globalThis.EdgeRuntime;
    globalThis.EdgeRuntime = { waitUntil: (promise) => holds.push(promise) };
    try {
      const opening = open(readBackend(f.business, c.control, check, true), late).then(() => {
        throw Error('unexpected timeout success');
      }, (e) => e);
      await f.committed.promise;
      assert.equal((await opening).code, 'application_fence_unavailable');
      assert.equal(holds.length, 1);
      f.ack.resolve('delayed');
      await holds[0];
      assert.equal((await stored(late)).reason, 'cancelled_before_work');
    } finally {
      f.ack.resolve('delayed');
      if (prior === undefined) delete globalThis.EdgeRuntime;
      else globalThis.EdgeRuntime = prior;
    }
    console.log('PASS duplicate registration, cancellation, late original COMMIT and lost original COMMIT');

    const checkout = { rollbacks: 0, assertions: 0, releaseAck: null };
    const failedControl = {
      async reserve() {
        const tx = await c.control.reserve();
        return {
          async unsafe(text, ...args) {
            const rows = await tx.unsafe(text, ...args);
            if (text.startsWith('BEGIN')) throw Error('injected_setup_ack_loss');
            if (text === 'ROLLBACK') checkout.rollbacks++;
            if (text.includes('collect_fence_assert_work')) checkout.assertions++;
            return rows;
          },
          release(ack) {
            checkout.releaseAck = ack;
            tx.release(ack);
          },
        };
      },
    };
    const request = randomUUID();
    await assert.rejects(open(readBackend(c.business, failedControl, check, true), request));
    assert.equal(checkout.rollbacks, 1);
    assert.equal(checkout.assertions, 0);
    assert.equal(checkout.releaseAck, undefined);
    assert.equal((await stored(request)).reason, 'cancelled_before_work');
    console.log(
      'PASS combined BEGIN/setup acknowledgement loss rolls back once without issuing a lease proof or returning a reusable connection',
    );
  } finally {
    await c.close();
  }
}

const percentile = (rows, q) => [...rows].sort((a, b) => a - b)[Math.ceil(q * rows.length) - 1];
async function benchmark(oneWayMs, count = 9) {
  const proxy = oneWayMs ? await delayedSocket(oneWayMs) : { path: db.socketPath, close: async () => {} };
  const clientsForWire = await clients(proxy.path);
  const { commands, business, control } = clientsForWire;
  const modes = [false, true], samples = [[], []], commandCounts = [[], []];
  try {
    for (let i = -2; i < count; i++) {
      const visit = i % 2 === 0 ? modes : [...modes].reverse();
      for (const fast of visit) {
        const backend = readBackend(business, control, check, fast),
          start = performance.now(),
          first = commands.length;
        const work = await open(backend);
        const elapsed = performance.now() - start, issues = commands.length - first;
        await work.finish();
        if (i >= 0) {
          samples[+fast].push(elapsed);
          commandCounts[+fast].push(issues);
        }
      }
    }
    const result = { addedRttMs: oneWayMs * 2, pairedSamples: count };
    for (const fast of modes) {
      result[fast ? 'combined' : 'sequential'] = {
        medianMs: +percentile(samples[+fast], .5).toFixed(1),
        p90Ms: +percentile(samples[+fast], .9).toFixed(1),
        issuedSql: [...new Set(commandCounts[+fast])],
      };
    }
    assert.deepEqual(result.sequential.issuedSql, [8]);
    assert.deepEqual(result.combined.issuedSql, [6]);
    console.log('MEASURE', JSON.stringify(result));
  } finally {
    await clientsForWire.close();
    await proxy.close();
  }
}
try {
  const migration = await readFile(
    new URL(
      '../../../../supabase/migrations/20261101013157_collect_deployment_identity.sql',
      import.meta.url,
    ),
    'utf8',
  );
  await owner.unsafe(
    'CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;' +
      'CREATE ROLE burimunsi_admission_test LOGIN NOINHERIT;CREATE ROLE burimunsi_admission_denied LOGIN NOINHERIT;' +
      'GRANT collect_runtime TO burimunsi_admission_test;GRANT USAGE ON SCHEMA app TO collect_runtime;' +
      'ALTER TABLE app.collections ADD COLUMN id text;GRANT SELECT(id) ON app.collections TO collect_runtime;' +
      migration,
  );
  // The fixture seeds the immutable public identity under its own cluster owner.
  await owner`INSERT INTO private.collect_deployment_identity(operation_id,profile_raw,profile_sha256) VALUES (${randomUUID()}::uuid,${profile},${digest})`;
  await owner`INSERT INTO app.collections(id) VALUES (${group})`;
  const [state]=await owner`SELECT epoch,source_sha256 FROM private.collect_fence_control WHERE singleton`;
  const fenceId=randomUUID();
  await owner`SELECT private.collect_fence_begin_quiesce(${fenceId}::uuid,${state.epoch}::bigint,${state.source_sha256}::text)`;
  await owner`SELECT private.collect_fence_drain(${fenceId}::uuid,${state.epoch}::bigint,${state.source_sha256}::text)`;
  await owner.unsafe(await readFile(new URL('../../../../supabase/migrations/20261124080000_burimunsi_read_admission.sql',import.meta.url),'utf8'));
  await owner`SELECT private.collect_fence_release(${randomUUID()}::uuid,${state.epoch}::bigint,${state.source_sha256}::text)`;
  await contention(false);
  await contention(true);
  await regressions();
  await benchmark(0);
  await benchmark(15);
} finally {
  try {
    await owner.end();
  } finally {
    await db.close();
  }
}
