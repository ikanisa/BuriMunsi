import assert from 'node:assert/strict';
import test from 'node:test';
import {createPaymentCommitFixture} from './payment-commit-fixture.mjs';

const base='http://127.0.0.1:4175/api/admin/burimunsi/payments/p-1';
const key='12345678-1234-4234-9234-123456789001';
const another='12345678-1234-4234-9234-123456789002';
const session={accountId:'admin',sessionId:'s-1',csrfToken:'synthetic'};
const payment={id:'p-1',groupId:'group-fixture',state:'unallocated',version:1};
const member={id:'m-1',display_name:'Fixture member'};
const json=(r,status,body)=>Object.assign(r,{status,body});
const readBody=async r=>r.body;
function setup() {
  const fx=createPaymentCommitFixture({payment,member,json,readBody});
  const request=async (suffix,method,body,options={})=>{
    const response={writeHead(code,headers){assert.equal(fx.readPayment().version,2);this.sentHeaders={code,headers};},
      write(fragment,callback){assert.equal(this.sentHeaders.code,200);assert(fragment.length < +this.sentHeaders.headers['Content-Length']);callback();},
      destroy(){assert.equal(fx.readPayment().version,2);this.disconnected=true;}};
    assert.equal(await fx.handle({method,body,headers:{'idempotency-key':options.key??key,
      'x-collect-csrf':options.csrf??session.csrfToken}}, response,new URL(base + suffix),
      options.session ?? session,options.allow??true),true);
    return response;
  };
  return {request,fx};
}

test('commits before disconnect, keeps read scoped and recovers once read returns',async()=>{
  const {request,fx}=setup();
  const body={memberId:member.id,expectedVersion:1};
  assert.equal((await request('/allocate','POST',body,{csrf:'wrong'})).status,403);
  assert.equal((await request('/allocate','POST',body,{allow:false})).status,403);
  assert.equal(fx.evidence().effects,0);
  assert.equal((await request('/allocate','POST',body)).disconnected,true);
  assert.equal(fx.readPayment().state,'allocated');
  assert.deepEqual((await request('/allocation-receipt','GET',null,{session:{...session,sessionId:'new-login'}})).body,
    {state:'unconfirmed',requestId:key});
  assert.deepEqual((await request('/allocation-receipt','GET',null,{key:another})).body,{state:'unconfirmed',requestId:another});
  assert.equal((await request('/allocation-receipt','GET')).status,503);
  assert.deepEqual((await request('/allocation-receipt','GET')).body,{state:'committed',requestId:key,
    receipt:{paymentId:payment.id,memberId:member.id,version:2}});
  assert.deepEqual(fx.evidence(),{views:0,writes:1,effects:1,lookupMatches:[false,false,true,true]});
});
test('rejects a second submission without changing synthetic state',async()=>{
  const {request,fx}=setup();
  const body={memberId:member.id,expectedVersion:1};
  await request('/allocate','POST',body);
  assert.equal((await request('/allocate','POST',body)).status,409);
  assert.equal(fx.evidence().effects,1);
  assert.equal(fx.evidence().writes,2);
});
