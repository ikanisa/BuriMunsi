import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {canonicalProfile} from '../../../supabase/functions/_shared/deployment-profile.js';
import {BURIMUNSI_ADMIN_COOKIE, BURIMUNSI_ADMIN_ORIGIN, MANAGED_ADMIN_COOKIE} from '../src/admin-session-realm.js';
import {createAdminWorker} from '../src/index.js';

const config = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url)));
const {vars} = config;
const request = (path, options) => new Request(BURIMUNSI_ADMIN_ORIGIN + path, options);
const unexpected = () => { throw Error('Unexpected upstream or static route'); };
const env = {...vars, ASSETS: {fetch: unexpected}, PLATFORM_API: {fetch: unexpected}};

test('the BuriMunsi Worker selects its own custom domain and verified project profile', async () => {
  assert.equal(config.name, 'burimunsi-admin');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [{pattern: new URL(BURIMUNSI_ADMIN_ORIGIN).hostname, custom_domain: true}]);
  assert.equal(config.assets.run_worker_first, true);
  const parsed = JSON.parse(vars.COLLECT_DEPLOYMENT_PROFILE);
  assert.equal(parsed.admin_origin, BURIMUNSI_ADMIN_ORIGIN);
  const wrong = canonicalProfile({...parsed, public_origin: 'https://collect.ikanisa.com'});
  const worker = createAdminWorker({fetchImpl: unexpected});
  for (const changes of [
    {COLLECT_DEPLOYMENT_PROFILE: undefined, COLLECT_DEPLOYMENT_PROFILE_SHA256: undefined},
    {COLLECT_DEPLOYMENT_PROFILE_SHA256: '0'.repeat(64)},
    {COLLECT_BACKEND: 'cloudflare'},
    {SUPABASE_URL: 'https://other.example.test'},
    {COLLECT_DEPLOYMENT_PROFILE: wrong, COLLECT_DEPLOYMENT_PROFILE_SHA256: createHash('sha256').update(wrong).digest('hex')},
  ]) {
    const response = await worker.fetch(request('/api/admin/auth/session'), {...env, ...changes});
    assert.equal(response.status, 503);
  }
  const parent = await worker.fetch(request('/admin/auth/local-challenge'), env);
  assert.equal(parent.status, 404);
  assert.equal((await parent.json()).error.code, 'not_found');
});

test('BuriMunsi Admin isolates browser cookies and retains same-origin mutation custody', async () => {
  const path = '/api/admin/burimunsi/provisioning';
  const headers = {
    Cookie: `__Host-collect_admin=old; ${MANAGED_ADMIN_COOKIE}=old_project; ${BURIMUNSI_ADMIN_COOKIE}=buri`,
    Origin: BURIMUNSI_ADMIN_ORIGIN,
    'X-Collect-CSRF': 'synthetic-csrf',
    'Idempotency-Key': 'synthetic-original-request',
  };
  let calls = 0;
  const worker = createAdminWorker({fetchImpl: async upstream => {
    calls++;
    assert.equal(upstream.url, vars.SUPABASE_URL + '/functions/v1/admin-api' + path);
    assert.equal(upstream.headers.get('Origin'), BURIMUNSI_ADMIN_ORIGIN);
    assert.equal(upstream.headers.get('Cookie'), '__Host-collect_admin=buri');
    assert.equal(upstream.headers.get('X-Collect-CSRF'), headers['X-Collect-CSRF']);
    assert.equal(upstream.headers.get('Idempotency-Key'), headers['Idempotency-Key']);
    assert.equal(await upstream.text(), '{"approved":true}');
    return Response.json({ok: true}, {headers: {
      'Set-Cookie': '__Host-collect_admin=rotated; Path=/; HttpOnly; Secure; SameSite=Strict',
    }});
  }});
  const post = (route, options = {}) => worker.fetch(request(route, {
    method: 'POST', headers: {...headers, ...options}, body: '{"approved":true}',
  }), env);
  const response = await post(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Set-Cookie'),
    `${BURIMUNSI_ADMIN_COOKIE}=rotated; Path=/; HttpOnly; Secure; SameSite=Strict`);
  assert.equal((await post(path, {Origin: 'https://platform-admin.collect.ikanisa.com'})).status, 403);
  assert.equal((await post('/functions/v1/admin-api' + path)).status, 410);
  assert.equal((await post(path, {Cookie: `${BURIMUNSI_ADMIN_COOKIE}=first; ${BURIMUNSI_ADMIN_COOKIE}=second`})).status, 400);
  assert.equal(calls, 1);
});

