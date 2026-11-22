import {assertEquals, assertRejects} from 'jsr:@std/assert@1.0.14';
import {BURIMUNSI_ADMIN_ORIGIN, MANAGED_PRODUCTION_PROFILE_SHA256} from '../burimunsi-standalone.js';
import {canonicalProfile, MANAGED_SUPABASE_ORIGIN} from '../deployment-profile.js';
import {assertRuntimeDeployment} from '../deployment-database.js';
import {createHandler} from '../edge-http-handler.js';
import {logicalRequest} from '../edge-http-transport.js';
import {adminSessionOriginMatches} from '../admin-security.js';
import {handleAuth} from '../domain/auth.js';
import {momoGatewayRoute} from '../domain/momo_gateway.js';

const project = MANAGED_SUPABASE_ORIGIN;
const group = 'fixture-group';
const legacyAdmin = 'https://platform-admin.collect.ikanisa.com';
const profile = {
  format: 'collect.deployment.v1', id: 'collect-managed-production-cloud', mode: 'managed',
  environment: 'production', supabase_origin: project, member_api_origin: project,
  admin_origin: project, public_origin: project, google_callback_origin: project,
};
const env = {
  APP_ENVIRONMENT: 'production', SUPABASE_URL: project, ADMIN_ORIGIN: project,
  COLLECT_DEPLOYMENT_PROFILE: canonicalProfile(profile),
  COLLECT_DEPLOYMENT_PROFILE_SHA256: MANAGED_PRODUCTION_PROFILE_SHA256,
  BURIMUNSI_PRODUCT_MODE: 'standalone', BURIMUNSI_COLLECTION_ID: group,
};

