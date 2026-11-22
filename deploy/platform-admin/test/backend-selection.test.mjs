import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import worker, {createAdminWorker} from '../src/index.js';
import {SUPABASE_ORIGIN, createCollectTransport} from '../src/supabase-transport.js';

const config = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url)));
const origin = config.vars.ADMIN_ORIGIN;
const cookie = '__Host-collect_admin=opaque_fixture; Path=/; Secure; HttpOnly; SameSite=Strict';
const browserCookie = cookie.replace('__Host-collect_admin=', '__Host-burimunsi_admin_rrlduytparvsjfmegalh=');
const req = (path, init) => new Request(origin + path, init);
const forbidden = () => { throw new Error('Unexpected service use'); };
const supabaseEnv = config.vars;

function environment(extra = {}) {
  return {COLLECT_BACKEND: 'cloudflare', ADMIN_ORIGIN: origin, ASSETS: {fetch: forbidden}, PLATFORM_API: {fetch: forbidden}, ...extra};
}

test('past product origins and Cloudflare service selection are closed', async () => {
  for (const other of ['https://admin-supabase-qa.collect.ikanisa.com', 'https://platform-admin.collect.ikanisa.com']) {
    const response = await worker.fetch(new Request(other + '/api/admin/auth/session'), environment({...supabaseEnv, ADMIN_ORIGIN: other}));
    assert.equal(response.status, 403);
  }
  const response = await worker.fetch(req('/api/admin/auth/session'), environment());
  assert.equal(response.status, 503);
});

test('explicit Supabase selection uses the nominated project once without touching Cloudflare or assets', async () => {
  let calls = 0;
  const content = new Uint8Array([0, 9, 123, 195, 169, 255]);
  const entry = createAdminWorker({fetchImpl: async upstream => {
    calls++;
    assert.equal(upstream.url, SUPABASE_ORIGIN + '/functions/v1/admin-api/api/admin/team?cursor=a%2Bb&cursor=c');
    assert.equal(upstream.method, 'PATCH');
    assert.deepEqual(new Uint8Array(await upstream.arrayBuffer()), content);
    for (const [name, value] of [['Origin', origin], ['Cookie', '__Host-collect_admin=managed_fixture'],
      ['Idempotency-Key', 'fixture-operation'], ['X-Collect-CSRF', 'fixture-csrf'],
      ['X-Collect-Requested-With', 'collect-admin'], ['X-Collect-Admin', '1']]) {
      assert.equal(upstream.headers.get(name), value);
    }
    return Response.json({ok: true}, {headers: {'Set-Cookie': cookie, 'Cache-Control': 'public'}});
  }});
  const response = await entry.fetch(req('/api/admin/team?cursor=a%2Bb&cursor=c', {
    method: 'PATCH', body: content, headers: {Origin: origin,
      Cookie: '__Host-collect_admin=old_fixture; __Host-burimunsi_admin_rrlduytparvsjfmegalh=managed_fixture',
      'Idempotency-Key': 'fixture-operation', 'X-Collect-CSRF': 'fixture-csrf',
      'X-Collect-Requested-With': 'collect-admin', 'X-Collect-Admin': '1'},
  }), environment(supabaseEnv));
  assert.equal(response.status, 200); assert.equal(calls, 1);
  assert.equal(response.headers.get('Set-Cookie'), browserCookie);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
});

test('Supabase entrypoint binds cold Admin reads to its configured frontend with no service fallback', async () => {
  for (const [path, method] of [['/api/admin/auth/session', 'GET'], ['/api/admin/team', 'HEAD']]) {
    let calls = 0;
    const entry = createAdminWorker({fetchImpl: async upstream => {
      calls++; assert.equal(upstream.headers.get('Origin'), origin);
      assert.equal(upstream.headers.get('Cookie'), '__Host-collect_admin=fixture');
      return new Response(null, {status: 204, headers: {'Set-Cookie': cookie}});
    }});
    const response = await entry.fetch(req(path, {method,
      headers: {'Sec-Fetch-Site': 'same-origin', Cookie: '__Host-burimunsi_admin_rrlduytparvsjfmegalh=fixture'},
    }), environment(supabaseEnv));
    assert.equal(response.status, 204); assert.equal(calls, 1);
    assert.equal(response.headers.get('Set-Cookie'), browserCookie); assert.equal(await response.text(), '');
  }
});

