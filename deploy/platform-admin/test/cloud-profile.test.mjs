import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createAdminWorker} from '../src/index.js';
import {canonicalProfile} from '../../../supabase/functions/_shared/deployment-profile.js';

const {vars} = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url)));
const encoded = vars.COLLECT_DEPLOYMENT_PROFILE;
const profile = JSON.parse(encoded);
const env = {...vars,
  ASSETS:{fetch(){throw Error('Unexpected static fallback');}},PLATFORM_API:{fetch(){throw Error('Unexpected legacy backend');}}};
const request = (path, options={}) => new Request(profile.admin_origin+path,options);

test('Cloud Admin binds the verified profile and preserves same-origin cookie authority', async()=>{
  let calls=0;
  const worker=createAdminWorker({fetchImpl:async upstream=>{
    calls++;
    assert.equal(upstream.url,profile.supabase_origin+'/functions/v1/admin-api/api/admin/auth/session');
    assert.equal(upstream.headers.get('origin'),profile.admin_origin);
    assert.equal(upstream.headers.get('cookie'),'__Host-collect_admin=original');
    return Response.json({user:null});
  }});
  assert.equal((await worker.fetch(request('/api/admin/auth/session',{headers:{Cookie:'__Host-burimunsi_admin_rrlduytparvsjfmegalh=original'}}),env)).status,200);
  assert.equal(calls,1);
});

test('dedicated Team mutations preserve same-origin CSRF, request identity and exact bytes', async () => {
  const id = '482d2b4b-9ad8-4708-ac59-38982fe4a4ef';
  const path = '/api/admin/team/accounts/' + id + '/access';
  const requestId = '9f34a000-5ec2-4255-851c-b4e530ee5000';
  const body = JSON.stringify({requestId, expectedVersion: 1, active: true, role: 'admin'}, null, 2);
  const csrf = 'same-session-csrf', receipt = {applied: true, id, version: 2};
  let calls = 0;
  const worker = createAdminWorker({fetchImpl: async upstream => {
    calls++;
    assert.equal(upstream.url, profile.supabase_origin + '/functions/v1/admin-api' + path);
    assert.equal(upstream.headers.get('origin'), profile.admin_origin);
    assert.equal(upstream.headers.get('cookie'), '__Host-collect_admin=fixture');
    assert.equal(upstream.headers.get('idempotency-key'), requestId);
    assert.equal(await upstream.text(), body);
    if (upstream.headers.get('x-collect-csrf') !== csrf) return Response.json({error: {code: 'csrf_invalid'}}, {status: 403});
    return Response.json(receipt);
  }});
  const post = headers => worker.fetch(request(path, {method: 'POST', body, headers: {'Content-Type': 'application/json',
    Cookie: '__Host-burimunsi_admin_rrlduytparvsjfmegalh=fixture', 'Idempotency-Key': requestId, ...headers}}), env);
  for (const headers of [{'X-Collect-CSRF': csrf}, {Origin: 'https://other.example.test', 'X-Collect-CSRF': csrf}]) {
    assert.equal((await post(headers)).status, 403);
  }
  assert.equal(calls, 0);
  const missing = await post({Origin: profile.admin_origin});
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), {error: {code: 'csrf_invalid'}});
  const accepted = await post({Origin: profile.admin_origin, 'X-Collect-CSRF': csrf});
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), receipt);
  assert.equal(calls, 2);
});

test('profile hash, environment, public origin, and upstream override all fail before dispatch',async()=>{
  let calls=0;const worker=createAdminWorker({fetchImpl:async()=>{calls++;throw Error('Unexpected upstream');}});
  const foreign = canonicalProfile({...profile, public_origin:'https://collect.ikanisa.com'});
  for(const changes of [
    {COLLECT_DEPLOYMENT_PROFILE:foreign,COLLECT_DEPLOYMENT_PROFILE_SHA256:createHash('sha256').update(foreign).digest('hex')},
    {COLLECT_DEPLOYMENT_PROFILE_SHA256:'0'.repeat(64)}, {COLLECT_DEPLOYMENT_PROFILE:encoded+' '},
    {SUPABASE_URL:'https://other.example.test'}, {APP_ENVIRONMENT:'qualification'},
    {COLLECT_BACKEND:'cloudflare'}, {SUPABASE_INTERNAL_URL:'http://kong:8000'},
    {SUPABASE_INTERNAL_URL:'http://untrusted.example.com'}, {SUPABASE_INTERNAL_URL:'https://supabase.example.test/elsewhere'},
    {SUPABASE_INTERNAL_URL:profile.supabase_origin},
  ])for(const path of ['/api/admin/auth/session','/index.html']){
    assert.equal((await worker.fetch(request(path),{...env,...changes})).status,503);
  }
  assert.equal(calls,0);
});

test('sibling configured frontend does not gain Admin request authority',async()=>{
  let calls=0;const worker=createAdminWorker({fetchImpl:async()=>{calls++;throw Error('Unexpected upstream');}});
  for(const origin of ['https://collect.ikanisa.com','https://api.collect.ikanisa.com','https://unrelated.example.test']){
    assert.equal((await worker.fetch(request('/api/admin/team',{headers:{Origin:origin}}),env)).status,403);
  }
  assert.equal(calls,0);
});

test('Cloud Admin refuses the retired human challenge without contacting a provider',async()=>{
  let calls=0;const worker=createAdminWorker({fetchImpl:async()=>{calls++;throw Error('Unexpected provider');}});
  const response=await worker.fetch(request('/admin/auth/local-challenge'),env);
  assert.equal(response.status,404);assert.equal((await response.json()).error.code,'not_found');
  assert.equal(calls,0);
});
