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
    ['POST', '/api/admin/auth/passcode/verify'], ['GET', '/api/admin/auth/passcode/change'],
    ['POST', '/api/admin/auth/google/start'], ['POST', '/api/admin/auth/google/exchange'],
    ['GET', '/api/admin/auth/mfa/factors'], ['POST', '/api/admin/auth/mfa/verify'],
    ['POST', '/api/admin/auth/mfa/recover'], ['GET', '/api/admin/auth/user'],
    ['POST', '/api/admin/burimunsi/access'],
    ['POST', '/api/admin/team/invite'], ['GET', '/api/admin/team/invitation-status'],
    ['POST', '/api/admin/team/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/resend'],
    ['GET', '/api/admin/team/v2'], ['POST', '/api/admin/team/v2/invite'],
    ['HEAD', '/api/admin/team'], ['PATCH', '/api/admin/team'], ['POST', '/api/admin/team'], ['GET', '/api/admin/team/accounts'],
    ['GET', '/api/admin/team/accounts/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/access'],
    ['POST', '/api/admin/team/accounts/7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001/role'],
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

test('dedicated phone sign-in, personal passcode changes and Team account operations forward exactly once', async () => {
  const id = '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025001';
  const create = '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025002', promote = '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025003', disable = '7dfc16fb-b3b8-4c2d-b6f8-bcbfd8025004';
  const access = 'team/accounts/' + id + '/access';
  const routes = [
    ['POST', 'auth/phone-passcode', {phone: '+250780000001', pin: '0123'}],
    ['GET', 'auth/session'], ['GET', 'team'],
    ['POST', 'team/accounts', {requestId: create, displayName: 'Fixture user', phone: '+250780000002', role: 'staff'}],
    ['POST', access, {requestId: promote, expectedVersion: 1, active: true, role: 'admin'}],
    ['POST', access, {requestId: disable, expectedVersion: 2, active: false}],
    ['POST', 'auth/passcode/change', {current: '0123', newPin: '8547', confirm: '8547'}],
    ['POST', 'auth/logout', {}],
  ];
  const attributes = '; Path=/; Secure; HttpOnly; SameSite=Strict';
  const forwarded = [];
  const worker = createAdminWorker({fetchImpl: async upstream => {
    forwarded.push({method: upstream.method, url: upstream.url, body: await upstream.text(), headers: upstream.headers});
    const headers = {};
    if (upstream.url.endsWith('/auth/phone-passcode')) headers['Set-Cookie'] = '__Host-collect_admin=issued' + attributes;
    if (upstream.url.endsWith('/auth/passcode/change') || upstream.url.endsWith('/auth/logout')) headers['Set-Cookie'] = '__Host-collect_admin=' + attributes + '; Max-Age=0';
    return Response.json({ok: true}, {headers});
  }});
  for (const [method, path, payload] of routes) {
    const signIn = path === 'auth/phone-passcode';
    const headers = {'X-Collect-Owner-Identity-Version': '1'};
    if (!signIn) headers.Cookie = BURIMUNSI_ADMIN_COOKIE + '=issued';
    const body = payload && JSON.stringify(payload);
    if (method === 'POST') {
      Object.assign(headers, {Origin: BURIMUNSI_ADMIN_ORIGIN, 'Content-Type': 'application/json', 'X-Collect-Requested-With': 'collect-admin'});
      if (!signIn) headers['X-Collect-CSRF'] = 'same-session-csrf';
      if (payload.requestId) headers['Idempotency-Key'] = payload.requestId;
    }
    const response = await worker.fetch(request('/api/admin/' + path, {method, headers, body}), env);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), {ok: true});
    assert.equal(forwarded.length, 1, path);
    const out = forwarded.pop();
    assert.equal(out.method, method);
    assert.equal(out.url, vars.SUPABASE_URL + '/functions/v1/admin-api/api/admin/' + path);
    assert.equal(out.body, body ?? '');
    assert.equal(out.headers.get('Origin'), BURIMUNSI_ADMIN_ORIGIN);
    assert.equal(out.headers.get('Cookie'), signIn ? null : '__Host-collect_admin=issued');
    assert.equal(out.headers.get('X-Collect-CSRF'), method === 'POST' && !signIn ? 'same-session-csrf' : null);
    assert.equal(out.headers.get('Idempotency-Key'), payload?.requestId ?? null);
    assert.equal(out.headers.get('X-Collect-Owner-Identity-Version'), path === 'auth/session' ? '1' : null);
    const clear = path === 'auth/passcode/change' || path === 'auth/logout';
    const expectedCookie = signIn ? '=issued' + attributes : clear ? '=' + attributes + '; Max-Age=0' : null;
    assert.equal(response.headers.get('Set-Cookie'), expectedCookie && BURIMUNSI_ADMIN_COOKIE + expectedCookie);
  }
});

test('SMS oversight uses the protected same-origin GET route and refuses changes', async () => {
  const path = '/api/admin/oversight/sms-health';
  let calls = 0;
  const worker = createAdminWorker({fetchImpl: async upstream => {
    calls++;
    assert.equal(upstream.method, 'GET');
    assert.equal(upstream.url, vars.SUPABASE_URL + '/functions/v1/admin-api' + path);
    assert.equal(upstream.headers.get('Cookie'), '__Host-collect_admin=fixture');
    return Response.json({scope: 'admin_sms_health'});
  }});
  const response = await worker.fetch(request(path, {headers: {Cookie: BURIMUNSI_ADMIN_COOKIE + '=fixture'}}), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control'), /\bno-store\b/);
  assert.equal((await worker.fetch(request(path, {method: 'POST', headers: {Origin: BURIMUNSI_ADMIN_ORIGIN}}), env)).status, 404);
  assert.equal((await worker.fetch(request(path, {headers: {Origin: 'https://collect.ikanisa.com'}}), env)).status, 403);
  assert.equal(calls, 1);
});

test('public BuriMunsi deletion support serves only its static document and stylesheet', async () => {
  const worker = createAdminWorker({fetchImpl: unexpected});
  const path = '/privacy/account-deletion';
  const response = await worker.fetch(request(path), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Collect-Document'), 'burimunsi.privacy.support.v1');
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'.*form-action 'none'/);
  const document = await response.text();
  assert.ok(document.includes('href="https://wa.me/250788767816" rel="noreferrer">Contact support on WhatsApp at +250 788 767 816</a>'));
  assert.doesNotMatch(document, /mailto:|<script\b|<form\b/i);
  const alias = await worker.fetch(request('/functions/v1/collect-api' + path), env);
  assert.equal(await alias.text(), document);
  const style = await worker.fetch(request(path + '/assets/style.css'), env);
  assert.equal(style.headers.get('Content-Type'), 'text/css; charset=utf-8');
  const head = await worker.fetch(request(path, {method: 'HEAD'}), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
