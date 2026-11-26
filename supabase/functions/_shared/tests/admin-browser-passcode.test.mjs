import assert from 'node:assert/strict';
import test from 'node:test';
import {createCollectTransport} from "../../../../deploy/platform-admin/src/supabase-transport.js";
import {BURIMUNSI_ADMIN_COOKIE} from "../../../../deploy/platform-admin/src/admin-session-realm.js";
import {handleAdmin} from '../domain/admin_bridge.js';
import {standaloneAdminRoute} from '../burimunsi-standalone.js';
import {accountReadDatabase} from '../domain/admin_accounts.js';
import {adminAccountSession, adminCanonicalActor} from '../domain/admin_session.js';
import {digest} from '../domain/core.js';
import {adminEmailProofId, requireFreshAdminEmail} from '../domain/admin_email_policy.js';
import {nativePinHasher} from '../domain/burimunsi/native-secrets.js';

const origin = 'https://burimunsi-admin.ikanisa.com';
const phone = '+250780000111';
const staffPhone = '+250780000222';
const pin = '2468';
const group = 'synthetic-group';
const owner = 'synthetic-owner';
const principal = 'synthetic-principal';

function routeRequest(path, {body, cookie, csrf, from = origin, bearer} = {}) {
  const headers = new Headers({Origin: from});
  if (body) {
    headers.set('X-Collect-Requested-With', 'collect-admin');
    headers.set('Content-Type', 'application/json');
  }
  if (cookie) headers.set('Cookie', cookie);
  if (csrf) headers.set('X-Collect-CSRF', csrf);
  if (bearer) headers.set('Authorization', 'Bearer '+bearer);
  return new Request(origin + '/api/admin/' + path,
    {method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined});
}
const request = (path, options) => routeRequest('auth/' + path, options);

async function fixture({role = 'admin'} = {}) {
  const env = {BURIMUNSI_PRODUCT_MODE:'standalone', BURIMUNSI_COLLECTION_ID:group,
    ADMIN_ORIGINS:origin, BURIMUNSI_PIN_PEPPER_ID:'synthetic-v1',
    BURIMUNSI_PIN_PEPPER_BASE64:Buffer.alloc(32, 17).toString('base64')};
  const account = {id:crypto.randomUUID(), role, phone: role === 'staff' ? staffPhone : phone, credentialVersion:1, version:1,
    pinHash:await nativePinHasher(env).hash(role === 'staff' ? staffPhone : phone, pin)};
  const sessions = new Map();
  let budgetAllowed = true;
  let issued = 0;
  let changes = 0;
  env.DB = {setBrowserPasscodeAccount: account => assert.equal(account.principal_id, principal),
    prepare: statement => ({bind: (...values) => ({sql:statement, values, first: async () => {
    assert.equal(values[0], group);
    let result;
    if (statement.includes('browser_pin_candidate(')) {
      assert.equal(values[2], await digest(values[1]));
      assert.match(values[4], /^[a-f0-9]{64}$/);
      result = {allowed:budgetAllowed, account:budgetAllowed && values[1] === account.phone ? account : null};
    } else if (statement.includes('browser_pin_issue(')) {
      const [, accountId, credentialVersion, version, hash, sessionId, publicId, boundOrigin] = values;
      assert.equal(accountId, account.id);
      assert.equal(credentialVersion, account.credentialVersion);
      assert.equal(version, account.version);
      assert.equal(boundOrigin, origin);
      assert.match(hash, /^[a-f0-9]{64}$/);
      const now = Math.floor(Date.now()/1000);
      sessions.set(hash,{adminId:owner, principalId:principal, verifiedAt:now, expiresAt:now+1800,
        proofId:crypto.randomUUID(), accountId, authVersion:1, collectionId:group, sessionId, publicId,
        name:'Synthetic Operator', email:role === 'admin' ? 'owner@example.test' : null, permissions:['overview.read'],
        phone:account.phone, operatorRole:role, storageRole:role === 'admin' ? 'owner':'staff', accountVersion:account.version, credentialVersion:account.credentialVersion});
      issued++;
      result = true;
    } else if (statement.includes('browser_pin_session(')) {
      assert.equal(values[2], origin);
      result = sessions.get(values[1])??null;
    } else if (statement.includes('browser_pin_change(')) {
      const session = sessions.get(values[1]);
      assert.equal(session.accountId, values[3]);
      assert.equal(values[4], account.credentialVersion);
      account.pinHash=JSON.parse(values[6]);
      account.credentialVersion++; account.version++; sessions.clear(); changes++;
      result = true;
    } else if (statement.includes('browser_pin_logout(')) {
      assert.equal(values[2], origin);
      result = sessions.delete(values[1]);
    } else {
      assert.fail('Unexpected SQL');
    }
    return {result};
  }})})};
  return {env, denyBudget:()=>{budgetAllowed=false;}, issued:()=>issued, changes:()=>changes,
    setGrants: permissions => {for (const session of sessions.values()) session.permissions=permissions;}};
}

