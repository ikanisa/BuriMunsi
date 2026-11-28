import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {canonicalProfile, MANAGED_SUPABASE_ORIGIN} from '../deployment-profile.js';
import {MANAGED_PRODUCTION_PROFILE_SHA256} from '../burimunsi-standalone.js';
import {admitDirectSupabaseNativeIngress} from '../native-direct-supabase-ingress.js';
import {createPlatformHealthReporter} from '../domain/observability.js';
import {CONTRACT_VERSION} from '../domain/burimunsi/wire/native-contract.mjs';
import './helpers/node-postgres-import.mjs';

const {createHandler} = await import('../edge-http-handler.js');
const origin = MANAGED_SUPABASE_ORIGIN;
const source = 'a'.repeat(64);
const login = '/v1/burimunsi/session/login';
const sensitive = 'private-fixture-must-not-appear';
const capacity = Object.assign(Error('collect_fence_capacity'), {code: '55000', detail: sensitive});
const env = {
  SUPABASE_URL: origin, APP_ENVIRONMENT: 'production', BUILD_SOURCE_ID: source,
  COLLECT_DEPLOYMENT_PROFILE: canonicalProfile({format: 'collect.deployment.v1', id: 'collect-managed-production-cloud',
    mode: 'managed', environment: 'production', supabase_origin: origin, member_api_origin: origin,
    admin_origin: origin, public_origin: origin, google_callback_origin: origin}),
  COLLECT_DEPLOYMENT_PROFILE_SHA256: MANAGED_PRODUCTION_PROFILE_SHA256,
  BURIMUNSI_PRODUCT_MODE: 'standalone', BURIMUNSI_COLLECTION_ID: 'fixture-group', BURIMUNSI_NATIVE_ENABLED: 'true',
  COLLECT_NATIVE_INGRESS_MODE: 'supabase_direct_v1', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
  SUPABASE_SECRET_KEY: 'sb_secret_fixture', COLLECT_DATABASE_URL: 'postgres://postgres:fixture@db.rrlduytparvsjfmegalh.supabase.co/postgres',
};

function request({path = login, method = 'POST', auth = 'phone_pin', contract = CONTRACT_VERSION, signal, host = origin} = {}) {
  const headers = new Headers({'Content-Type': 'application/json', 'X-BuriMunsi-Request': crypto.randomUUID(),
    'X-BuriMunsi-Contract': contract, 'X-BuriMunsi-Profile': 'staff'});
  if (auth !== null) headers.set('X-BuriMunsi-Auth', auth);
  return new Request(host + '/functions/v1/collect-api' + path, {method, headers, signal,
    ...(method === 'POST' ? {body: JSON.stringify({phone: sensitive, pin: sensitive})} : {})});
}

// Only the PostgreSQL transport is synthetic. Direct ingress, the managed
// deployment/collection gate, role setup, SQL adapter, open and reporter all run.
// The same database Error object can recur at different sites or in different requests.
let current;
const registerSql = 'SELECT private.collect_fence_register($1::uuid,$2::text,$3::text) AS result';
globalThis.__collectFencePostgresFixture = () => ({
  async begin(isolation, fn) {
    assert.equal(isolation, 'ISOLATION LEVEL READ COMMITTED');
    const f = current;
    const tx = async (strings) => {
      assert.match(strings.join('?'), /private\.collect_assert_deployment.*?FROM app\.collections/s);
      f.calls.push('deployment');
      if (f.site === 'deployment') throw capacity;
      return [{allowed: true, scope_matches: true}];
    };
    tx.unsafe = async (sql, values) => {
      if (sql.startsWith('SET LOCAL ROLE collect_runtime')) {
        f.calls.push('role');
        if (f.site === 'role') throw capacity;
        return [];
      }
      assert.equal(sql, registerSql, 'session creation, PIN budget, lease, and application SQL must be unreachable');
      f.calls.push('register');
      const [id, digest, kind] = values;
      assert.equal(digest, source);
      assert.equal(kind, 'http_collect');
      if (f.site === 'register') throw f.failure ?? capacity;
      if (f.site === 'aborted') { f.controller.abort(); throw capacity; }
      if (f.site === 'timeout') return f.pending.promise;
      if (f.site === 'row') return [{get result() { throw capacity; }}];
      return [{result: {contractVersion: 1, admissionId: id, sourceSha256: digest, kind, state: 'active', mode: 'open', epoch: 1}}];
    };
    const result = await fn(tx);
    f.calls.push('commit');
    if (f.site === 'commit') throw capacity;
    throw Error('The fixture must stop before a successful registration');
  },
});
test.after(() => { delete globalThis.__collectFencePostgresFixture; });

