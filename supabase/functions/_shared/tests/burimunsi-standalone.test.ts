import {assertEquals, assertRejects} from 'jsr:@std/assert@1.0.14';
import {BURIMUNSI_ADMIN_ORIGIN, MANAGED_PRODUCTION_PROFILE_SHA256} from '../burimunsi-standalone.js';
import {canonicalProfile, MANAGED_SUPABASE_ORIGIN} from '../deployment-profile.js';
import {assertRuntimeDeployment} from '../deployment-database.js';
import {createHandler} from '../edge-http-handler.js';
import {logicalRequest} from '../edge-http-transport.js';
import {adminSessionOriginMatches, validateAdminOrigin} from '../admin-security.js';
import {handleAuth} from '../domain/auth.js';
import {momoGatewayRoute} from '../domain/momo_gateway.js';
import domain from '../domain/index.js';

const project = MANAGED_SUPABASE_ORIGIN;
const group = 'fixture-group';
const legacyAdmin = 'https://platform-admin.collect.ikanisa.com';
const legacyQA = 'https://admin-supabase-qa.collect.ikanisa.com';
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
    ['collect-api', '/privacy/account-deletion/assets/style.css', 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['collect-api', '/privacy/account-deletion', 'GET', 'https://other.example', 403],
    ['collect-api', '/v1/momo/gateway/profile', 'GET', BURIMUNSI_ADMIN_ORIGIN, 403],
    ['admin-api', '/api/admin/auth/phone-passcode', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/auth/passcode/change', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/team', 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/team/accounts', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/team/accounts/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/access', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/auth/session', 'GET', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/auth/logout', 'POST', BURIMUNSI_ADMIN_ORIGIN, 204],
    ['admin-api', '/api/admin/auth/session', 'GET', project, 204],
    ['admin-api', '/api/admin/auth/session', 'GET', legacyAdmin, 403],
    ['admin-api', '/api/admin/auth/session', 'GET', legacyQA, 403],
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
  for (const origin of [legacyAdmin, legacyQA]) {
    const oldSession = request('admin-api', '/api/admin/auth/session', 'GET', origin);
    assertEquals(adminSessionOriginMatches(oldSession, env, profile, {origin}), false);
    const login = request('admin-api', '/api/admin/auth/phone-passcode', 'POST', origin, {});
    login.headers.set('X-Collect-Requested-With', 'collect-admin');
    const handler = createHandler('admin-api', () => env, {standalone: true, reportHealth: () => false});
    assertEquals((await handler(login)).status, 403);
  }
  for (const origin of [BURIMUNSI_ADMIN_ORIGIN, project]) {
    const login = request('admin-api', '/api/admin/auth/phone-passcode', 'POST', origin, {});
    login.headers.set('X-Collect-Requested-With', 'collect-admin');
    assertEquals(validateAdminOrigin(login, env), origin);
    assertEquals(adminSessionOriginMatches(
      request('admin-api', '/api/admin/auth/session', 'GET', origin), env, profile, {origin},
    ), true);
  }
  assertEquals(adminSessionOriginMatches(sessionRequest, {...env, BURIMUNSI_PRODUCT_MODE: undefined}, profile, {origin: BURIMUNSI_ADMIN_ORIGIN}), false);
});

Deno.test('standalone rejects old Admin and direct member authentication before work or preflight admission', async () => {
  const routes = {
    'admin-api': [
      ['POST', '/api/admin/auth/otp'], ['POST', '/api/admin/auth/verify'], ['POST', '/api/admin/auth/passcode/verify'], ['POST', '/api/admin/auth/login'],
      ['POST', '/api/admin/auth/forgot-password'], ['POST', '/api/admin/auth/complete-password'],
      ['POST', '/api/admin/auth/change-password'], ['GET', '/api/admin/auth/email-verification'],
      ['POST', '/api/admin/auth/email/request'], ['POST', '/api/admin/auth/email/verify'],
      ['POST', '/api/admin/auth/google/start'], ['POST', '/api/admin/auth/google/exchange'],
      ['GET', '/api/admin/auth/mfa/factors'], ['POST', '/api/admin/auth/mfa/verify'],
      ['POST', '/api/admin/auth/mfa/recover'], ['GET', '/api/admin/auth/user'],
      ['POST', '/api/admin/burimunsi/access'],
      ['POST', '/api/admin/team/invite'], ['GET', '/api/admin/team/invitation-status'],
      ['POST', '/api/admin/team/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/resend'],
      ['GET', '/api/admin/team/v2'], ['GET', '/api/admin/team/v2/invitation-status'], ['POST', '/api/admin/team/v2/invite'],
      ['POST', '/api/admin/auth/session'], ['GET', '/api/admin/auth/phone-passcode'],
    ],
    'collect-api': [
      ['POST', '/v1/burimunsi/managed/email-otp'], ['POST', '/v1/auth/otp'], ['POST', '/v1/auth/verify'],
      ['GET', '/v1/security/challenge?parent_origin=' + encodeURIComponent(BURIMUNSI_ADMIN_ORIGIN)],
      ['POST', '/v1/auth/logout'], ['POST', '/v1/privacy/email/challenge'], ['POST', '/v1/privacy/email/verify'],
      ['POST', '/v1/privacy/email/status'], ['POST', '/v1/privacy/email/cancel'],
      ['POST', '/v1/rpc/request_account_deletion_v1'], ['POST', '/v1/rpc/get_account_deletion_request_status_v1'],
      ['POST', '/v1/rpc/get_current_account_deletion_request_status_v1'],
      ['POST', '/v1/rpc/get_account_deletion_review_status_v1'], ['GET', '/privacy/account-deletion/assets/client.js'],
    ],
  };
  for (const [surface, paths] of Object.entries(routes)) {
    const handler = createHandler(surface, () => env, {standalone: true, reportHealth: () => false});
    for (const [method, path] of paths) {
      const opts = request(surface, path, 'OPTIONS', BURIMUNSI_ADMIN_ORIGIN);
      opts.headers.set('Access-Control-Request-Method', method);
      const actual = request(surface, path, method, BURIMUNSI_ADMIN_ORIGIN, method === 'POST' ? {} : undefined);
      for (const attempt of [actual, opts]) {
        const response = await handler(attempt);
        assertEquals(response.status, 404, `${attempt.method} ${path}`);
        assertEquals(await response.json(), {code: 'not_found'});
        assertEquals(response.headers.get('Access-Control-Allow-Origin'), null);
      }
    }
  }
});