test('the existing native Admin credentials open an opaque same-origin browser session', async () => {
  const {env, issued} = await fixture();
  const response = await handleAdmin(request('phone-passcode',{body:{phone:'0780000111',pin}}),env);
  assert.equal(response.status, 200);
  const value = await response.json();
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^__Host-collect_admin=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800; Secure$/);
  const browserCookie = cookie.split(';')[0];
  assert.equal(value.sessionContract, undefined);
  assert.equal(value.user.role, 'admin');
  assert.equal(value.user.accountId,value.adminIdentity.accountId);
  assert.equal(value.adminIdentity.principalId,principal);
  assert.equal(value.user.authMethod, 'phone_passcode');
  assert.equal(Object.hasOwn(value.user,'email'),false);
  assert.equal(Object.hasOwn(value,'ownerIdentity'),false);
  assert.equal(value.ownerEmail,null);
  assert.equal(value.user.phone, phone);
  assert.equal(issued(), 1);

  const sessionRequest = request('session',{cookie:browserCookie});
  sessionRequest.headers.set('X-Collect-Owner-Identity-Version','1');
  const session = await (await handleAdmin(sessionRequest,env)).json();
  assert.ok(!JSON.stringify(session).includes('owner@example.test'));
  assert.equal(Object.hasOwn(session,'ownerIdentity'),false);
  assert.equal(session.user.sessionId, value.user.sessionId);
  assert.equal(session.csrfToken, value.csrfToken);
  const account = await adminAccountSession(sessionRequest,env);
  const actor = await adminCanonicalActor(sessionRequest,env,account,'overview.read');
  assert.equal(actor.userId, principal);
  assert.equal(actor.assuranceLevel, 1);
  assert.equal(adminEmailProofId(actor), null);
  assert.ok(requireFreshAdminEmail(actor));

  const retired = await handleAdmin(request('passcode/verify',{body:{pin},cookie:browserCookie,csrf:value.csrfToken}),env);
  assert.equal(retired.status,404);

  const logout = await handleAdmin(request('logout',{body:{},cookie:browserCookie,csrf:value.csrfToken}),env);
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await (await handleAdmin(sessionRequest,env)).json()).user,null);
});

test('a phone Admin receives the contracted scoped session directly when requested', async () => {
  const {env} = await fixture();
  const attempt = request('phone-passcode',{body:{phone,pin}});
  attempt.headers.set('X-Collect-Owner-Identity-Version','1');
  const login = await handleAdmin(attempt,env);
  assert.equal(login.status,200);
  const value = await login.json();
  assert.equal(value.sessionContract,2);
  assert.equal(value.user.role,'admin');
  assert.equal(value.user.accountId,value.adminIdentity.accountId);
  assert.equal(value.adminIdentity.principalId,principal);
  assert.match(login.headers.get('Set-Cookie'),/^__Host-collect_admin=/);
});

test('standalone browser auth refuses unregistered numbers, legacy auth, untrusted origin and exhausted PIN budget', async () => {
  const {env, issued, denyBudget} = await fixture();
  const staff = await handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin}}),env);
  assert.equal(staff.status,401);
  assert.equal(staff.headers.get('Set-Cookie'),null);
  const old = await handleAdmin(request('otp',{body:{email:'former@example.test'}}),env);
  assert.equal(old.status,404);
  const wrongOrigin = await handleAdmin(request('phone-passcode',{body:{phone,pin},from:'https://other.example.test'}),env);
  assert.equal(wrongOrigin.status,403);
  const foreignToken = await handleAdmin(request('session',{bearer:'foreign-provider-token'}),env);
  assert.equal(foreignToken.status,403);
  denyBudget();
  assert.equal((await handleAdmin(request('phone-passcode',{body:{phone,pin}}),env)).status,429);
  assert.equal(issued(),0);
});

