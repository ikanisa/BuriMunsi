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
  assert.equal(parent.status, 200);
  assert.match(await parent.text(), /Security verification · BuriMunsi/);
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

test('the BuriMunsi browser proxy refuses Collect routes and preserves exact privacy requests', async () => {
  let calls = 0;
  const worker = createAdminWorker({fetchImpl: async upstream => {
    calls++;
    assert.equal(upstream.url, vars.SUPABASE_URL + '/functions/v1/collect-api/v1/privacy/email/status');
    assert.equal(upstream.headers.get('Origin'), BURIMUNSI_ADMIN_ORIGIN);
    assert.equal(upstream.headers.get('Cookie'), null);
    return Response.json({status: 'synthetic'});
  }});
  for (const path of [
    '/v1/query/public-collections', '/v1/burimunsi/session', '/v1/momo/gateway/profile',
    '/functions/v1/collect-api/v1/auth/google/callback', '/privacy/account-deletion/other',
    '/v1/privacy/email/status', '/.well-known/assetlinks.json',
  ]) assert.equal((await worker.fetch(request(path), env)).status, 404, path);
  const response = await worker.fetch(request('/functions/v1/collect-api/v1/privacy/email/status', {
    method: 'POST',
    headers: {Origin: BURIMUNSI_ADMIN_ORIGIN, Cookie: `${BURIMUNSI_ADMIN_COOKIE}=private`},
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});