test('the BuriMunsi browser proxy closes legacy auth, native and invitation routes before any upstream request', async () => {
  const worker = createAdminWorker({fetchImpl: unexpected});
  const paths = [
    ['GET', '/v1/query/public-collections'], ['GET', '/v1/burimunsi/session'], ['GET', '/v1/momo/gateway/profile'],
    ['POST', '/v1/burimunsi/managed/email-otp'], ['GET', '/functions/v1/collect-api/v1/auth/google/callback'],
    ['GET', '/v1/security/challenge?parent_origin=' + encodeURIComponent(BURIMUNSI_ADMIN_ORIGIN)],
    ['GET', '/functions/v1/collect-api/v1/security/challenge'], ['GET', '/admin/auth/local-challenge'],
    ['POST', '/v1/auth/otp'], ['POST', '/v1/auth/verify'], ['POST', '/v1/auth/logout'],
    ['POST', '/functions/v1/collect-api/v1/privacy/email/challenge'], ['POST', '/v1/privacy/email/verify'],
    ['POST', '/v1/privacy/email/status'], ['POST', '/v1/privacy/email/cancel'],
    ['POST', '/v1/rpc/request_account_deletion_v1'], ['GET', '/privacy/account-deletion/assets/client.js'],
    ['GET', '/privacy/account-deletion/other'], ['GET', '/.well-known/assetlinks.json'],
    ['POST', '/api/admin/auth/otp'], ['POST', '/api/admin/auth/verify'], ['POST', '/api/admin/auth/login'],
    ['POST', '/api/admin/auth/forgot-password'], ['POST', '/api/admin/auth/complete-password'],
    ['POST', '/api/admin/auth/change-password'], ['GET', '/api/admin/auth/email-verification'],
    ['POST', '/api/admin/auth/email/request'], ['POST', '/api/admin/auth/email/verify'],
    ['POST', '/api/admin/auth/google/start'], ['POST', '/api/admin/auth/google/exchange'],
    ['GET', '/api/admin/auth/mfa/factors'], ['POST', '/api/admin/auth/mfa/verify'],
    ['POST', '/api/admin/auth/mfa/recover'], ['GET', '/api/admin/auth/user'],
    ['POST', '/api/admin/burimunsi/access'],
    ['POST', '/api/admin/team/invite'], ['GET', '/api/admin/team/invitation-status'],
    ['POST', '/api/admin/team/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/resend'],
    ['GET', '/api/admin/team/v2'], ['POST', '/api/admin/team/v2/invite'],
    ['POST', '/api/admin/auth/session'], ['GET', '/api/admin/auth/phone-passcode'],
  ];
  for (const [method, path] of paths) {
    const headers = {Origin: BURIMUNSI_ADMIN_ORIGIN};
    const actual = request(path, {method, headers, ...(method === 'POST' ? {body: '{}'} : {})});
    const preflight = request(path, {method: 'OPTIONS', headers: {...headers, 'Access-Control-Request-Method': method}});
    for (const attempt of [actual, preflight]) {
      assert.equal((await worker.fetch(attempt, env)).status, 404, `${attempt.method} ${path}`);
    }
  }
});

test('the phone sign-in and passcode verification forms use the dedicated Admin transport', async () => {
  const routes = [['POST', 'auth/phone-passcode'], ['POST', 'auth/passcode/verify'], ['GET', 'auth/session'],
    ['POST', 'auth/logout'], ['GET', 'team']];
  const forwarded = [];
  const worker = createAdminWorker({fetchImpl: async upstream => {
    assert.equal(upstream.headers.get('Origin'), BURIMUNSI_ADMIN_ORIGIN);
    if (upstream.method === 'POST') assert.equal(await upstream.text(), '{}');
    forwarded.push([upstream.method, upstream.url]);
    const headers = upstream.url.endsWith('/auth/phone-passcode') ?
      {'Set-Cookie': '__Host-collect_admin=fixture; Path=/; Secure; HttpOnly; SameSite=Strict'} : {};
    return Response.json({ok: true}, {headers});
  }});
  for (const [method, path] of routes) {
    const mutation = method === 'POST' ? {headers: {Origin: BURIMUNSI_ADMIN_ORIGIN, 'Content-Type': 'application/json',
      'X-Collect-Requested-With': 'collect-admin'}, body: '{}'} :
      {headers: {Cookie: BURIMUNSI_ADMIN_COOKIE + '=fixture'}};
    assert.equal((await worker.fetch(request('/api/admin/' + path, {method, ...mutation}), env)).status, 200);
  }
  assert.deepEqual(forwarded, routes.map(([method, path]) => [method, vars.SUPABASE_URL + '/functions/v1/admin-api/api/admin/' + path]));
});

test('public BuriMunsi deletion support serves only its static document and stylesheet', async () => {
  const worker = createAdminWorker({fetchImpl: unexpected});
  const path = '/privacy/account-deletion';
  const response = await worker.fetch(request(path), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Collect-Document'), 'burimunsi.privacy.support.v1');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'.*form-action 'none'/);
  const document = await response.text();
  assert.match(document, /Contact support about account deletion/);
  assert.doesNotMatch(document, /<script\b|<form\b/);
  const alias = await worker.fetch(request('/functions/v1/collect-api' + path), env);
  assert.equal(await alias.text(), document);
  const style = await worker.fetch(request(path + '/assets/style.css'), env);
  assert.equal(style.headers.get('Content-Type'), 'text/css; charset=utf-8');
  const head = await worker.fetch(request(path, {method: 'HEAD'}), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
