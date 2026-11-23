// Started by burimunsi-gateway-admission.test.mjs against its own socket-only PG17.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import { MANAGED_SUPABASE_ORIGIN } from '../../../supabase/functions/_shared/deployment-profile.js';
import { openApplicationWork } from '../../../supabase/functions/_shared/application-fence.js';
import { createSmsGatewayHandler } from '../src/edge.ts';
import { smsFenceBackend } from '../src/fence.ts';
import { GatewayDatabase } from '../src/postgres.ts';

const [socket, portValue, profile, profileSha256, sourceSha256] = Deno.args;
const port = Number(portValue);
assert.match(socket, /^\/(?:private\/)?tmp\/collect-pg-transfer-[A-Za-z0-9]+\/s$/);
assert(Number.isSafeInteger(port) && port >= 51000 && port < 61000);
assert.match(profileSha256, /^[a-f0-9]{64}$/);
assert.equal(sourceSha256, 'a'.repeat(64));

const businessQueries: string[] = [], controlQueries: string[] = [];
function pool(username: string, queries: string[] = []) {
  return postgres({
    host: socket, port, username, database: 'postgres', ssl: false, max: 4, prepare: false,
    connect_timeout: 2, onnotice() {},
    types: { bigint: { to: 20, from: [20], serialize: String, parse: Number } },
    debug(_connection, query) { queries.push(query); },
  });
}
const owner = pool('postgres'), business = pool('collect_sms_edge_login', businessQueries);
const control = pool('collect_sms_edge_login', controlQueries);
const backend = smsFenceBackend(business, control, profileSha256);
const readHeld = Promise.withResolvers<void>(), releaseRead = Promise.withResolvers<void>();
const writerSubmitted = Promise.withResolvers<void>();
// Hold the first business transaction at its original query acknowledgement,
// leaving its real PostgreSQL lock visible to the independent owner connection.
const observedBusiness = {
  async reserve() {
    const tx = await business.reserve();
    return {
      release: () => tx.release(),
      async unsafe(query: string, values?: never[]) {
        if (query === 'SELECT pg_catalog.pg_advisory_xact_lock(721340019927::bigint)') writerSubmitted.resolve();
        const rows = await tx.unsafe(query, values);
        if (query.includes('AS first_gateway_reader')) {
          readHeld.resolve();
          await releaseRead.promise;
        }
        return rows;
      },
    };
  },
} as unknown as typeof business;
const database = new GatewayDatabase(observedBusiness);
const fixtureDatabaseUrl = new URL('postgresql://aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=verify-full');
fixtureDatabaseUrl.username = 'collect_sms_edge_login.rrlduytparvsjfmegalh';
fixtureDatabaseUrl.password = 'unused';

const handler = createSmsGatewayHandler({
  APP_ENVIRONMENT: 'production', SUPABASE_URL: MANAGED_SUPABASE_ORIGIN,
  BUILD_SOURCE_ID: sourceSha256, COLLECT_SMS_CORE_SOURCE_SHA256: sourceSha256,
  COLLECT_SMS_ENABLED: 'true', COLLECT_SMS_DISPATCH_PAUSED: 'true',
  COLLECT_SMS_RELEASE_SHA256: 'b'.repeat(64), COLLECT_SMS_APPROVAL_SHA256: 'c'.repeat(64),
  COLLECT_DEPLOYMENT_PROFILE: profile, COLLECT_DEPLOYMENT_PROFILE_SHA256: profileSha256,
  COLLECT_SMS_DATABASE_URL: fixtureDatabaseUrl.href,
  COLLECT_SMS_ROOT_ADMIN_TOKEN: 'root-fixture-token-'.repeat(4), COLLECT_SMS_OTP_HMAC_KEY: 'otp-fixture-key-'.repeat(4),
}, { database, fenceBackend: backend });
const request = (path: string, token: string) => handler(new Request(
  MANAGED_SUPABASE_ORIGIN + '/functions/v1/collect-sms' + path, { headers: { authorization: 'Bearer '+token } },
));
const open = () => Reflect.apply(openApplicationWork, undefined, [{ backend, sourceSha256, kind: 'http_collect' }]);
const operations = new Set<Promise<unknown>>();
const observe = <T>(operation: Promise<T>) => {
  operations.add(operation);
  void operation.catch(() => {});
  return operation;
};