test('Supabase entrypoint retains lost Admin refresh uncertainty without service fallback', async () => {
  for (const [path, method] of [['/api/admin/auth/session', 'GET'], ['/api/admin/team', 'HEAD']]) {
    let calls = 0;
    const entry = createAdminWorker({fetchImpl: async () => {calls++; throw new Error('synthetic lost custody response');}});
    const response = await entry.fetch(req(path, {method}), environment(supabaseEnv));
    assert.equal(response.status, 502); assert.equal(calls, 1);
    assert.deepEqual(await response.json(), {code: 'proxy_outcome_unknown', reason: 'proxy_upstream_failure'});
  }
});

test('invalid explicit backend or project configuration refuses API and static use without fallback', async () => {
  let calls = 0;
  const entry = createAdminWorker({fetchImpl: async () => {calls++; throw new Error('Must not send');}});
  for (const fields of [{COLLECT_BACKEND: ''}, {COLLECT_BACKEND: 'SUPABASE'},
    {COLLECT_BACKEND: 'supabase'}, {COLLECT_BACKEND: 'supabase', SUPABASE_URL: 'https://other.supabase.co'},
    {COLLECT_BACKEND: 'supabase', SUPABASE_URL: SUPABASE_ORIGIN + '/'}]) {
    for (const path of ['/api/admin/auth/session', '/index.html']) {
      const response = await entry.fetch(req(path), environment(fields));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'backend_configuration_invalid');
    }
  }
  assert.equal(calls, 0);
});

test('dedicated host preserves ordinary static asset bytes and HTML no-transform behavior', async () => {
  for (const fields of [supabaseEnv]) {
    for (const [path, mime, body] of [['/index.html', 'text/html; charset=utf-8', '<html>exact fixture</html>'],
      ['/assets/a%20b.bin', 'application/octet-stream', 'exact fixture bytes'],
      ['/flutter_bootstrap.js', 'application/javascript', 'void 0;']]) {
      const original = new Response(body, {headers: {'Content-Type': mime, ETag: '"static-fixture"'}});
      let reads = 0;
      const response = await worker.fetch(req(path), environment({...fields, ASSETS: {fetch: async request => {
        reads++; assert.equal(request.url, origin + path); return original;
      }}}));
      assert.equal(await response.text(), body); assert.equal(reads, 1);
      assert.equal(response.headers.get('ETag'), '"static-fixture"');
      if (mime.startsWith('text/html')) assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
      else assert.equal(response, original);
    }
  }
});

test('Supabase managed paths cannot become SPA shells or another function', async () => {
  let calls = 0;
  const entry = createAdminWorker({fetchImpl: async () => {calls++; throw new Error('Must not send');}});
  for (const path of ['/api', '/api/unknown', '/v1', '/functions', '/functions/v1/other/v1/x',
    '/functions/v1/collect-api/api/admin/team', '/functions/v1/admin-api/v1/auth/otp']) {
    const response = await entry.fetch(req(path), environment(supabaseEnv));
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
  }
  assert.equal(calls, 0);
});

test('entrypoint rejects caller authority spoofing without an upstream effect', async () => {
  let calls = 0;
  const entry = createAdminWorker({fetchImpl: async () => {calls++; throw new Error('Must not send');}});
  for (const headers of [{Origin: 'https://evil.invalid'}, {'X-Collect-Actor': 'owner'}, {'X-Forwarded-Host': 'evil.invalid'}]) {
    const response = await entry.fetch(req('/api/admin/auth/session', {headers}), environment(supabaseEnv));
    assert.ok(response.status >= 400);
  }
  assert.equal(calls, 0);
});

test('entrypoint retires both upstream challenge aliases without provider or static fallback', async () => {
  const entry = createAdminWorker({fetchImpl: forbidden});
  for (const path of ['/v1/security/challenge', '/functions/v1/collect-api/v1/security/challenge']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await entry.fetch(req(path, {method}), environment(supabaseEnv));
      assert.equal(response.status, 404);
      assert.match(response.headers.get('Content-Type'), /^application\/json/);
    }
  }
});

test('post-dispatch mutation uncertainty stays explicit and never falls back to Cloudflare', async () => {
  let calls = 0;
  const entry = createAdminWorker({fetchImpl: async request => {
    calls++; assert.equal(request.headers.get('Idempotency-Key'), 'fixture-uncertain');
    return new Response('{}', {headers: {'Set-Cookie': cookie + '; Domain=.ikanisa.com'}});
  }});
  const response = await entry.fetch(req('/api/admin/auth/phone-passcode', {method: 'POST', body: '{}', headers: {Origin: origin, 'Idempotency-Key': 'fixture-uncertain'}}), environment(supabaseEnv));
  assert.equal(response.status, 502); assert.equal(calls, 1);
  assert.deepEqual(await response.json(), {code: 'proxy_outcome_unknown', reason: 'proxy_cookie_invalid'});
});