test('Staff receive their own limited account and can optionally change their passcode',async()=>{
  const {env,changes}=await fixture({role:'staff'});
  const attempt=request('phone-passcode',{body:{phone:staffPhone,pin}});
  attempt.headers.set('X-Collect-Owner-Identity-Version','1');
  const login=await handleAdmin(attempt,env);
  assert.equal(login.status,200);
  const data=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal(data.sessionContract,2);
  assert.equal(data.user.role,'staff');
  assert.equal(Object.hasOwn(data.user,'email'),false);
  assert.equal(data.adminIdentity,undefined);
  const change={current:pin,newPin:'9043',confirm:'9043'};
  const send=(body,csrf=data.csrfToken)=>handleAdmin(request('passcode/change',{body,cookie,csrf}),env);
  assert.equal((await send(change,'wrong')).status,403);
  assert.equal((await send({...change,current:'9032'})).status,401);
  assert.equal((await send({...change,confirm:'9143'})).status,400);
  assert.equal((await send({...change,phone})).status,400);
  assert.equal(changes(),0);
  const response=await send(change);
  assert.equal(response.status,200);
  assert.match(response.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal(changes(),1);
  assert.equal((await (await handleAdmin(request('session',{cookie}),env)).json()).user,null);
  assert.equal((await handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin}}),env)).status,401);
  assert.equal((await handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin:change.newPin}}),env)).status,200);
});

function useCanonicalPayments(env,role) {
  let reads=0;
  const unsupported=()=>assert.fail('a read attempted a mutation');
  const sourceId=crypto.randomUUID();
  Object.assign(env.DB,{transaction:unsupported,context:unsupported,readContext:unsupported,applicationWork:{assert:async()=>{}},
    withLockedReadSnapshot:fn=>fn({unsafe:async(sql,args)=>{
      if(sql.startsWith('SELECT set_config')){assert.deepEqual(args,[group]);return [];}
      if(sql.includes('burimunsi_browser_pin_session')){
        assert.equal(args[0],group);assert.match(sql,/private\.assert_actor\('payments.read'/);return [{role,can_allocate:false}];
      }
      assert.match(sql,/FROM burimunsi\.payments/);assert.equal(args[0],group);reads++;
      return [{id:'synthetic-payment',collection_id:group,direction:'incoming',amount_rwf:100,version:1,total:1,
        source_time:'synthetic original time',allocation_state:'unallocated',sms_source_id:sourceId}];
    }})});
  return {sourceId,reads:()=>reads};
}

test('an existing Staff cookie keeps Payments and loses inherited SMS access on all direct receipt routes', async () => {
  const {env,setGrants} = await fixture({role:'staff'});
  const login = await handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin}}),env);
  assert.equal(login.status,200);
  const {csrfToken} = await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  setGrants(['overview.read','payments.read','sms.read','sms.reveal','sms.extract']);
  const sessionRequest=request('session',{cookie});
  const renewed=await (await handleAdmin(sessionRequest,env)).json();
  assert.deepEqual(renewed.user.permissions,['overview.read','payments.read']);
  const account=await adminAccountSession(sessionRequest,env);
  const actor=await adminCanonicalActor(sessionRequest,env,account,'payments.read');
  assert.deepEqual([...actor.permissions],['overview.read','payments.read']);

  const canonical=useCanonicalPayments(env,'staff');
  env.DB.adminReadBatch=async()=>assert.fail('Staff reached a protected SMS read');
  assert.throws(()=>accountReadDatabase(env,account,'sms.read'),{status:403,code:'permission_required'});
  env.BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED='true';
  const receiptId=crypto.randomUUID();
  for(const path of ['sms/receipts',`sms/receipts/capture/${receiptId}`,`sms/receipts/capture/${receiptId}/content`,
    'momo/observations',`momo/observations/${receiptId}/content`]){
    const response=await handleAdmin(routeRequest(path,{cookie}),env);
    assert.equal(response.status,403,path);
  }
  const live=await handleAdmin(routeRequest('sync/live',{cookie,body:{},csrf:csrfToken}),env);
  assert.equal(live.status,403);
  for(const path of ['gateway/receipts',`gateway/receipts/${receiptId}`,'momo/sources',`momo/sources/${receiptId}/content`,'momo/transactions']){
    assert.equal((await handleAdmin(routeRequest(path,{cookie}),env)).status,404,path);
  }
  assert.equal(canonical.reads(),0);
  const payments=await handleAdmin(routeRequest('burimunsi/payments',{cookie}),env);
  assert.equal(payments.status,200);
  const {items}=await payments.json();assert.equal(items.length,1);assert.equal(items[0].sourceId,null);
  assert.equal(canonical.reads(),1);
});

