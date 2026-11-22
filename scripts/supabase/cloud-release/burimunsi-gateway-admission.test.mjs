import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {smsFenceBackend} from '../../../deploy/collect-sms/src/fence.ts';
import {FENCE_IO_TIMEOUT_MS, openApplicationWork} from '../../../supabase/functions/_shared/application-fence.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {fixtureTableNames} from '../testing/http-admission-pg/fixture.mjs';
import {canonicalProfile, legacyDeploymentProfile} from '../../../supabase/functions/_shared/deployment-profile.js';

const pg = createRequire(import.meta.url)('pg');
const source = 'a'.repeat(64);
const baseline = 'dfc7a4fafb696f73d207251c9f35cb892528eecd1929552fa575996874adc3e3';
const profile = JSON.stringify({
  admin_origin: 'https://admin.example.test', environment: 'qualification', format: 'collect.deployment.v1',
  google_callback_origin: 'https://admin.example.test', id: 'gateway-test', member_api_origin: 'https://api.example.test',
  mode: 'self_hosted', public_origin: 'https://public.example.test', supabase_origin: 'https://db.example.test',
});
const profileSha = createHash('sha256').update(profile).digest('hex');
const migration = filename => readFile(new URL('../../../supabase/migrations/' + filename, import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');

async function prepareDatabase(t, runtimeProfile = null) {
  const cluster = await startOwnedPg17({prefix: 'collect-pg-transfer-', initialUser: 'collect_fixture'});
  const connections = [];
  const connect = async user => {
    const client = new pg.Client({host: cluster.socket, port: cluster.port, database: 'postgres', user});
    connections.push(client);
    await client.connect();
    return client;
  };
  t.after(async () => {
    try { await Promise.all(connections.map(client => client.end())); }
    finally { assert.equal((await cluster.close()).removed, true); }
  });
  const bootstrap = await connect(cluster.initialUser);
  await bootstrap.query('CREATE ROLE postgres LOGIN SUPERUSER');
  const owner = await connect('postgres');
  await owner.query(`
    CREATE ROLE collect_runtime; CREATE ROLE collect_importer;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE collect_sms_edge_login LOGIN NOINHERIT;
    CREATE SCHEMA app; CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO collect_runtime`);
  const core = await migration('20261022195747_collect_application_mutation_fence.sql');
  await owner.query(fixtureTableNames(core).map(name => 'CREATE TABLE ' + name + '(fixture integer)').join(';'));
  await owner.query(core);
  await owner.query(await migration('20261101012503_collect_sms_gateway.sql'));
  await owner.query('GRANT collect_sms_runtime TO collect_sms_edge_login WITH INHERIT FALSE, SET TRUE');
  await owner.query(await migration('20261101013157_collect_deployment_identity.sql'));
  if (runtimeProfile) {
    // This owned fixture supplies the immutable profile row expected by the
    // reviewed work_register authority. It does not revise the cloud binder.
    await owner.query(`INSERT INTO private.collect_deployment_identity(operation_id,profile_raw,profile_sha256)
      VALUES(gen_random_uuid(),$1,$2)`, [runtimeProfile, hash(runtimeProfile)]);
    for (const id of ['fixture-app', 'fixture-other-app']) {
      await owner.query(`INSERT INTO collect_sms.applications(application_id,name,token_hash,allowed_kinds,scopes,created_at)
        VALUES($1,$1,$2,'["receipt"]','["messages:read","messages:write"]','2026-01-01T00:00:00.000Z')`, [id, hash(id+'-token')]);
    }
    await owner.query(`INSERT INTO collect_sms.messages(message_id,application_id,kind,to_number,text,payload_digest,request_digest,
      idempotency_key,priority,not_after,available_at,created_at,updated_at,segments_estimate)
      VALUES('fixture-message','fixture-app','receipt','+250780000000','Synthetic receipt',$1,$2,'fixture-request',10,
        '2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',1)`,
      [hash('payload'), hash('request')]);
  } else {
    await owner.query('SELECT private.collect_bind_deployment(gen_random_uuid(),$1,$2)', [profile, profileSha]);
  }
  await owner.query('SELECT private.collect_fence_initialize(gen_random_uuid(),$1,$2)', [source, baseline]);
  await owner.query(await migration('20261101030502_collect_sms_application_fence.sql'));
  return {
    cluster,
    gateway: await connect('collect_sms_edge_login'),
    async stored(id) {
      const {rows} = await owner.query(`SELECT a.state,a.reason,a.external_dispatches,a.uncertain_dispatches,g.profile_sha256
        FROM private.collect_fence_admissions a JOIN private.collect_sms_fence_admissions g USING(admission_id)
        WHERE a.admission_id=$1`, [id]);
      return rows;
    },
  };
}

// Only the application's two ownership deadlines are advanced. PostgreSQL receives real
// statements under the gateway role and an independent session observes commit visibility.
function observeDeadlines(t) {
  const initialTimeout = globalThis.setTimeout, initialClear = globalThis.clearTimeout;
  const timers = [], holds = [];
  let elapsed = 0;
  const advance = ms => { elapsed += ms; };
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== FENCE_IO_TIMEOUT_MS) return initialTimeout(callback, ms, ...args);
    const handle = {fire: () => callback(...args)};
    timers.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (!timers.includes(handle)) initialClear(handle);
  });
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'EdgeRuntime');
  Object.defineProperty(globalThis, 'EdgeRuntime', {
    configurable: true, value: {waitUntil: promise => holds.push(promise)},
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, 'EdgeRuntime', prior);
    else delete globalThis.EdgeRuntime;
  });
  return {timers, holds, advance};
}