function request(surface: string, path: string, method: string, origin?: string, body?: unknown) {
  const headers = new Headers();
  if (origin) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${project}/functions/v1/${surface}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test('standalone entrypoint refuses unbound deployment before preflight or shared member fallback', async () => {
  for (const change of [{BURIMUNSI_PRODUCT_MODE: undefined}, {BURIMUNSI_PRODUCT_MODE: 'shared'},
    {BURIMUNSI_COLLECTION_ID: undefined}, {COLLECT_DEPLOYMENT_PROFILE_SHA256: '0'.repeat(64)},
    {SUPABASE_URL: 'https://unapproved.example'}, {APP_ENVIRONMENT: 'qualification'}]) {
    const handler = createHandler('collect-api', () => ({...env, ...change}), {standalone: true, reportHealth: () => false});
    const actual = await handler(request('collect-api', '/v1/query/public-collections', 'GET'));
    assertEquals(actual.status, 503);
  }
});

Deno.test('standalone member, public discovery, and generic second-group and gateway creation routes are held before work admission', async () => {
  for (const [surface, method, path] of [
    ['collect-api', 'GET', '/v1/query/public-collections'],
    ['collect-api', 'GET', '/v1/sync'],
    ['collect-api', 'POST', '/v1/auth/refresh'],
    ['collect-api', 'GET', '/v1/auth/google/callback'],
    ['collect-api', 'POST', '/v1/rpc/create_private_group_metadata_v1'],
    ['collect-api', 'POST', '/v1/rpc/list_current_user_collections'],
    ['collect-api', 'POST', '/v1/rpc/create_contribution_intent'],
    ['admin-api', 'POST', '/api/admin/operations/groups'],
    ['admin-api', 'POST', '/api/admin/momo/accounts'],
    ['admin-api', 'POST', '/api/admin/momo/bindings'],
  ]) {
    const handler = createHandler(surface, () => env, {standalone: true, reportHealth: () => false});
    const response = await handler(request(surface, path, method));
    assertEquals(response.status, 404, `${method} ${path}`);
    assertEquals(await response.json(), {code: 'not_found'});
  }
});

Deno.test('standalone preserves native and dedicated Admin admission without broadening other browser origins', async () => {
  for (const [surface, path, method, origin, status] of [
    ['collect-api', '/v1/burimunsi/session/login', 'POST', project, 204],
    ['collect-api', '/v1/momo/gateway/profile', 'GET', project, 204],
    ['collect-api', '/v1/rpc/get_public_runtime_config', 'POST', project, 204],
    ['collect-api', '/v1/security/challenge?parent_origin=' + encodeURIComponent(BURIMUNSI_ADMIN_ORIGIN), 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['collect-api', '/privacy/account-deletion/assets/client.js', 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['collect-api', '/v1/privacy/email/challenge', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['collect-api', '/v1/rpc/get_current_account_deletion_request_status_v1', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['collect-api', '/v1/privacy/email/challenge', 'POST', 'https://other.example', 403],
    ['collect-api', '/v1/momo/gateway/profile', 'GET', BURIMUNSI_ADMIN_ORIGIN, 403],
    ['admin-api', '/api/admin/auth/session', 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/auth/session', 'GET', legacyAdmin, 204],
    ['admin-api', '/api/admin/auth/session', 'GET', 'https://other.example', 403],
  ] as const) {
    const handler = createHandler(surface, () => env, {standalone: true, reportHealth: () => false});
    const req = request(surface, path, 'OPTIONS', origin);
    req.headers.set('Access-Control-Request-Method', method);
    const response = await handler(req);
    assertEquals(response.status, status, `${path} from ${origin}`);
    assertEquals(response.headers.get('Access-Control-Allow-Origin'), status === 204 ? origin : null);
  }
  const sessionRequest = request('admin-api', '/api/admin/auth/session', 'GET', BURIMUNSI_ADMIN_ORIGIN);
  assertEquals(adminSessionOriginMatches(sessionRequest, env, profile, {origin: BURIMUNSI_ADMIN_ORIGIN}), true);
  assertEquals(adminSessionOriginMatches(sessionRequest, env, profile, {origin: legacyAdmin}), false);
  assertEquals(adminSessionOriginMatches(sessionRequest, {...env, BURIMUNSI_PRODUCT_MODE: undefined}, profile, {origin: BURIMUNSI_ADMIN_ORIGIN}), false);
});

Deno.test('standalone compares the only database collection with the configured scope under the runtime role', async () => {
  for (const ids of [[group], [], ['foreign-group'], [group, 'foreign-group']]) {
    const queries: string[] = [];
    const sql = {begin: async (fn: (tx: (parts: TemplateStringsArray) => Promise<unknown>) => Promise<unknown>) => {
      return await fn(async parts => {
        const query = parts.join('?');
        queries.push(query);
        if (query.startsWith('SET LOCAL ROLE')) return [];
        if (query.startsWith('SELECT private.collect_assert_deployment')) return [{allowed: true}];
        if (query === 'SELECT id FROM app.collections LIMIT 2') return ids.map(id => ({id}));
        throw new Error('unexpected statement');
      });
    }};
    if (ids.length === 1 && ids[0] === group) await assertRuntimeDeployment(sql, env, group);
    else await assertRejects(() => assertRuntimeDeployment(sql, env, group), Error, 'burimunsi_collection_mismatch');
    assertEquals(queries[0], 'SET LOCAL ROLE collect_runtime');
    assertEquals(queries.length, 3);
  }
});

Deno.test('standalone retains bounded phone privacy verification without member or email OTP enrollment', async () => {
  const send = (body: unknown) => logicalRequest(request('collect-api', '/v1/auth/otp', 'POST', undefined, body), 'collect-api');
  for (const body of [{surface: 'member', phone: '+250780000000'}, {surface: 'admin', phone: '+250780000000', allow_registration: false, should_create_user: false},
    {surface: 'member', email: 'test@example.invalid', allow_registration: false, should_create_user: false}]) {
    await assertRejects(() => handleAuth(send(body), env), Error, 'does not exist');
  }
  const phone = '+250780000000';
  const verify = request('collect-api', '/v1/auth/verify', 'POST', undefined, {
    surface: 'member', phone, challenge_id: '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001', code: '000000',
  });
  let scoped = false;
  const prepare = (query: string) => ({bind: (...values: unknown[]) => ({first: async () => {
    scoped = query.includes("pending.identity_type='phone' AND pending.registration_allowed=0 AND pending.identity_value=?") &&
      values.at(-1) === phone;
    return null;
  }})});
  await assertRejects(() => handleAuth(logicalRequest(verify, 'collect-api'), {...env, DB: {prepare}}), Error, 'request a new code');
  assertEquals(scoped, true);
});

Deno.test('standalone rejects an unrelated gateway before pairing or contact writes', async () => {
  let batches = 0;
  const db = {
    applicationWork: {assert: async () => {}},
    prepare: (sql: string) => ({bind: (...values: unknown[]) => ({sql, values, first: async () => ({pairing_code_sha256: 'a'.repeat(64)})})}),
    batch: async (entries: {sql: string}[]) => {
      batches++;
      assertEquals(entries[0].sql, 'SELECT private.burimunsi_gateway_pair_classify(?) AS classification');
      return [{success: true, results: [{classification: {kind: 'non_burimunsi'}}]}];
    },
  };
  const pair = request('collect-api', '/v1/momo/gateway/pair', 'POST', undefined, {
    pairing_code: 'fixture-pairing', installation_id: '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001',
  });
  const status = request('collect-api', '/v1/momo/gateway/status', 'GET');
  const heartbeat = request('collect-api', '/v1/momo/gateway/heartbeat', 'POST', undefined, {pending_count: 0});
  for (const [transport, message] of [[pair, 'pairing code is unavailable'], [status, 'gateway is no longer authorized'],
    [heartbeat, 'gateway is no longer authorized']] as const) {
    const logical = logicalRequest(transport, 'collect-api');
    logical.headers.set('Authorization', 'Bearer ' + 'a'.repeat(64));
    await assertRejects(() => momoGatewayRoute(logical, {...env, DB: db}), Error, message);
  }
  assertEquals(batches, 3);
});
