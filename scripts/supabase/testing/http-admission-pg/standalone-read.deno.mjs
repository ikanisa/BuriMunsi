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

// Leave six registered operations outstanding and race two native reads with
// an ordinary jobs request for exactly two remaining admission slots.
async function contention(fast) {
  const lanes = await Promise.all(Array.from({length:4}, () => clients(db.socketPath)));
  const backend = (client, native = false) => sqlFenceBackend(client.business, client.control, check, native);
  const existing = backend(lanes[0]), holders = [], granted = [];
  const ids = lanes.slice(1).map(() => randomUUID());
  const finishGranted = async () => {
    for (const work of granted.splice(0)) await work.finish();
  };
  try {
    for (let i = 0; i < 6; i++) {
      const id = randomUUID();
      const row = await existing.register(id, source, kind);
      holders.push({id, epoch:row.epoch});
    }
    const attempts = [
      open(backend(lanes[1], fast), ids[0]),
      open(backend(lanes[2], fast), ids[1]),
      open(backend(lanes[3]), ids[2], {kind:'jobs'}),
    ];
    const outcomes = await Promise.allSettled(attempts);
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') granted.push(outcome.value);
      else assert.equal(outcome.reason.code, 'application_fence_unavailable');
    }
    assert.equal(granted.length, 2);
    const [total] = await owner`SELECT count(*)::int AS n FROM private.collect_fence_admissions WHERE state='active'`;
    assert.equal(total.n, 8);
    for (const id of ids) {
      const registered = await stored(id);
      assert.equal(registered?.state, granted.some(work => work.id === id) ? 'active' : undefined);
    }
    await finishGranted();
    const next = await open(backend(lanes[1], fast));
    await next.finish();
    console.log('PASS six occupied admissions, concurrent native reads and jobs, clean denial and recovery; optimized=' + fast);
  } finally {
    await finishGranted();
    for (const {id,epoch} of holders) {
      assert.equal((await stored(id)).state, 'active');
      await existing.close(id, epoch, source, 'settled', 'cancelled_before_work', 0, 0);
    }
    await Promise.all(lanes.map(lane => lane.close()));
  }
}

async function regressions() {
  const c = await clients(db.socketPath);
  try {
    const base = sqlFenceBackend(c.business, c.control, check, true);
    const success = await open(base);
    const lockAvailable = async () =>
      (await owner`SELECT pg_try_advisory_xact_lock(7346371,1) AS available`)[0].available;
    assert.equal(await lockAvailable(), false);
    await success.finish();
    assert.equal(await lockAvailable(), true);
    assert.equal((await stored(success.id)).state, 'settled');
    const bad = await prepareDeploymentCheck(env, 'another-group');
    await denyWithoutRegistration(sqlFenceBackend(c.business, c.control, bad, true));
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
    await denyWithoutRegistration(sqlFenceBackend(c.business, c.control, other, true));
    const wrongId = randomUUID();
    await assert.rejects(open(base, wrongId, { sourceSha256: 'b'.repeat(64) }));
    assert.equal(await stored(wrongId), undefined);
    const denied = await clients(db.socketPath, 'burimunsi_admission_denied');
    try {
      await denyWithoutRegistration(sqlFenceBackend(denied.business, denied.control, check, true));
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
      const b = sqlFenceBackend(f.business, c.control, check, true);
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
      const opening = open(sqlFenceBackend(f.business, c.control, check, true), late).then(() => {
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
    await assert.rejects(open(sqlFenceBackend(c.business, failedControl, check, true), request));
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
        const backend = sqlFenceBackend(business, control, check, fast),
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