function fixture(site = 'register', options = {}) {
  current = {site, calls: [], ...options};
  const rows = [];
  const report = createPlatformHealthReporter({clock: () => 0, emit: (_level, line) => rows.push(JSON.parse(line))});
  const handler = createHandler('collect-api', () => env, {standalone: true, admitDirectSupabaseNativeIngress, reportHealth: report});
  return {handler, report, rows, calls: current.calls};
}

function expected(row, classified) {
  return {service: 'collect_platform_api', schema_version: 1, event: 'service_degraded',
    component: 'platform', status: 503, request_id: null, source_id: source, elapsed_ms: row.elapsed_ms,
    ...(classified ? {operation: 'native_pin_login', stage: 'registration_rejected', cause: 'collect_fence_capacity'} : {})};
}

async function checkFenceResponse(response) {
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {code: 'application_fence_unavailable',
    message: 'The service is temporarily unavailable. Keep the original request pending.'});
}

test('standalone native PIN login records one known register rejection without starting or resending sign-in', async () => {
  for (const path of [login, login + '?include=home']) {
    const f = fixture();
    await checkFenceResponse(await f.handler(request({path})));
    assert.deepEqual(f.calls, ['role','deployment','register']);
    assert.equal(f.rows.length, 1);
    assert.deepEqual(f.rows[0], expected(f.rows[0], true));
    assert.equal(JSON.stringify(f.rows).includes(sensitive), false);
  }
});

test('lookup, role, commit, wire error, cancellation and timeout cannot establish a known register refusal', async () => {
  for (const [site, options, calls] of [
    ['role', {}, ['role']],
    ['deployment', {}, ['role','deployment']],
    ['row', {}, ['role','deployment','register']],
    ['commit', {}, ['role','deployment','register','commit']],
    ['register', {failure: Object.assign(Error('collect_fence_capacity'), {code:'08006'})}, ['role','deployment','register']],
    ['register', {failure: Object.assign(Error('collect_fence_capacity ' + sensitive), {code:'55000'})}, ['role','deployment','register']],
    ['register', {failure: Error('lost acknowledgement')}, ['role','deployment','register']],
    ['aborted', {controller:new AbortController()}, ['role','deployment','register']],
    ['timeout', {pending:Promise.withResolvers()}, ['role','deployment','register']],
  ]) {
    const f = fixture(site, options);
    try {
      await checkFenceResponse(await f.handler(request({signal: options.controller?.signal})));
      assert.deepEqual(f.calls, calls);
      assert.equal(f.rows.length, 1, site);
      assert.deepEqual(f.rows[0], expected(f.rows[0], false));
    } finally {
      if (options.pending) { options.pending.reject(capacity); await setImmediate(); }
    }
    assert.equal(f.rows.length, 1, 'a late rejection cannot replace the original observation');
  }
});

test('only the normalized native PIN login is eligible, and an ingress denial never reaches registration', async () => {
  for (const input of [{auth:null}, {auth:'managed'}, {contract:'unknown'}, {path: login + '?include=other'},
      {path: login + '/suffix'}, {path:'/v1/burimunsi/session/logout'}, {method:'GET'}, {method:'OPTIONS'},
      {host:'https://other.invalid'}]) {
    const f = fixture();
    const response = await f.handler(request(input));
    assert.ok(f.rows.every(row => row.operation === undefined), JSON.stringify(input));
    if (input.host || input.method === 'OPTIONS') assert.deepEqual(f.calls, []);
    if (input.method === 'OPTIONS') assert.equal(response.status, 204);
  }
});

test('the existing reporter suppresses login details at its shared limit and rejects lookalike metadata', async () => {
  const f = fixture();
  const input = {status:503, component:'platform', requestId:null, sourceId:source, elapsedMs:1};
  f.report({...input, nativePinLoginRegistration:{stage:'registration_rejected', cause:'collect_fence_capacity', private:sensitive}});
  assert.deepEqual(f.rows[0], expected(f.rows[0], false));
  for (let i = 1; i < 64; i++) f.report({...input, component:'auth'});
  await checkFenceResponse(await f.handler(request()));
  await checkFenceResponse(await f.handler(request()));
  assert.equal(f.rows.length, 65);
  assert.deepEqual(f.rows[64], {service:'collect_platform_api', schema_version:1, event:'events_suppressed', component:'platform',
    status:null, request_id:null, source_id:source, elapsed_ms:null});
});