try {
  const [identity] = await owner`SELECT inet_server_addr() IS NULL AS socket, current_setting('cluster_name') AS cluster,
    current_setting('server_version_num')::int / 10000 AS version`;
  assert.deepEqual({ ...identity }, { socket: true, cluster: 'collect_synthetic_fixture', version: 17 });
  const assertReady = await request('/internal/readiness', 'root-fixture-token-'.repeat(4));
  assert.equal(assertReady.status, 200);
  assert.equal((await assertReady.json()).profile_sha256, profileSha256);
  businessQueries.length = 0;
  controlQueries.length = 0;
  const started = performance.now();
  const result = await request('/v1/messages/fixture-message', 'fixture-app-token');
  assert.equal(result.status, 200);
  const receipt = await result.json();
  assert.equal(receipt.message.message_id, 'fixture-message');
  assert.equal(receipt.message.text, 'Synthetic receipt');
  assert.deepEqual([receipt.attempts,receipt.parts,receipt.history,receipt.audit], [[],[],[],[]]);
  const exchanges = { business: businessQueries.length, control: controlQueries.length };
  assert.deepEqual(exchanges, { business: 25, control: 7 });
  console.log(JSON.stringify({ route: 'GET /v1/messages/:id', elapsedMs: Math.round(performance.now()-started), exchanges }));
  assert.equal((await request('/v1/messages/fixture-message', 'fixture-other-app-token')).status, 404);
  assert.equal((await request('/v1/messages/fixture-message', 'invalid-token')).status, 401);

  const readWork = await open(), parallelWork = await open(), writerWork = await open();
  try {
    const readConnection = database.withApplicationWork(readWork);
    const parallelConnection = database.withApplicationWork(parallelWork);
    const writerConnection = database.withApplicationWork(writerWork);
    const inFlight = observe(readConnection.prepareRead('SELECT 11 AS first_gateway_reader').first('first_gateway_reader'));
    await Promise.race([readHeld.promise,inFlight.then(() => assert.fail('reader returned before its acknowledgement gate'))]);
    assert.equal(await parallelConnection.prepareRead('SELECT 22 AS second_gateway_reader').first('second_gateway_reader'), 22);
    await assert.rejects(parallelConnection.prepareRead("UPDATE applications SET name='wrong' WHERE application_id='fixture-app'").run(),
      { code: '25006' });
    const writing = observe(writerConnection.batch([
      writerConnection.prepareRead("SELECT name FROM applications WHERE application_id='fixture-app'"),
      writerConnection.prepare("UPDATE applications SET name='updated' WHERE application_id='fixture-app'"),
    ]));
    await Promise.race([writerSubmitted.promise,writing.then(() => assert.fail('writer did not request the serialization lock'))]);
    const limit = performance.now()+1_000;
    let waiting = false;
    while (performance.now()<limit && !waiting) {
      const [row] = await owner`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND classid=(721340019927::bigint >> 32)::oid AND objid=(721340019927::bigint & 4294967295)::oid
        AND mode='ExclusiveLock') AS waiting`;
      waiting = row.waiting;
    }
    assert.equal(waiting, true);
    releaseRead.resolve();
    assert.equal(await inFlight, 11);
    const [prior,updated] = await writing;
    assert.equal(prior.results[0].name, 'fixture-app');
    assert.equal(updated.meta.changes, 1);
  } finally {
    releaseRead.resolve();
    await Promise.allSettled(operations);
    await Promise.all([readWork.finish(),parallelWork.finish(),writerWork.finish()]);
  }
  assert.equal((await owner`SELECT name FROM collect_sms.applications WHERE application_id='fixture-app'`)[0].name, 'updated');
  assert.equal((await owner`SELECT count(*)::int AS count FROM private.collect_fence_admissions
    WHERE state<>'settled' OR external_dispatches<>0 OR uncertain_dispatches<>0`)[0].count, 0);
} finally {
  releaseRead.resolve();
  await Promise.all([owner.end({ timeout: 2 }),business.end({ timeout: 2 }),control.end({ timeout: 2 })]);
}
