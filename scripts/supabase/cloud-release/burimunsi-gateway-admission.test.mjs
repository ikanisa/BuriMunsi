import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import pg from 'pg';
import {smsFenceBackend} from '../../../deploy/collect-sms/src/fence.ts';
import {FENCE_IO_TIMEOUT_MS, openApplicationWork} from '../../../supabase/functions/_shared/application-fence.js';
import {startOwnedPg17} from '../current-pg-transfer/test-support/owned-pg17.mjs';
import {fixtureTableNames} from '../testing/http-admission-pg/fixture.mjs';

const source = 'a'.repeat(64);
const baseline = 'dfc7a4fafb696f73d207251c9f35cb892528eecd1929552fa575996874adc3e3';
const profile = JSON.stringify({
  admin_origin: 'https://admin.example.test', environment: 'qualification', format: 'collect.deployment.v1',
  google_callback_origin: 'https://admin.example.test', id: 'gateway-test', member_api_origin: 'https://api.example.test',
  mode: 'self_hosted', public_origin: 'https://public.example.test', supabase_origin: 'https://db.example.test',
});
const profileSha = createHash('sha256').update(profile).digest('hex');
const migration = filename => readFile(new URL('../../../supabase/migrations/' + filename, import.meta.url), 'utf8');

async function prepareDatabase(t) {
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
    CREATE ROLE collect_runtime; CREATE ROLE collect_sms_runtime; CREATE ROLE collect_importer;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE gateway_test_login LOGIN NOINHERIT; GRANT collect_sms_runtime TO gateway_test_login;
    CREATE SCHEMA app; CREATE SCHEMA private; CREATE SCHEMA collect_sms;
    GRANT USAGE ON SCHEMA private TO collect_runtime; GRANT USAGE ON SCHEMA collect_sms TO collect_sms_runtime`);
  const core = await migration('20261022195747_collect_application_mutation_fence.sql');
  await owner.query(fixtureTableNames(core).map(name => 'CREATE TABLE ' + name + '(fixture integer)').join(';'));
  await owner.query(core);
  await owner.query(await migration('20261101013157_collect_deployment_identity.sql'));
  await owner.query('SELECT private.collect_bind_deployment(gen_random_uuid(),$1,$2)', [profile, profileSha]);
  await owner.query('SELECT private.collect_fence_initialize(gen_random_uuid(),$1,$2)', [source, baseline]);
  await owner.query(await migration('20261101030502_collect_sms_application_fence.sql'));
  return {
    gateway: await connect('gateway_test_login'),
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
  return {timers, holds};
}

// A transaction returning a row is still uncommitted. Hold its actual COMMIT and then
// its transport acknowledgement separately, just as postgres-js begin() does.
function delayedGateway(gateway, scenario) {
  const prepared = Promise.withResolvers(), permitCommit = Promise.withResolvers();
  const committed = Promise.withResolvers(), ack = Promise.withResolvers();
  const commands = [];
  const business = {
    async begin(options, operation) {
      assert.equal(options, 'ISOLATION LEVEL READ COMMITTED');
      await gateway.query('BEGIN ' + options);
      let command, value;
      try {
        value = await operation({async unsafe(sql, values) {
          const match = /^SELECT collect_sms\.work_(register|close|status)\(/.exec(sql);
          if (match) { command = match[1]; commands.push(command); }
          return (await gateway.query(sql, values)).rows;
        }});
        if (command === 'register') {
          prepared.resolve();
          await permitCommit.promise;
        }
        await gateway.query('COMMIT');
      } catch (error) {
        await gateway.query('ROLLBACK');
        prepared.reject(error);
        throw error;
      }
      if (command === 'register') {
        committed.resolve();
        await ack.promise;
        if (scenario === 'wrong-ack') return {...value, admissionId: randomUUID()};
        if (scenario === 'lost-ack') throw Error('synthetic lost registration COMMIT acknowledgement');
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
  ]) {
    await t.test(title, async st => {
      const id = randomUUID();
      const {timers, holds} = observeDeadlines(st);
      const f = delayedGateway(db.gateway, scenario);
      const request = openApplicationWork({backend: f.backend, sourceSha256: source, kind: 'http_collect', id});
      const failed = assert.rejects(request, {code: 'application_fence_unavailable', status: 503});
      // Release both synthetic gates even if an assertion fails, before reusing this connection.
      st.after(async () => { f.permitCommit.resolve(); f.ack.resolve(); await setImmediate(); });
      await f.prepared.promise;
      assert.deepEqual(await db.stored(id), []);
      assert.equal(timers.length, 1);
      timers[0].fire();
      await failed;
      assert.equal(holds.length, 1);
      assert.deepEqual(f.commands, ['register']);
      f.permitCommit.resolve();
      await f.committed.promise;
      const active = [{state: 'active', reason: null, external_dispatches: 0, uncertain_dispatches: 0, profile_sha256: profileSha}];
      assert.deepEqual(await db.stored(id), active);
      if (scenario === 'never-ack') {
        assert.equal(timers.length, 2);
        timers[1].fire();
        await holds[0];
        assert.deepEqual(await db.stored(id), active);
      }
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
});