test('a phone Admin needs both current grants to read full payment source history',async()=>{
  const {env,setGrants}=await fixture();
  const login=await handleAdmin(request('phone-passcode',{body:{phone,pin}}),env);
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  setGrants(['payments.read','sms.read']);
  const canonical=useCanonicalPayments(env,'admin');
  const checks=[];
  env.DB.adminReadBatch=async (_context,authority,statements)=>{
    checks.push(authority.values.filter(value=>['payments.read','sms.read'].includes(value)));
    if(statements[0].sql.includes('SELECT count(*) AS total FROM sms_receipts'))return [{results:[{total:0}]},{results:[]}];
    return statements[0].sql.includes('FROM sms_receipts')
      ? [{results:[{id:null,page_total:0}]}]
      : [{results:[{id:null,page_total:0,page_received:0,page_credited:0,page_unallocated:0}]}];
  };
  const receipts=await handleAdmin(routeRequest('sms/receipts',{cookie}),env);
  assert.equal(receipts.status,200);
  assert.deepEqual((await receipts.json()).rows,[]);
  const payments=await handleAdmin(routeRequest('burimunsi/payments',{cookie}),env);
  assert.equal(payments.status,200);
  const gateway=await handleAdmin(routeRequest('gateway/receipts',{cookie}),env);
  assert.equal(gateway.status,404);
  assert.equal((await payments.json()).items[0].sourceId,canonical.sourceId);
  assert.deepEqual(checks,[['sms.read','sms.read','sms.read']]);
  setGrants(['payments.read']);
  assert.equal((await handleAdmin(routeRequest('sms/receipts',{cookie}),env)).status,403);
  const redacted=await handleAdmin(routeRequest('burimunsi/payments',{cookie}),env);
  assert.equal(redacted.status,200);assert.equal((await redacted.json()).items[0].sourceId,null);
  assert.equal((await handleAdmin(routeRequest('gateway/receipts',{cookie}),env)).status,404);
});


