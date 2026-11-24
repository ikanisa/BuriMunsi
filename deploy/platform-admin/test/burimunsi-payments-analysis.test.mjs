import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {BURIMUNSI_ADMIN_COOKIE, BURIMUNSI_ADMIN_ORIGIN, MANAGED_ADMIN_COOKIE} from '../src/admin-session-realm.js';
import {createAdminWorker} from '../src/index.js';

const {vars} = JSON.parse(await readFile(new URL('../wrangler.burimunsi.jsonc', import.meta.url)));
const absent = () => assert.fail('Analysis must not use an uncontrolled upstream or static asset');
const env = {...vars, ASSETS: {fetch: absent}, PLATFORM_API: {fetch: absent}};
const path = '/api/admin/burimunsi/payments/analysis';
const payload = {
  q:'Fixture',offset:0,limit:25,
  filters:[
    {key:'time',presence:'any',text:'',min:'2026-11-24',max:'2026-11-24',choices:[]},
    {key:'amount',presence:'present',text:'',min:'9007199254740990',max:'9007199254740991',choices:[]},
  ],
  sort:{key:'amount',direction:'desc'},
};
const bytes = JSON.stringify(payload);
const headers = {
  Origin:BURIMUNSI_ADMIN_ORIGIN,
  Cookie:`__Host-collect_admin=retired; ${MANAGED_ADMIN_COOKIE}=old_project; ${BURIMUNSI_ADMIN_COOKIE}=fixture`,
  'Content-Type':'application/json',
  'X-Collect-Requested-With':'collect-admin',
  'X-Collect-CSRF':'fixture-session-csrf',
};
function post(route=path, requestHeaders=headers){
  return new Request(BURIMUNSI_ADMIN_ORIGIN+route,{method:'POST',headers:requestHeaders,body:bytes});
}
function assertPrivate(response){
  assert.match(response.headers.get('Cache-Control') ?? '',/\bprivate\b/);
  assert.match(response.headers.get('Cache-Control') ?? '',/\bno-store\b/);
  assert.equal(response.headers.get('Set-Cookie'),null);
}

test('Payments analysis forwards one same-origin, scoped POST and preserves exact decimal strings',async()=>{
  let calls=0;
  const total='18014398509481982';
  const row = {id:'fixture-payment',groupId:'fixture-group',version:1,direction:'incoming',amountRwf:9007199254740991,
    atRaw:'2026-11-23T22:00:00.000Z',ftId:'fixture-ft',payerNameRaw:'Fixture',payerPhoneRaw:'',memberId:null,memberName:null,memberPhone:null,
    state:'unallocated',sourceId:null};
  const responseValue={items:[row,{...row,id:'fixture-payment-2',ftId:'fixture-ft-2'}],totalCount:2,matchingCount:2,directionTotalsRwf:{incoming:total,outgoing:'0'},
    missing:0,offset:0,limit:25,asOf:'2026-11-24T08:00:00.000Z'};
  const worker=createAdminWorker({fetchImpl:async upstream=>{
    calls++;
    assert.equal(upstream.method,'POST');
    assert.equal(upstream.url,vars.SUPABASE_URL+'/functions/v1/admin-api'+path);
    assert.equal(upstream.headers.get('Origin'),BURIMUNSI_ADMIN_ORIGIN);
    assert.equal(upstream.headers.get('Cookie'),'__Host-collect_admin=fixture');
    assert.equal(upstream.headers.get('X-Collect-CSRF'),headers['X-Collect-CSRF']);
    assert.equal(upstream.headers.get('X-Collect-Requested-With'),'collect-admin');
    assert.equal(upstream.headers.get('Idempotency-Key'),null);
    assert.equal(await upstream.text(),bytes);
    return Response.json(responseValue);
  }});
  const response=await worker.fetch(post(),env);
  assert.equal(response.status,200);
  assertPrivate(response);
  assert.deepEqual(await response.json(),responseValue);
  assert.equal(calls,1);
});

test('Payments analysis scope refusal is a private no-data result, with no transport retry',async()=>{
  let calls=0;
  const rejected={error:{code:'payment_analysis_scope_too_large',message:'The analysis could not be completed.'}};
  const worker=createAdminWorker({fetchImpl:async()=>{
    calls++;
    return Response.json(rejected,{status:503});
  }});
  const response=await worker.fetch(post(),env);
  assert.equal(response.status,503);
  assertPrivate(response);
  assert.deepEqual(await response.json(),rejected);
  assert.equal(calls,1);
});

test('The Worker refuses an unapproved analysis origin or unrelated method before forwarding',async()=>{
  const worker=createAdminWorker({fetchImpl:absent});
  assert.equal((await worker.fetch(post(path,{...headers,Origin:'https://sibling.example.test'}),env)).status,403);
  for(const method of ['GET','PATCH','DELETE']){
    const response=await worker.fetch(new Request(BURIMUNSI_ADMIN_ORIGIN+path,{method,headers}),env);
    assert.equal(response.status,404,method);
  }
  assert.equal((await worker.fetch(post(path+'/other'),env)).status,404);
});