test('the dedicated profile serves only the bound BuriMunsi React package', () => {
  assert.equal(config.vars.COLLECT_BACKEND, 'supabase');
  assert.equal(config.vars.SUPABASE_URL, SUPABASE_ORIGIN);
  assert.equal(config.services, undefined);
  assert.equal(config.assets.directory, '../../build/admin-web');
  assert.equal(config.routes[0].pattern, new URL(origin).hostname);
});

test('integrated transport bytes retain the recorded current source identity', async () => {
  const provenance = JSON.parse(await readFile(new URL('../supabase-transport.provenance.json', import.meta.url), 'utf8'));
  const source = new URL('../src/', import.meta.url);
  const files = {...provenance.request_boundary_refactor.source_sha256s,
    ...provenance.frontend_session_realm_successor.source_sha256s,
    ...provenance.burimunsi_admin_successor.source_sha256s,
    ...provenance.standalone_admin_successor.source_sha256s,
    ...provenance.burimunsi_phone_passcode_successor.source_sha256s};
  const expected = (await readdir(source))
    .filter(name => /^(?:index|admin-session-realm|supabase-transport|transport-[\w-]+)\.js$/.test(name)).sort();
  assert.deepEqual(Object.keys(files).sort(), expected);
  assert.equal(provenance.source_sha256, files['supabase-transport.js']);
  for (const [file, digest] of Object.entries(files)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(file, source))).digest('hex'), digest, file);
  }
  assert.equal(provenance.base_source_sha256, '643a76d0a38e1023cc0edf38e5514e97e4eec565037c43d66b08648f351ba16c');
});


test('ordinary selection defaults to nominated Supabase and missing configuration never falls back', async () => {
  let calls = 0;
  const entry = createAdminWorker({fetchImpl: async upstream => {
    calls++; assert.equal(upstream.url, SUPABASE_ORIGIN + '/functions/v1/admin-api/api/admin/auth/session');
    return Response.json({user:null});
  }});
  const admitted = await entry.fetch(req('/api/admin/auth/session'), environment({...supabaseEnv, COLLECT_BACKEND:undefined}));
  assert.equal(admitted.status, 200); assert.equal(calls, 1);
  for (const path of ['/api/admin/auth/session','/index.html']) {
    const denied = await entry.fetch(req(path), environment({COLLECT_BACKEND:undefined}));
    assert.equal(denied.status, 503); assert.equal((await denied.json()).error.code,'backend_configuration_invalid');
  }
  assert.equal(calls, 1);
});

test('default native fetch retains its global receiver on both supported entrypoints', async () => {
  const original=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=function(request){if(this!==globalThis)throw new TypeError('Illegal invocation');calls++;assert.equal(request.url,SUPABASE_ORIGIN+'/functions/v1/admin-api/api/admin/auth/session');return Promise.resolve(Response.json({user:null}));};
    for(const handle of [request=>createAdminWorker().fetch(request,environment(supabaseEnv)),createCollectTransport({frontendOrigin:origin, allowedFrontendOrigins:[origin], burimunsi:true})]){
      const response=await handle(req('/api/admin/auth/session'));assert.equal(response.status,200);assert.deepEqual(await response.json(),{user:null});
    }
    assert.equal(calls,2);
  } finally {globalThis.fetch=original;}
});


test('unexpected native fetch diagnostics contain no request or exception secrets', async () => {
 const secret='synthetic-private-never-log',original=console.error,captured=[];let calls=0;
 try {
  console.error=(...args)=>captured.push(args);
  const entry=createAdminWorker({fetchImpl:async()=>{calls++;throw new TypeError('Illegal invocation '+secret);}});
  const response=await entry.fetch(req('/api/admin/auth/session?private='+secret,{headers:{Authorization:'Bearer '+secret}}),environment(supabaseEnv));
  assert.equal(response.status,502);assert.equal(calls,1);assert.deepEqual(await response.json(),{code:'proxy_outcome_unknown',reason:'proxy_upstream_failure'});
  assert.equal(captured.length,1);assert.equal(captured[0].length,1);assert.equal(typeof captured[0][0],'string');
  assert.deepEqual(JSON.parse(captured[0][0]),{service:'collect_web_transport',event:'proxy_runtime_failure',attempted:true,classification:'illegal_invocation'});
  assert.equal(JSON.stringify(captured).includes(secret),false);
 } finally {console.error=original;}
});