test('browser allocation receipt is a read-only exact current-session result, not a payment status guess',async()=>{
  const {env,setGrants}=await fixture({role:'staff'});
  const login=()=>handleAdmin(request('phone-passcode',{body:{phone:staffPhone,pin}}),env);
  const cookieFor=reply=>reply.headers.get('set-cookie').split(';')[0];
  const cookie=cookieFor(await login());
  setGrants(['payments.read']);
  const paymentId='synthetic-payment',memberId='synthetic-member',requestId=crypto.randomUUID();
  const path='/api/admin/burimunsi/payments/'+paymentId+'/allocation-receipt';
  const lookup=(c=cookie,key=requestId,p=path)=>handleAdmin(new Request(origin+p,
    {headers:{Origin:origin,Cookie:c,...(key===null?{}:{'Idempotency-Key':key})}}),env);
  const original=await adminAccountSession(request('session',{cookie}),env);
  let owner=null,canAllocate=true,lookupCount=0,responseState='allocated',paymentVersion='4';
  const noWrite=()=>assert.fail('Allocation receipt read reached mutation');
  Object.assign(env.DB,{transaction:noWrite,context:noWrite,readContext:noWrite,
    applicationWork:{assert:async()=>{}},
    withLockedReadSnapshot:fn=>fn({unsafe:async(sql,args)=>{
      if(sql.startsWith('SELECT set_config')){assert.deepEqual(args,[group]);return [];}
      if(sql.includes('burimunsi_browser_pin_session'))return [{role:'staff',can_allocate:canAllocate}];
      assert.match(sql,/FROM private\.burimunsi_command_receipts/);
      assert.match(sql,/r\.collection_id=\$1 AND r\.actor_id=\$2::uuid AND r\.request_id=\$3::uuid/);
      assert.match(sql,/AND r\.session_id=\$4::uuid AND r\.operation=\$5 AND r\.response->>'paymentId'=\$6/);
      assert.equal(args[0],group);
      assert.match(args[1],/^[0-9a-f-]{36}$/);
      lookupCount++;
      if(!owner||args[2]!==requestId||args[3]!==owner||args[4]!=='burimunsi.allocate'||args[5]!==paymentId)return [];
      return [{response:{paymentId,memberId,version:4,state:responseState},member_id:memberId,payment_version:paymentVersion}];
    }})});
  const missing=await lookup();
  assert.equal(missing.status,200);
  assert.deepEqual(await missing.json(),{state:'unconfirmed',requestId});
  assert.match(missing.headers.get('cache-control'),/no-store/);
  owner=original.auth_session_id;
  const committed=await lookup();
  assert.deepEqual(await committed.json(),{state:'committed',requestId,receipt:{paymentId,memberId,version:4}});
  const another=cookieFor(await login());setGrants(['payments.read']);
  assert.deepEqual(await (await lookup(another)).json(),{state:'unconfirmed',requestId});
  assert.deepEqual(await (await lookup(cookie,requestId,path.replace(paymentId,'other-payment'))).json(),{state:'unconfirmed',requestId});
  canAllocate=false;
  const reads=lookupCount;
  assert.equal((await lookup()).status,403);
  assert.equal(lookupCount,reads);
  canAllocate=true;
  assert.equal((await lookup(cookie,null)).status,400);
  assert.equal((await lookup(cookie,requestId,path+'?requestId='+requestId)).status,400);
  assert.equal(lookupCount,reads);
  paymentVersion='5';
  assert.equal((await lookup()).status,503);
  paymentVersion='4';responseState='unallocated';
  assert.equal((await lookup()).status,503);
  assert.equal(standaloneAdminRoute('GET',path),true);
  for (const method of ['HEAD','POST','PATCH','DELETE']) assert.equal(standaloneAdminRoute(method,path),false);
  assert.equal(standaloneAdminRoute('GET',path+'/subpath'),false);
});

