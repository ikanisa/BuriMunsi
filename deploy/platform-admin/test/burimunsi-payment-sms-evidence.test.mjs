import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {BURIMUNSI_ADMIN_COOKIE, BURIMUNSI_ADMIN_ORIGIN, MANAGED_ADMIN_COOKIE} from '../src/admin-session-realm.js';
import {createAdminWorker} from '../src/index.js';

const {vars} = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url)));
const unexpected = () => assert.fail('SMS evidence must not use uncontrolled upstream or static assets');
const env = {...vars, ASSETS: {fetch: unexpected}, PLATFORM_API: {fetch: unexpected}};
const paymentId = '174545ba-f3ac-4f06-8f69-6bc7b7a61c95';
const payment = '/api/admin/burimunsi/payments/' + paymentId;
const path = payment + '/sms-evidence';
const headers = {
  'Sec-Fetch-Site':'same-origin',
  Cookie:`__Host-collect_admin=retired; ${MANAGED_ADMIN_COOKIE}=other_realm; ${BURIMUNSI_ADMIN_COOKIE}=synthetic`,
};
function request(route = path, method = 'GET', requestHeaders = headers) {
  return new Request(BURIMUNSI_ADMIN_ORIGIN + route, {method,headers:requestHeaders});
}
function assertPrivate(response) {
  assert.match(response.headers.get('Cache-Control') ?? '', /\bprivate\b/);
  assert.match(response.headers.get('Cache-Control') ?? '', /\bno-store\b/);
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Surrogate-Control'), 'no-store');
  assert.equal(response.headers.get('Set-Cookie'), null);
}

test('Payment SMS evidence dispatches one exact same-origin GET with only the BuriMunsi session', async () => {
  let calls = 0;
  const result = {paymentId,groupId:'synthetic-group',evidence:null};
  const worker = createAdminWorker({fetchImpl:async upstream=>{
    calls++;
    assert.equal(upstream.method, 'GET');
    assert.equal(upstream.url, vars.SUPABASE_URL + '/functions/v1/admin-api' + path);
    assert.equal(upstream.headers.get('Origin'), BURIMUNSI_ADMIN_ORIGIN);
    assert.equal(upstream.headers.get('Cookie'), '__Host-collect_admin=synthetic');
    assert.equal(upstream.headers.get('Cache-Control'), 'no-store');
    assert.equal(upstream.body, null);
    return Response.json(result, {headers:{'Cache-Control':'public, max-age=86400'}});
  }});
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});

test('Payment SMS evidence refuses wrong methods, suffixed paths, and a sibling origin without dispatch', async () => {
  let calls = 0;
  const worker = createAdminWorker({fetchImpl:async()=>{
    calls++;
    return Response.json({unexpected:true});
  }});
  const wrongMethods = ['HEAD','POST','PATCH','DELETE'];
  for (const method of wrongMethods) {
    const response = await worker.fetch(request(path, method, {...headers, Origin:BURIMUNSI_ADMIN_ORIGIN}), env);
    assert.equal(response.status, 404, method);
  }
  for (const suffix of ['/', '/content']) {
    assert.equal((await worker.fetch(request(path + suffix), env)).status, 404, suffix);
  }
  assert.equal((await worker.fetch(request(path, 'GET', {...headers, Origin:'https://sibling.example.test'}), env)).status, 403);
  assert.equal(calls, 0);
});

test('Payment SMS evidence permission refusal remains private and does not trigger a second call', async () => {
  let calls = 0;
  const result = {error:{code:'forbidden',message:'Access denied'}};
  const worker = createAdminWorker({fetchImpl:async()=>{
    calls++;
    return Response.json(result, {status:403});
  }});
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 403);
  assertPrivate(response);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});