// A reserved connection dispatches BEGIN, registration and COMMIT exactly
// once. Hold physical COMMIT and its transport acknowledgement separately.
function delayedGateway(gateway, scenario) {
  const prepared = Promise.withResolvers(), permitCommit = Promise.withResolvers();
  const committed = Promise.withResolvers(), ack = Promise.withResolvers();
  const commands = [];
  const business = {
    async reserve() {
      return {
        async unsafe(sql, values) {
          if (sql.startsWith('SELECT collect_sms.work_register(')) {
            commands.push('register');
            const {rows} = await gateway.query(sql, values);
            if (scenario === 'late-register') {
              prepared.resolve();
              await permitCommit.promise;
            }
            if (scenario === 'wrong-ack') rows[0].result.admissionId = randomUUID();
            return rows;
          }
          if (sql === 'COMMIT') {
            prepared.resolve();
            await permitCommit.promise;
            await gateway.query('COMMIT');
            committed.resolve();
            await ack.promise;
            if (scenario === 'lost-ack') throw Error('synthetic lost registration COMMIT acknowledgement');
            return [];
          }
          if (scenario === 'late-query' && sql.startsWith('BEGIN')) {
            await gateway.query(sql, values);
            prepared.resolve();
            await permitCommit.promise;
            return [];
          }
          return (await gateway.query(sql, values)).rows;
        },
        release() { committed.resolve(); },
      };
    },
    async begin(options, operation) {
      assert.equal(options, 'ISOLATION LEVEL READ COMMITTED');
      await gateway.query('BEGIN ' + options);
      let command, value;
      try {
        value = await operation({async unsafe(sql, values) {
          const match = /^SELECT collect_sms\.work_(close|status)\(/.exec(sql);
          if (match) { command = match[1]; commands.push(command); }
          return (await gateway.query(sql, values)).rows;
        }});
        await gateway.query('COMMIT');
      } catch (error) {
        await gateway.query('ROLLBACK');
        throw error;
      }
      if (command === 'close' && scenario === 'lost-close') throw Error('synthetic lost close COMMIT acknowledgement');
      return value;
    },
  };
  const control = {async reserve() { commands.push('lease'); throw Error('unexpected control reservation'); }};
  return {backend: smsFenceBackend(business, control, profileSha), commands, prepared, permitCommit, committed, ack};
}

test('SMS gateway registration retains only its own PostgreSQL COMMIT acknowledgement after an HTTP timeout', async t => {
  const db = await prepareDatabase(t);
  for (const [scenario, title, expected] of [
    ['ack', 'original late COMMIT closes the exact gateway admission once', ['register','close']],
    ['lost-close', 'lost close acknowledgement reads the original status once', ['register','close','status']],
    ['lost-ack', 'a committed registration with a rejected transport acknowledgement stays active', ['register']],
    ['wrong-ack', 'a mismatched acknowledgement cannot close an admission', ['register']],
    ['never-ack', 'an unacknowledged COMMIT stays active beyond the recovery window', ['register']],
    ['elapsed', 'the monotonic ownership deadline applies before the recovery timer fires', ['register']],
  ]) {
    await t.test(title, async st => {
      const id = randomUUID();
      const {timers, holds, advance} = observeDeadlines(st);
      const f = delayedGateway(db.gateway, scenario);
      const request = openApplicationWork({backend: f.backend, sourceSha256: source, kind: 'http_collect', id});
      const failed = assert.rejects(request, {code: 'application_fence_unavailable', status: 503});
      // Release both synthetic gates even if an assertion fails, before reusing this connection.
      st.after(async () => { f.permitCommit.resolve(); f.ack.resolve(); await setImmediate(); });
      await f.prepared.promise;
      assert.deepEqual(await db.stored(id), []);
      assert.equal(timers.length, 2); // bounded pool reservation and registration observation
      timers[1].fire();
      await failed;
      assert.equal(holds.length, 1);
      assert.deepEqual(f.commands, ['register']);
      f.permitCommit.resolve();
      await f.committed.promise;
      const active = [{state: 'active', reason: null, external_dispatches: 0, uncertain_dispatches: 0, profile_sha256: profileSha}];
      assert.deepEqual(await db.stored(id), active);
      if (scenario === 'never-ack') {
        assert.equal(timers.length, 3);
        timers[2].fire();
        await holds[0];
        assert.deepEqual(await db.stored(id), active);
      }
      if (scenario === 'elapsed') advance(FENCE_IO_TIMEOUT_MS);
      f.ack.resolve();
      await holds[0];
      await setImmediate();
      assert.deepEqual(f.commands, expected);
      const rows = await db.stored(id);
      if (expected.includes('close')) {
        assert.deepEqual(rows, [{...active[0], state: 'settled', reason: 'cancelled_before_work'}]);
      } else {
        assert.deepEqual(rows, active);
      }
    });
  }
  for (const [scenario, title, commands] of [
    ['late-query', 'an expired setup cannot dispatch registration on its already reserved backend', []],
    ['late-register', 'an expired registration result is rolled back before dispatching COMMIT', ['register']],
  ]) {
    await t.test(title, async st => {
      const id = randomUUID();
      const {timers, holds, advance} = observeDeadlines(st);
      const f = delayedGateway(db.gateway, scenario);
      st.after(() => f.permitCommit.resolve());
      const request = openApplicationWork({backend: f.backend, sourceSha256: source, kind: 'http_collect', id});
      const failed = assert.rejects(request, {code: 'application_fence_unavailable', status: 503});
      await f.prepared.promise;
      advance(FENCE_IO_TIMEOUT_MS);
      timers[1].fire();
      await failed;
      f.permitCommit.resolve();
      await f.committed.promise;
      await holds[0];
      assert.deepEqual(f.commands, commands);
      assert.deepEqual(await db.stored(id), []);
    });
  }
});

test('the real gateway reads and writes through the PostgreSQL 17 application fence', async t => {
  const runtimeProfile = canonicalProfile(legacyDeploymentProfile());
  const {cluster} = await prepareDatabase(t, runtimeProfile);
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const fixture = fileURLToPath(new URL('../../../deploy/collect-sms/test/gateway-latency-pg.fixture.ts', import.meta.url));
  const socketFile = cluster.socket+'/.s.PGSQL.'+cluster.port;
  const output = await new Promise((resolve, reject) => {
    const run = cluster.trackChild(spawn('deno', [
      'run', '--cached-only', '--frozen', '--allow-env', '--allow-read='+socketFile, '--allow-write='+socketFile,
      '--allow-net=unix:'+socketFile,
      '--config=supabase/functions/deno.json', '--lock=supabase/functions/deno.lock',
      fixture, cluster.socket, String(cluster.port), runtimeProfile, hash(runtimeProfile), source,
    ], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']}));
    const chunks = [];
    run.stdout.on('data', chunk => chunks.push(chunk));
    run.stderr.on('data', chunk => chunks.push(chunk));
    run.once('error', reject);
    run.once('close', code => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code === 0) resolve(text); else reject(Error(text));
    });
  });
  t.diagnostic(output.trim());
});