test('payment analysis uses the original authorized projection, exact full totals and one read snapshot',async()=>{
  const {env,setGrants}=await fixture();
  const login=await handleAdmin(request('phone-passcode',{body:{phone,pin}}),env);
  const input={q:'Financial probe',offset:0,limit:25,filters:[],sort:{key:'amount',direction:'desc'}};
  const {csrfToken}=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  setGrants(['payments.read','sms.read']);
  let sms=false,active=true,tooLarge=false,unsafeAmount=false,scans=0,snapshots=0,inSnapshot=false;
  const raw=[
    {id:'a',amount_rwf:'9007199254740991',direction:'incoming',allocation_state:'allocated'},
    {id:'b',amount_rwf:'9007199254740991',direction:'incoming',allocation_state:'unallocated'},
    {id:'c',amount_rwf:'7',direction:'outgoing',allocation_state:'unallocated'},
  ];
  const noWrite=()=>assert.fail('financial analysis attempted a write');
  Object.assign(env.DB,{transaction:noWrite,context:noWrite,readContext:noWrite,applicationWork:{assert:async()=>{}},
    withLockedReadSnapshot:async fn=>{
      snapshots++;assert.equal(inSnapshot,false);inSnapshot=true;
      try{return await fn({unsafe:async(sql,args)=>{
        assert.equal(inSnapshot,true);
        if(sql==="SET LOCAL statement_timeout='1250ms'")return [];
        if(sql.startsWith('SELECT set_config')){assert.deepEqual(args,[group]);return [];}
        if(sql.includes('burimunsi_browser_pin_session')){
          assert.match(sql,/permissions.*'sms.read'/);
          assert.equal(args[0],group);
          return active?[{role:'admin',can_allocate:true,can_read_sms:sms}]:[];
        }
        assert.match(sql,/CASE WHEN \$3::boolean THEN p.sms_source_id ELSE NULL/);
        assert.match(sql,/LIMIT \(\$4::int\+1\)/);
        assert.deepEqual(args,[group,'%Financial probe%',sms,5000]);scans++;
        if(tooLarge)return [{candidate_count:5001,id:null}];
        return raw.map((row,i)=>({candidate_count:raw.length,collection_id:group,page_at:new Date(1760000000000-i),
          sms_source_id:sms&&i===0?'linked-synthetic-source':null,version:1,...row,
          ...(unsafeAmount&&i===0?{amount_rwf:'9007199254740993'}:{})}));
      }});}finally{inSnapshot=false;}
    }});
  const call=(body=input,csrf=csrfToken)=>handleAdmin(routeRequest('burimunsi/payments/analysis',{body,cookie,csrf}),env);
  const good=await call();
  assert.equal(good.status,200);
  assert.match(good.headers.get('cache-control'),/no-store/);
  const result=await good.json();
  assert.equal(result.totalCount,3);assert.equal(result.matchingCount,3);
  assert.equal(result.items.length,3);assert.ok(result.items.every(row=>row.sourceId===null));
  assert.deepEqual(result.directionTotalsRwf,{incoming:'18014398509481982',outgoing:'7'});
  assert.equal(result.missing,0);assert.equal(snapshots,1);assert.equal(scans,1);
  const filter={key:'sms',text:'',presence:'any',min:'',max:'',choices:['linked']};
  assert.equal((await call({...input,filters:[filter]})).status,400);
  assert.equal(scans,1,'stale browser SMS grant reached candidate lookup');
  sms=true;
  const linked=await (await call({...input,offset:0,filters:[filter]})).json();
  assert.equal(linked.matchingCount,1);assert.equal(linked.items[0].sourceId,'linked-synthetic-source');
  assert.deepEqual(linked.directionTotalsRwf,{incoming:'9007199254740991',outgoing:'0'});
  active=false;
  assert.equal((await call()).status,403);assert.equal(scans,2);
  active=true;
  assert.equal((await call(input,'invalid-csrf')).status,403);assert.equal(scans,2);
  tooLarge=true;
  const refused=await call();assert.equal(refused.status,503);
  assert.match(await refused.text(),/payment_analysis_scope_too_large/);
  tooLarge=false;unsafeAmount=true;
  assert.equal((await call()).status,503);
});