Deno.test('standalone direct deletion information remains available without account, database or OTP script', async () => {
  const handler = createHandler('collect-api', () => env, {standalone: true, reportHealth: () => false});
  const path = '/privacy/account-deletion';
  const response = await handler(request('collect-api', path, 'GET'));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('X-Collect-Document'), 'burimunsi.privacy.support.v1');
  const document = await response.text();
  const style = '/functions/v1/collect-api' + path + '/assets/style.css';
  assertEquals(document.includes(`href="${style}"`), true);
  assertEquals(document.includes('href="https://wa.me/250788767816" rel="noreferrer">Contact support on WhatsApp at +250 788 767 816</a>'), true);
  assertEquals(/mailto:|<form\b|<script\b|@collect\.ikanisa\.com/i.test(document), false);
  const head = await handler(request('collect-api', path, 'HEAD'));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), '');
  const stylesheet = await handler(request('collect-api', path + '/assets/style.css', 'GET'));
  assertEquals(stylesheet.status, 200);
  assertEquals(stylesheet.headers.get('Content-Type'), 'text/css; charset=utf-8');
});

Deno.test('installed BuriMunsi clients receive the published WhatsApp number from the public configuration', async () => {
  const operation = 'get_public_runtime_config';
  const channel = {key: 'support.whatsapp', channel_type: 'whatsapp', is_active: true, value: '+250788767816'};
  const previous = {version: 3, support_channels: [{key: 'support.email', value: 'old@example.test'}]};
  async function configuration(stored: unknown, standalone: boolean) {
    const DB = {prepare: (sql: string) => {
      assertEquals(sql, 'SELECT value_json FROM runtime_config WHERE key=?');
      return {bind: (key: string) => {
        assertEquals(key, operation);
        return {first: () => stored === undefined ? null : {value_json: JSON.stringify(stored)}};
      }};
    }};
    return await domain.fetch(new Request('https://example.test/v1/rpc/' + operation, {
      method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'},
    }), {DB, BURIMUNSI_PRODUCT_MODE: standalone ? 'standalone' : undefined}, {});
  }
  for (const [stored, expected] of [[previous, {version: 3, support_channels: [channel]}], [undefined, {support_channels: [channel]}]]) {
    const response = await configuration(stored, true);
    assertEquals(response.status, 200);
    assertEquals(await response.json(), expected);
  }
  const shared = await configuration(previous, false);
  assertEquals(await shared.json(), previous);
  assertEquals((await configuration([], true)).status, 503);
});

Deno.test('standalone compares the only database collection with the configured scope under the runtime role', async () => {
  for (const ids of [[group], [], ['foreign-group'], [group, 'foreign-group']]) {
    const queries: string[] = [];
    const sql = {begin: async (fn: (tx: (parts: TemplateStringsArray) => Promise<unknown>) => Promise<unknown>) => {
      return await fn(async parts => {
        const query = parts.join('?');
        queries.push(query);
        if (query.startsWith('SET LOCAL ROLE')) return [];
        if (query.startsWith('SELECT private.collect_assert_deployment') && query.includes('FROM (SELECT id FROM app.collections LIMIT 2)')) {
          return [{allowed: true, scope_matches: ids.length === 1 && ids[0] === group}];
        }
        throw new Error('unexpected statement');
      });
    }};
    if (ids.length === 1 && ids[0] === group) await assertRuntimeDeployment(sql, env, group);
    else await assertRejects(() => assertRuntimeDeployment(sql, env, group), Error, 'burimunsi_collection_mismatch');
    assertEquals(queries[0], 'SET LOCAL ROLE collect_runtime');
    assertEquals(queries.length, 2);
  }
});

Deno.test('standalone generic member auth dispatcher refuses all old identity operations before parsing', async () => {
  for (const [path, method] of [['otp', 'POST'], ['verify', 'POST'], ['refresh', 'POST'], ['logout', 'POST'],
    ['user', 'GET'], ['google/start', 'POST'], ['google/callback', 'GET']]) {
    const logical = logicalRequest(request('collect-api', '/v1/auth/' + path, method), 'collect-api');
    await assertRejects(() => handleAuth(logical, env), Error, 'does not exist');
  }
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