test('exact linked SMS route uses only current payment and SMS read scope and never reveals raw evidence',async()=>{
  const {env,setGrants}=await fixture();
  const login=await handleAdmin(request('phone-passcode',{body:{phone,pin}}),env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const read=path=>handleAdmin(routeRequest(path,{cookie}),env);
  const original='burimunsi/payments/synthetic-payment/sms-evidence';
  setGrants(['payments.read','sms.read']);
  let eligible=true,reads=0,projectedPayment='synthetic-payment',foreignOutcome=false,changedProof=false;
  const sourceId=crypto.randomUUID(),requestId=crypto.randomUUID(),fingerprint='a'.repeat(64),objectSha256='b'.repeat(64),bodySha256='c'.repeat(64);
  const keyId='synthetic-key',objectKey='sms/'+sourceId,ownerUserId='synthetic-principal';
  const descriptor={scope:{ownerId:ownerUserId,purpose:'sms_receipt',entityId:sourceId},
   aad:`sms:${sourceId}:${objectSha256}`,keyId,plaintextSha256:objectSha256,
   requestDigest:fingerprint,httpMetadata:{contentType:'application/octet-stream'},
   customMetadata:{sha256:objectSha256,key_id:keyId}};
  const {canonicalJson}=await import('../domain/burimunsi/values.js');
  const sourceFingerprint=await digest(canonicalJson(descriptor));
  const noWrite=()=>assert.fail('metadata path attempted mutation');
  Object.assign(env.DB,{transaction:noWrite,context:noWrite,readContext:noWrite,applicationWork:{assert:async()=>{}},
    withLockedReadSnapshot:fn=>fn({unsafe:async(sql,args)=>{
      if(sql.startsWith('SET LOCAL statement_timeout'))return [];
      if(sql.startsWith('SELECT set_config')){assert.deepEqual(args,[group]);return [];}
      if(sql.includes('burimunsi_browser_pin_session')){
        assert.match(sql,/permissions.*'sms.read'/);
        return [{role:'admin',can_allocate:true,can_read_sms:eligible}];
      }
      reads++;
      assert.match(sql,/p.collection_id=\$1 AND p.id=\$2/);
      assert.match(sql,/private\.burimunsi_payment_sms_evidence_rows\(\$1,\$2,linked\.sms_source_id\)/);
      assert.doesNotMatch(sql,/FROM\s+private\.burimunsi_observation_admin_page|inlineEnvelope/);
      assert.equal(args[0],group);assert.equal(args.length,2);
      if(args[1]!==projectedPayment)return [];
      return [{request_id:requestId,source_id:sourceId,admitted_at:1760000000000,retention_state:'retained',
        body_sha256:bodySha256,owner_user_id:ownerUserId,object_key:objectKey,object_sha256:objectSha256,
        fingerprint,key_id:keyId,source_fingerprint:changedProof?'d'.repeat(64):sourceFingerprint,
        outcomes:[{sourceId:foreignOutcome?crypto.randomUUID():sourceId,processing:'parsed',paymentReference:null,payerStatus:null,payerReason:null}]}];
    }})});
  const off=await read(original);assert.equal(off.status,404);assert.equal(reads,0);
  env.BURIMUNSI_ADMIN_SMS_OBSERVATIONS_ENABLED='true';
  eligible=false;
  assert.equal((await read(original)).status,403);assert.equal(reads,0);
  eligible=true;
  assert.equal((await read(original+'?sourceId='+sourceId)).status,400);assert.equal(reads,0);
  const response=await read(original);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await response.json(),{paymentId:projectedPayment,groupId:group,evidence:{requestId,sourceId,
    admittedAt:new Date(1760000000000).toISOString(),retentionState:'retained',bodySha256,processing:'parsed',
    paymentReference:null,payerStatus:null,payerReason:null}});
  changedProof=true;
  const unresolved=await (await read(original)).json();
  assert.equal(unresolved.evidence.retentionState,'unresolved');assert.equal(unresolved.evidence.bodySha256,null);
  foreignOutcome=true;
  assert.equal((await read(original)).status,503);
  projectedPayment='different-only';
  assert.deepEqual(await (await read(original)).json(),{paymentId:'synthetic-payment',groupId:group,evidence:null});
});

test('BuriMunsi Worker and Admin handler recover the original allocation after the Worker rejects its acknowledgement',async()=>{
  const {env,setGrants}=await fixture({role:'staff'});
  const paymentId='synthetic-payment',memberId='synthetic-member',requestId=crypto.randomUUID();
  const path='/api/admin/burimunsi/payments/'+paymentId;
  let retained=null,posted=0,reads=0,writes=0,upstreamPosts=0;
  const scoped=(sql,args)=>{
    if(sql.startsWith('SELECT set_config')){assert.deepEqual(args,[group]);return [];}
    if(sql.includes('burimunsi_browser_pin_session')){
      assert.equal(args[0],group);assert.equal(args[2],origin);return [{role:'staff',can_allocate:true}];
    }
    assert.fail('Unexpected fixture SQL');
  };
  Object.assign(env.DB,{context:async()=>{},readContext:async()=>{},applicationWork:{assert:async()=>{}},
    transaction:async run=>{
      writes++;
      let pending=null;
      const reply=await run({unsafe:async(sql,args)=>{
        if(sql.includes('pg_advisory_xact_lock'))return [];
        if(sql.includes('FROM private.burimunsi_command_receipts'))return [];
        if(sql.includes('FROM app.memberships')){assert.deepEqual(args,[group,memberId]);return [{user_id:memberId}];}
        if(sql.startsWith('UPDATE burimunsi.payments')){
          assert.deepEqual(args,[group,paymentId,memberId,3]);
          return [{id:paymentId,member_id:memberId,allocation_state:'allocated',version:'4'}];
        }
        if(sql.includes('INSERT INTO private.burimunsi_command_receipts')){
          assert.deepEqual([args[0],args[2],args[4]],[group,requestId,'burimunsi.allocate']);
          pending={actor:args[1],session:args[3],response:args[6]};return [];
        }
        return scoped(sql,args);
      }});
      assert.deepEqual(pending?.response,reply);
      retained=pending;posted++;
      return reply;
    },
    withLockedReadSnapshot:run=>run({unsafe:async(sql,args)=>{
      if(!sql.includes('FROM private.burimunsi_command_receipts'))return scoped(sql,args);
      reads++;
      const row=retained;
      if(!row||args[1]!==row.actor||args[2]!==requestId||args[3]!==row.session||args[5]!==paymentId)return [];
      return [{response:row.response,member_id:memberId,payment_version:'4'}];
    }})});

  // Translate the gateway prefix only. The real Worker admits and qualifies
  // responses; the real Admin route does sign-in, CSRF, allocation and readback.
  // SQL is a fixture here; the native PostgreSQL suite tests persistence.
  const handle=createCollectTransport({frontendOrigin:origin,allowedFrontendOrigins:[origin],burimunsi:true,maxResponseBytes:4096,
    fetchImpl:async req=>{
      const url=new URL(req.url),prefix='/functions/v1/admin-api';
      assert.ok(url.pathname.startsWith(prefix+'/api/admin/'));
      const route=url.pathname.slice(prefix.length),allocation=req.method==='POST'&&route===path+'/allocate';
      if(route.startsWith(path)){
        assert.equal(req.headers.get('Origin'),origin);
        assert.match(req.headers.get('Cookie'),/^__Host-collect_admin=[a-f0-9]{64}$/);
        assert.equal(req.headers.has('Authorization'),false);
      }
      if(allocation){upstreamPosts++;assert.equal(req.headers.get('Idempotency-Key'),requestId);}
      const reply=await handleAdmin(new Request(origin+route+url.search,req),env);
      if(allocation&&reply.status===200){
        assert.deepEqual(await reply.json(),{paymentId,memberId,state:'allocated',version:4});
        assert.equal(posted,1);
        return new Response(JSON.stringify({discarded:'x'.repeat(4096)}),{headers:{'Content-Type':'application/json'}});
      }
      return reply;
    }});
  const login=async()=>{
    const reply=await handle(request('phone-passcode',{body:{phone:staffPhone,pin}}));
    assert.equal(reply.status,200);
    const cookie=reply.headers.get('Set-Cookie').split(';')[0];
    assert.ok(cookie.startsWith(BURIMUNSI_ADMIN_COOKIE+'='));
    return {cookie,csrf:(await reply.json()).csrfToken};
  };
  const original=await login();
  setGrants(['payments.read']);
  const lookup=(session=original,key=requestId,where=path)=>handle(new Request(origin+where+'/allocation-receipt',
    {headers:{Cookie:session.cookie,'Sec-Fetch-Site':'same-origin','Idempotency-Key':key}}));
  assert.deepEqual(await (await lookup()).json(),{state:'unconfirmed',requestId});

  const allocate=routeRequest('burimunsi/payments/'+paymentId+'/allocate',
    {...original,body:{memberId,expectedVersion:3}});
  allocate.headers.set('Idempotency-Key',requestId);
  const uncertain=await handle(allocate);
  assert.equal(uncertain.status,502);
  assert.equal((await uncertain.json()).code,'proxy_outcome_unknown');
  assert.deepEqual([upstreamPosts,writes,posted],[1,1,1]);

  const reply=await lookup();
  assert.equal(reply.status,200);
  assert.match(reply.headers.get('Cache-Control'),/no-store/);
  assert.match(reply.headers.get('CDN-Cache-Control'),/no-store/);
  assert.deepEqual(await reply.json(),{state:'committed',requestId,receipt:{paymentId,memberId,version:4}});
  const fresh=await login();
  setGrants(['payments.read']);
  assert.deepEqual(await (await lookup(fresh)).json(),{state:'unconfirmed',requestId});
  const other=crypto.randomUUID();
  assert.deepEqual(await (await lookup(original,other)).json(),{state:'unconfirmed',requestId:other});
  assert.deepEqual([upstreamPosts,writes,posted,reads],[1,1,1,4]);
});
