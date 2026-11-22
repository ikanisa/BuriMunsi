// Real native request gate, PIN derivation and transaction adapters. The narrow
// SQL API is an explicit double here; actual PostgreSQL guards have separate SQL
// qualification fixtures. These checks open no provider or network connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhonePinRequestGate,hasPhonePinContext,applyPhonePinContext,claimPhonePinReadSnapshot,phonePinReadSelector,PIN_CONTEXT_SQL,PIN_SET_CONTEXT_SQL,PIN_RENEW_SQL,PIN_LOGOUT_SQL,RETIREMENT_OUTCOME_SQL} from '../../domain/burimunsi/phone-pin-request.js';
import {PostgresNativeAuthority} from '../../domain/burimunsi/postgres-authority.js';
import {PostgresPhonePinSessions} from '../../domain/burimunsi/postgres-phone-pin-sessions.js';
import {PostgresNativeAuthStore} from '../../domain/burimunsi/postgres-auth-store.js';
import {PostgresOperatorDirectory} from '../../domain/burimunsi/postgres-operator-directory.js';
import {PinHasher} from '../../domain/burimunsi/pin.js';
import {sha256} from '../../domain/burimunsi/values.js';
import {CONTRACT_VERSION} from '../../domain/burimunsi/wire/native-contract.mjs';
import {createNativeHandler} from '../../domain/burimunsi/http.js';
import {PostgresRecordsStore} from '../../domain/burimunsi/postgres-records-store.js';
import {RecordsService} from '../../domain/burimunsi/records-service.js';
import {ScopedCursor} from '../../domain/burimunsi/cursor.js';
import {NativeAuthService} from '../../domain/burimunsi/auth-service.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const installation=id(1),device='d'.repeat(64),network='e'.repeat(64),now=Date.now();
const origin='https://supabase.example.test';
const secrets={pinPepper:new Uint8Array(32).fill(71),pinPepperId:'qualification-only'};
const hasher=new PinHasher({pepper:secrets.pinPepper,pepperId:secrets.pinPepperId});
const credential=await hasher.hash('+250780000001','2468');
function fixture(){
 const state={allowed:true,account:{id:id(2),groupId:'actual-group',principalUserId:'actual-collect-principal',phone:'+250780000001',
  name:'Synthetic native operator',role:'admin',capabilities:['records.read','gateway.manage','sms.read','staff.manage'],active:true,removed:false,
  pinHash:credential,credentialVersion:1,version:1},sessions:new Map(),calls:[],transactions:0,workChecks:0,
  networkChecks:0,createAllowed:true,revoked:false,claims:null,time:now,creationShift:0,commits:0,rollbacks:0};
 const row=(token,install,secret,profile)=>{
  const s=state.sessions.get(token);if(!s||state.revoked||install!==installation||secret!==device||profile!=='internal_receiver'||
   s.created-(state.databaseTime??state.time)>5000)return [];
  return [{collection_id:s.groupId,account_id:s.accountId,principal_user_id:s.principal,native_session_id:s.id,grant_id:id(3),
   installation_id:installation,profile,role:state.account.role,capabilities:state.account.capabilities,created_at:s.created,expires_at:s.expires,
   credential_version:1,grant_version:1,shared_role:state.account.role==='admin'?'owner':'staff'}];
 };
 const sql={unsafe:async(text,args=[])=>{
  state.calls.push({text,args:[...args]});
  if(text.includes('burimunsi_pin_login_account'))return [{result:{allowed:state.allowed,account:state.allowed?state.account:null}}];
  if(text.includes('burimunsi_pin_create_session')){
   if(!state.createAllowed)return [{result:{created:false}}];
   const created=args[8]+state.creationShift,expires=args[9]+state.creationShift;
   state.sessions.set(args[7],{groupId:args[0],accountId:args[1],principal:state.account.principalUserId,id:args[6],created,expires});
   return [{result:{created:true,expiresAt:expires,grantId:id(3),grantVersion:1}}];
  }
  if(text===PIN_CONTEXT_SQL){const hash=await sha256(args[0]);return row(hash,args[1],args[2],args[3]);}
  if(text===PIN_RENEW_SQL){
   const hash=await sha256(args[0]),rows=row(hash,args[1],args[2],args[3]);
   if(rows.length!==1||args[4]!==rows[0].collection_id||state.changedAuthority)return [];
   const s=state.sessions.get(hash);s.expires=Math.max(s.expires,state.time+args[5]);
   const current=row(hash,args[1],args[2],args[3]);state.current=current[0];return current;
  }
  if(text===PIN_LOGOUT_SQL){
   const s=state.sessions.get(await sha256(args[0]));
   if(!s||args[1]!==installation||args[2]!==device||args[3]!=='internal_receiver'||args[4]!==s.groupId)return [{result:null}];
   state.revoked=true;return [{result:{accountId:s.accountId,collectionId:s.groupId}}];
  }
  if(text===PIN_SET_CONTEXT_SQL){const rows=row(await sha256(args[0]),args[1],args[2],args[3]);state.current=rows[0];return rows.map(r=>({result:r}));}
  if(state.readActor&&text.startsWith('SELECT s.id AS session_id'))return state.readActor(text,args);
  if(text.includes('FROM private.burimunsi_pin_context()'))return state.current?[{...state.current,now_ms:now}]:[];
  if(text.startsWith('SET TRANSACTION')||text.includes('pg_advisory_xact_lock'))return [];
  if(state.readQuery)return state.readQuery(text,args);
  return [];
 }};
 const work={assert:async()=>{state.workChecks++;}};
 const db={applicationWork:work,setClaims:c=>{state.claims=c;},context:async()=>{},readContext:async()=>{},
  async transaction(fn){state.transactions++;try{const result=await fn(sql);state.commits++;return result;}
   catch(error){state.rollbacks++;throw error;}}};
 const gate=createPhonePinRequestGate({origin,secrets,networkBucket:async()=>{state.networkChecks++;return network;},clock:()=>state.time});
 const request=({login=true,body={phone:'+250780000001',pin:'2468'},postBody={},token,group='actual-group',headers={},
  path='/home',method='GET',urlOrigin=origin,query='',rawBody}={})=>new Request(
  urlOrigin+'/v1/burimunsi'+(login?'/session/login':path)+query,{method:login?'POST':method,headers:{
   'X-BuriMunsi-Auth':'phone_pin','X-BuriMunsi-Profile':'internal_receiver','X-BuriMunsi-Installation':installation,
   'X-BuriMunsi-Device':device,'X-BuriMunsi-Contract':CONTRACT_VERSION,'X-BuriMunsi-Request':id(4),'X-BuriMunsi-Generation':'7',
   ...(login?{'Content-Type':'application/json'}:{Authorization:'Bearer '+token,'X-BuriMunsi-Group':group,...(method==='POST'?{'Content-Type':'application/json'}:{})}),...headers},
   ...(login||method==='POST'?{body:rawBody??JSON.stringify(login?body:postBody)}:{})});
 const invoke=(req,fn=()=>{throw Error('Login must not enter ordinary route composition');},env={})=>gate({request:req,env:{DB:db,...env}},fn);
 const login=async options=>{const response=await invoke(request(options));return (await response.json()).data;};
 return {state,db,sql,request,invoke,login};
}
function freshRead(f,{scope='actual-group',enabled=true,actorScope=scope,pinCurrent=true,operatorCurrent=true,combined=true}={}){
 const actorReloads=[],noop=async()=>null;
 const inputs={db:f.db,groupId:scope};
 const sessionBinding=new PostgresPhonePinSessions(inputs);
 const operatorDirectory=new PostgresOperatorDirectory({...inputs,managedSessions:sessionBinding});
 const authority=new PostgresNativeAuthStore({...inputs,createOperatorPrincipal:noop,
  sessionBinding,operatorDirectory,clock:()=>f.state.time});
 if(combined)authority.read=()=>assert.fail('unnecessary second business transaction');
 f.state.readActor=(text,args)=>{
  assert.match(text,/JOIN LATERAL private\.burimunsi_pin_context\(\)/);
  assert.equal(text.includes('private.burimunsi_operator_is_current(a.collection_id'),combined);
  assert.doesNotMatch(text,/\ba\.\*/);
  const row=f.state.current;
  assert.equal(args[0],scope);assert.equal(args[4],f.state.time);
  if(args[2]===null)assert.deepEqual(args.slice(1,4),[row.native_session_id,null,null]);
  else {
   assert.equal(combined,false);assert.equal(args[1],null);assert.equal(args[3],row.installation_id);
  }
  actorReloads.push(row.native_session_id);
  return enabled?[{id:row.account_id,collection_id:actorScope,session_id:row.native_session_id,
   principal_user_id:row.principal_user_id,installation_id:row.installation_id,installation_profile:row.profile,
   phone:f.state.account.phone,name:f.state.account.name,role:row.role,capabilities:row.capabilities,
   expires_at:row.expires_at,pin_current:pinCurrent,operator_current:operatorCurrent}]:[];
 };
 const store=new PostgresRecordsStore({authority,sourceReader:{revision:noop,page:noop,detail:noop},clock:()=>f.state.time});
 const records=new RecordsService({store,groupId:scope,cursor:new ScopedCursor(new Uint8Array(32).fill(8)),clock:()=>f.state.time});
 const auth=new NativeAuthService({store:authority,hasher,groupId:scope,clock:()=>f.state.time});
 if(combined)auth.authenticate=()=>assert.fail('unnecessary bearer transaction');
 const handler=createNativeHandler({auth,records,contributions:{allocate:noop},
  members:{enroll:noop,setActive:noop},gateway:{status:noop,replace:noop},origin,groupId:scope,strictContract:true,
  networkBucket:noop,readRecordActor:request=>phonePinReadSelector(f.db,request)});
 return {handler,actorReloads};
}

test('fresh standalone session and Home renew and reload the actor in one fenced snapshot',async()=>{
 const f=fixture(),login=await f.login(),before=f.state.transactions,{handler,actorReloads}=freshRead(f);
 f.state.time=login.expiresAt+1;f.state.calls=[];
 f.state.readQuery=(text,args)=>{
  assert.match(text,/WITH credited AS MATERIALIZED/);assert.equal(args[0],'actual-group');
  assert.equal(actorReloads.length,1);
  return [{balance:1000,today:1000,members:1,unallocated:0,unallocated_amount:0,id:null}];
 };
 const req=f.request({login:false,token:login.token,path:'/session',query:'?include=home'});
 const res=await f.invoke(req,()=>handler(req),{BURIMUNSI_PRODUCT_MODE:'standalone'});
 assert.equal(res.status,200,await res.clone().text());
 const payload=await res.json();
 assert.equal(payload.data.home.groupBalanceRwf,1000);assert.equal(payload.binding.actorId,id(2));
 assert.ok(payload.data.expiresAt>f.state.time);assert.deepEqual(actorReloads,[[...f.state.sessions.values()][0].id]);
 assert.equal(f.state.transactions-before,1);
 assert.equal(f.state.calls[0].text,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE');
 assert.ok(f.state.calls.find(({text})=>text.includes('pg_advisory_xact_lock')));
 assert.equal(f.state.calls.filter(({text})=>text===PIN_RENEW_SQL).length,1);
 assert.equal(f.state.calls.some(({text})=>text===PIN_SET_CONTEXT_SQL),false);
 assert.equal(hasPhonePinContext(f.db),false);
});

test('fresh standalone payments keep a read-only snapshot, exact request and scoped pagination',async()=>{
 const f=fixture(),login=await f.login(),before=f.state.transactions,{handler,actorReloads}=freshRead(f);
 f.state.calls=[];
 f.state.readQuery=(text,args)=>{
  assert.match(text,/FROM private\.burimunsi_transaction_scopes/);assert.deepEqual(args,['actual-group']);
  assert.equal(actorReloads.length,1);
  return Array.from({length:101},(_,i)=>({id:'payment-'+String(i).padStart(3,'0'),collection_id:'actual-group',
   transaction_at:'2026-11-22T10:00:00Z',event_kind:'incoming_receipt',provider_transaction_id:'123456789',
   amount_minor:1000,version:1,has_conflict:0,source_conflict:false,allocation_state:'unallocated',payment_status:null,ledger_posted:false,
   payer_name:'Synthetic member',payer_identifier:'*********111',transaction_datetime_raw:'2026-11-22 10:00:00'}));
 };
 const req=f.request({login:false,token:login.token,path:'/payments',query:'?filter=all&sort=newest&limit=100'});
 const res=await f.invoke(req,()=>{
  assert.throws(()=>phonePinReadSelector(f.db,req.clone()),{code:'request_not_admitted'});
  return handler(req);
 },{BURIMUNSI_PRODUCT_MODE:'standalone'});
 assert.equal(res.status,200,await res.clone().text());
 const {data,binding}=await res.json();
 assert.equal(binding.actorId,id(2));assert.equal(data.items.length,100);assert.equal(data.totalCount,101);
 assert.equal(data.items[0].id,'payment-000');assert.ok(data.nextCursor);
 assert.equal(f.state.transactions-before,1);
 assert.equal(f.state.calls[0].text,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
 assert.equal(f.state.calls.filter(({text})=>text===PIN_SET_CONTEXT_SQL).length,1);
 assert.equal(f.state.calls.some(({text})=>text===PIN_CONTEXT_SQL||text===PIN_RENEW_SQL||text.includes('pg_advisory_xact_lock')),false);
 assert.equal(hasPhonePinContext(f.db),false);
});

test('fresh reads retain the prior wire payload and Payments cursors with fewer database calls',async t=>{
 for(const [path,query] of [['/session','?include=home'],['/payments','?filter=all&sort=newest&limit=100']]){
  const f=fixture(),login=await f.login();
  f.state.readQuery=(sql,args)=>{
   if(sql.startsWith('SELECT private.burimunsi_operator_is_current'))return [{allowed:true}];
   if(sql.startsWith('WITH credited AS MATERIALIZED'))return [{balance:1000,today:1000,members:1,unallocated:0,unallocated_amount:0,id:null}];
   assert.match(sql,/FROM private\.burimunsi_transaction_scopes/);assert.deepEqual(args,['actual-group']);
   return Array.from({length:101},(_,i)=>({id:'payment-'+String(i).padStart(3,'0'),collection_id:'actual-group',
    transaction_at:'2026-11-22T10:00:00Z',event_kind:'incoming_receipt',provider_transaction_id:'123456789',
    amount_minor:1000,version:1,has_conflict:0,source_conflict:false,allocation_state:'unallocated',payment_status:null,ledger_posted:false,
    payer_name:'Synthetic member',payer_identifier:'*********111',transaction_datetime_raw:'2026-11-22 10:00:00'}));
  };
  const run=async(combined,search)=>{
   const before=f.state.transactions,{handler}=freshRead(f,{combined});f.state.calls=[];f.state.workChecks=0;
   const req=f.request({login:false,token:login.token,path,query:search});
   const response=await f.invoke(req,()=>handler(req),combined?{BURIMUNSI_PRODUCT_MODE:'standalone'}:{});
   assert.equal(response.status,200,await response.clone().text());
   return {body:await response.json(),transactions:f.state.transactions-before,sql:f.state.calls.length,assertions:f.state.workChecks};
  };
  const baseline=await run(false,query),candidate=await run(true,query);
  assert.deepEqual(candidate.body,baseline.body);
  assert.deepEqual([baseline.transactions,candidate.transactions],[3,1]);
  assert.ok(candidate.sql<baseline.sql);
  assert.ok(candidate.assertions<baseline.assertions);
  t.diagnostic(`${path} transactions ${baseline.transactions} -> ${candidate.transactions}, SQL excluding BEGIN/COMMIT and context setup ${baseline.sql} -> ${candidate.sql}, domain assertions ${baseline.assertions} -> ${candidate.assertions}`);
  if(path==='/payments'){
   const continuation=query+'&cursor='+encodeURIComponent(baseline.body.data.nextCursor);
   const previousTail=await run(false,continuation),newTail=await run(true,continuation);
   assert.deepEqual(newTail.body,previousTail.body);
   assert.equal(newTail.body.data.items[0].id,'payment-100');
  }
 }
});

test('revocation, expired proof, lost permission and foreign scope abort the fresh read before protected records',async()=>{
 for(const [input,status] of [[{enabled:false},401],[{pinCurrent:false},401],
  [{operatorCurrent:false},403],[{actorScope:'other-group'},403]]){
  const f=fixture(),login=await f.login(),{handler}=freshRead(f,input),before=f.state.commits;
  f.state.readQuery=()=>assert.fail('actor not admitted to protected projection');
  const req=f.request({login:false,token:login.token,path:'/session',query:'?include=home'});
  const res=await f.invoke(req,()=>handler(req),{BURIMUNSI_PRODUCT_MODE:'standalone'});
  assert.equal(res.status,status);
  assert.equal(f.state.commits,before);assert.equal(f.state.rollbacks,1);
  assert.equal(claimPhonePinReadSnapshot(f.db,'actual-group'),null);
 }
});
test('fresh install authenticates original phone/PIN and binds only server-selected scope',async()=>{
 const f=fixture(),data=await f.login();assert.equal(data.groupId,'actual-group');assert.match(data.token,/^[a-f0-9]{64}$/);
 assert.equal(data.profile.id,id(2));assert.equal(f.state.calls.filter(x=>x.text.includes('login_account')).length,1);
 const accountIndex=f.state.calls.findIndex(x=>x.text.includes('login_account')),createIndex=f.state.calls.findIndex(x=>x.text.includes('create_session'));
 assert.ok(accountIndex<createIndex);assert.equal(f.state.calls[accountIndex].args[1],await sha256('+250780000001'));
 assert.equal(f.state.calls[createIndex].args[4],await sha256(device));assert.notEqual(f.state.calls[createIndex].args[7],data.token);
 assert.equal(f.state.calls[createIndex].args[10],f.state.account.version);
 assert.equal(hasPhonePinContext(f.db),false);assert.deepEqual(f.state.claims,{});
});
test('configured same origin admits login for either native installation profile',async()=>{
 for(const profile of ['staff','internal_receiver']){
  const f=fixture();
  const data=await f.login({headers:{Origin:origin,'X-BuriMunsi-Profile':profile}});
  assert.equal(data.groupId,'actual-group');
  assert.equal(f.state.calls.find(({text})=>text.includes('create_session')).args[3],profile);
  assert.equal(f.state.networkChecks,1);
 }
});
test('PIN transitions reject unrelated origins and query data before opening auth work',async t=>{
 const transitions=[
  ['login',{}],
  ['logout',{login:false,method:'POST',path:'/session/logout'}],
  ['retirement outcome',{login:false,path:'/gateway/replacements/'+id(31)+'/outcome'}],
  ['session renewal',{login:false,path:'/session'}],
  ['passcode renewal',{login:false,method:'POST',path:'/session/passcode'}],
 ];
 const invalid=[
  ['browser origin',{headers:{Origin:'https://unrelated.example.test'}},'origin_denied',403],
  ['request URL',{urlOrigin:'https://unrelated.example.test'},'origin_denied',403],
  ['query',{query:'?extra=1'},'invalid_query',400],
 ];
 for(const [transition,route] of transitions)for(const [label,override,code,status] of invalid){
  await t.test(transition+' '+label,async()=>{
   const f=fixture(),request=f.request({token:'a'.repeat(64),...route,...override});
   await assert.rejects(f.invoke(request),error=>error.code===code&&error.status===status);
   assert.equal(request.bodyUsed,false);
   assert.equal(f.state.workChecks,0);
   assert.equal(f.state.transactions,0);
   assert.equal(f.state.networkChecks,0);
   assert.equal(f.state.sessions.size,0);
  });
 }
});
test('PIN JSON keeps strict grammar and the native body bound before login budget',async()=>{
 for(const [rawBody,code] of [['{','CONTRACT_JSON'],['x'.repeat(8193),'CONTRACT_REQUEST_SIZE']]){
  const f=fixture();
  await assert.rejects(f.login({rawBody}),error=>error.code===code);
  assert.equal(f.state.networkChecks,0);
  assert.equal(f.state.transactions,0);
 }
});
test('login returns the shorter persisted expiry and rejects an expanded expiry',async()=>{
 const f=fixture();f.state.creationShift=-4000;
 const data=await f.login();
 const stored=[...f.state.sessions.values()][0];
 assert.equal(data.expiresAt,stored.expires);assert.equal(data.expiresAt,f.state.time+1800000-4000);
 await f.invoke(f.request({login:false,token:data.token}),principal=>{assert.equal(principal.principalSessionId,stored.id);});
 const extended=fixture();extended.state.creationShift=1;
 await assert.rejects(extended.login(),e=>e.code==='session_unavailable'&&e.status===401);
});
test('denied durable budget commits before any registration or hashing-dependent session work',async()=>{
 const f=fixture();f.state.allowed=false;
 await assert.rejects(f.login(),e=>e.code==='try_again_later'&&e.status===429);
 assert.equal(f.state.calls.filter(x=>x.text.includes('login_account')).length,1);
 assert.equal(f.state.calls.some(x=>x.text.includes('create_session')),false);
});
test('wrong PIN, absent account, and credential CAS race create no installation/session authority',async()=>{
 for(const mode of ['wrong-pin','unknown','changed']){
  const f=fixture();if(mode==='unknown')f.state.account=null;if(mode==='changed')f.state.createAllowed=false;
  await assert.rejects(f.login(mode==='wrong-pin'?{body:{phone:'+250780000001',pin:'1357'}}:undefined),e=>e.code==='invalid_credentials');
  assert.equal(f.state.sessions.size,0);assert.equal(hasPhonePinContext(f.db),false);
 }
});
test('login cannot accept caller-selected collection, capabilities or managed proof',async()=>{
 for(const options of [{headers:{'X-BuriMunsi-Group':'attacker-group'}},{body:{phone:'+250780000001',pin:'2468',role:'admin'}},
  {headers:{'X-BuriMunsi-Collect-Session':'copied.jwt.value'}}]){
  const f=fixture();await assert.rejects(f.login(options));assert.equal(f.state.calls.length,0);
 }
});
test('ordinary requests pass raw opaque proof to DB, revalidate every transaction and clean request scope',async()=>{
 const f=fixture(),data=await f.login();f.state.calls=[];
 await f.invoke(f.request({login:false,token:data.token}),async principal=>{
  assert.equal(principal.authMethod,'phone_pin');assert.equal(principal.groupId,'actual-group');assert.equal(hasPhonePinContext(f.db),true);
  const authority=new PostgresNativeAuthority({db:f.db,groupId:principal.groupId});
  await authority.read(async sql=>{
   const binding=new PostgresPhonePinSessions({db:f.db,groupId:principal.groupId});
   assert.equal((await binding.current(sql,principal.principalUserId)).principalSessionId,principal.principalSessionId);
  });
 });
 const set=f.state.calls.find(x=>x.text===PIN_SET_CONTEXT_SQL);assert.deepEqual(set.args,[data.token,installation,device,'internal_receiver']);
 assert.equal(hasPhonePinContext(f.db),false);assert.deepEqual(f.state.claims,{});
});
test('database-proven native session accepts only the admitted clock skew without relaxing expiry or authority',async()=>{
 for(const skew of [100,5000,5001])for(const path of ['/home','/session','/session/passcode']){
  const f=fixture(),data=await f.login(),stored=[...f.state.sessions.values()][0];
  f.state.databaseTime=stored.created;f.state.time=stored.created-skew;
  let entered=false;const method=path.endsWith('/passcode')?'POST':'GET';
  const result=f.invoke(f.request({login:false,token:data.token,path,method}),()=>{entered=true;});
  if(skew<=5000){await result;assert.equal(entered,true,`${path} skew ${skew}`);}
  else {await assert.rejects(result,e=>e.code==='session_unavailable'&&e.status===401);assert.equal(entered,false);}
 }
 const invalid=fixture(),data=await invalid.login(),stored=[...invalid.state.sessions.values()][0];
 invalid.state.time=stored.created-100;invalid.state.databaseTime=stored.created-5001;
 await assert.rejects(invalid.invoke(invalid.request({login:false,token:data.token})),e=>e.status===401);
 invalid.state.databaseTime=stored.created;invalid.state.revoked=true;
 await assert.rejects(invalid.invoke(invalid.request({login:false,token:data.token})),e=>e.status===401);
 invalid.state.revoked=false;invalid.state.time=stored.expires;
 await assert.rejects(invalid.invoke(invalid.request({login:false,token:data.token})),e=>e.status===401);
});
test('expired device-bound session renews through its exact session revalidation route',async()=>{
 const f=fixture(),data=await f.login();f.state.time=data.expiresAt+60000;f.state.calls=[];
 await assert.rejects(f.invoke(f.request({login:false,token:data.token}),()=>assert.fail('Expired ordinary route')),e=>e.status===401);
 let observed;await f.invoke(f.request({login:false,token:data.token,path:'/session'}),async actor=>{observed=actor;});
 assert.equal(observed.principalSessionId,[...f.state.sessions.values()][0].id);
 assert.ok([...f.state.sessions.values()][0].expires>f.state.time);
 const renewal=f.state.calls.find(x=>x.text===PIN_RENEW_SQL);
 assert.deepEqual(renewal.args,[data.token,installation,device,'internal_receiver','actual-group',1800000]);
 assert.ok(f.state.calls.some(x=>x.text.includes('pg_advisory_xact_lock')));
 await f.invoke(f.request({login:false,token:data.token,path:'/session',query:'?include=home'}),async actor=>{
  assert.equal(actor.principalSessionId,observed.principalSessionId);
 });
 await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session',query:'?include=home&include=home'})),
  error=>error.code==='invalid_query'&&error.status===400);
 assert.equal(hasPhonePinContext(f.db),false);
});
test('expired device-bound session can be durably revoked and cannot be renewed',async()=>{
 const f=fixture(),data=await f.login();f.state.time=data.expiresAt+60000;f.state.calls=[];
 const response=await f.invoke(f.request({login:false,token:data.token,path:'/session/logout',method:'POST',postBody:{replacementToken:'f'.repeat(64)}}));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).data,{signedOut:true});
 assert.deepEqual(f.state.calls.find(x=>x.text===PIN_LOGOUT_SQL).args,[data.token,installation,device,'internal_receiver','actual-group','f'.repeat(64)]);
 await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session'})),e=>e.status===401);
 const retry=await f.invoke(f.request({login:false,token:data.token,path:'/session/logout',method:'POST'}));assert.equal(retry.status,200);
});
test('expired session revalidates its exact device proof before a passcode change',async()=>{
 const f=fixture(),data=await f.login();f.state.time=data.expiresAt+60000;f.state.calls=[];
 let actor;await f.invoke(f.request({login:false,token:data.token,path:'/session/passcode',method:'POST'}),value=>{actor=value});
 assert.equal(actor.principalSessionId,[...f.state.sessions.values()][0].id);
 assert.deepEqual(f.state.calls.find(x=>x.text===PIN_RENEW_SQL).args,[data.token,installation,device,'internal_receiver','actual-group',1800000]);
 const revoked=fixture(),old=await revoked.login();revoked.state.time=old.expiresAt+1;revoked.state.revoked=true;
 await assert.rejects(revoked.invoke(revoked.request({login:false,token:old.token,path:'/session/passcode',method:'POST'}),()=>assert.fail('Must not change PIN')),e=>e.status===401);
});
test('logout rejects wrong proof and invalid request correlation before the durable barrier',async()=>{
 for(const mode of ['device','group','correlation','query']){
  const f=fixture(),data=await f.login();f.state.time=data.expiresAt+1;f.state.calls=[];
  const headers=mode==='device'?{'X-BuriMunsi-Device':'c'.repeat(64)}:mode==='correlation'?{'X-BuriMunsi-Request':'bad'}:{};
  await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session/logout'+(mode==='query'?'?extra=1':''),method:'POST',
   group:mode==='group'?'other-group':'actual-group',headers}),()=>assert.fail('Must not authorize logout')));
  assert.equal([...f.state.sessions.values()][0].expires,data.expiresAt);
  assert.equal(f.state.revoked,false);
 }
});
test('temporary authority suspension does not prevent exact-device logout',async()=>{
 const f=fixture(),data=await f.login();f.state.changedAuthority=true;
 const response=await f.invoke(f.request({login:false,token:data.token,path:'/session/logout',method:'POST'}));
 assert.equal(response.status,200);assert.equal(f.state.revoked,true);
});
test('unknown logout commit can retry the exact barrier without restoring authority',async()=>{
 const f=fixture(),data=await f.login(),transaction=f.db.transaction;let first=true;
 f.db.transaction=async fn=>{const result=await transaction(fn);if(first){first=false;throw Error('Synthetic lost commit response');}return result;};
 const request=()=>f.request({login:false,token:data.token,path:'/session/logout',method:'POST',postBody:{replacementToken:'f'.repeat(64)}});
 await assert.rejects(f.invoke(request()),/lost commit/);assert.equal(f.state.revoked,true);
 const retry=await f.invoke(request());assert.equal(retry.status,200);assert.deepEqual((await retry.json()).data,{signedOut:true});
 await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session'})),e=>e.status===401);
});
test('malformed pending replacement is rejected before the logout barrier',async()=>{
 const f=fixture(),data=await f.login();f.state.calls=[];
 await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session/logout',method:'POST',postBody:{replacementToken:'bad'}})));
 assert.equal(f.state.calls.some(c=>c.text===PIN_LOGOUT_SQL),false);assert.equal(f.state.revoked,false);
});
test('renewal rejects revoked or changed authority and wrong device, installation, profile or group',async()=>{
 for(const mode of ['revoked','authority','device','installation','profile','group']){
  const f=fixture(),data=await f.login();f.state.time=data.expiresAt+1;
  if(mode==='revoked')f.state.revoked=true;if(mode==='authority')f.state.changedAuthority=true;
  const headers=mode==='device'?{'X-BuriMunsi-Device':'c'.repeat(64)}:mode==='installation'?{'X-BuriMunsi-Installation':id(77)}:
   mode==='profile'?{'X-BuriMunsi-Profile':'staff'}:{};
  await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session',group:mode==='group'?'other-group':'actual-group',headers}),()=>assert.fail('Must not authorize')),
   e=>e.status===401);
  assert.equal([...f.state.sessions.values()][0].expires,data.expiresAt);
 }
});
test('lost renewal response can be retried with the same proof without creating another session',async()=>{
 const f=fixture(),data=await f.login();f.state.time=data.expiresAt+1;
 await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session'}),()=>{throw Error('Synthetic lost response')}));
 let actor;await f.invoke(f.request({login:false,token:data.token,path:'/session'}),value=>{actor=value});
 assert.equal(f.state.sessions.size,1);assert.equal(actor.principalSessionId,[...f.state.sessions.values()][0].id);
 f.state.revoked=true;await assert.rejects(f.invoke(f.request({login:false,token:data.token,path:'/session'})),e=>e.status===401);
});
test('revocation, stored-token hash and different group intent cannot authenticate ordinary routes',async()=>{
 for(const mode of ['revoked','hash','scope']){
  const f=fixture(),data=await f.login();if(mode==='revoked')f.state.revoked=true;
  const request=f.request({login:false,token:mode==='hash'?await sha256(data.token):data.token,group:mode==='scope'?'different-group':'actual-group'});
  await assert.rejects(f.invoke(request,()=>{assert.fail('Must not assemble business adapters');}));assert.equal(hasPhonePinContext(f.db),false);
 }
});
test('signout and another approved operator on same installation resolve fresh account and scope',async()=>{
 const f=fixture(),first=await f.login();f.state.revoked=true;
 f.state.account={...f.state.account,id:id(8),groupId:'another-approved-group',principalUserId:'another-real-principal',name:'Second synthetic operator'};
 f.state.revoked=false;const second=await f.login();
 assert.equal(second.groupId,'another-approved-group');assert.equal(second.profile.id,id(8));assert.notEqual(second.token,first.token);
 assert.equal(f.state.calls.filter(x=>x.text.includes('create_session')).every(x=>x.args[2]===installation&&x.args[4].length===64),true);
});
test('no native proof is available outside an authenticated request and a forged context flag is ignored',async()=>{
 const f=fixture();f.db.phonePin=true;assert.equal(await applyPhonePinContext(f.db,f.sql,'actual-group'),false);
 assert.equal(f.state.calls.length,0);assert.equal(hasPhonePinContext(f.db),false);
});

// Historical retirement proof is deliberately NOT an ordinary session. This
// SQL policy double returns only its one receipt; PostgreSQL33 separately
// proves expiry, approval/PIN revocation and exact intent/binding revisions.
function retirementFixture(){
 const f=fixture(),token='a'.repeat(64),fingerprint='b'.repeat(64),requestId=id(31),handoffId=id(32);
 const ack={retired:true,handoffId,requestId,reauthenticationRequired:true};
 f.state.outcome={kind:'gateway_retirement_outcome',collectionId:'actual-group',actorId:id(2),sessionId:id(9),
  installationId:installation,profile:'internal_receiver',requestId,fingerprint,state:'retired',ack};
 const unsafe=f.sql.unsafe;
 f.sql.unsafe=async(text,args=[])=>{
  if(text==='SELECT pg_is_in_recovery() AS replica'){f.state.calls.push({text,args});return [{replica:f.state.replica===true}];}
  if(text===RETIREMENT_OUTCOME_SQL){
   f.state.calls.push({text,args});assert.equal(hasPhonePinContext(f.db),false);
   if(f.state.outcomeError)throw f.state.outcomeError;
   if(args[0]!==token||args[1]!==installation||args[2]!==device||args[3]!=='internal_receiver'||args[4]!==requestId||args[5]!==fingerprint)
    throw Object.assign(Error('Synthetic limited proof denial'),{code:'42501'});
   return [{result:f.state.outcome}];
  }
  return unsafe(text,args);
 };
 f.retirementRequest=(changes={},suffix='')=>{
  const original=f.request({login:false,token,headers:{'X-BuriMunsi-Handoff-Fingerprint':fingerprint,...changes}});
  return new Request(origin+'/v1/burimunsi/gateway/replacements/'+requestId+'/outcome'+suffix,{headers:original.headers});
 };
 return Object.assign(f,{token,fingerprint,requestId,ack});
}
test('retired four-proof GET resolves ACK on a primary read snapshot without native authority or route composition',async()=>{
 const f=retirementFixture(),response=await f.invoke(f.retirementRequest()),body=await response.json();
 assert.equal(response.status,200);assert.deepEqual(body.data,{protocol:'burimunsi.receiver-retirement.v1',requestId:f.requestId,fingerprint:f.fingerprint,state:'retired',ack:f.ack});
 assert.equal(body.binding.actorId,id(2));assert.equal(body.binding.groupId,'actual-group');
 assert.deepEqual(f.state.calls.find(c=>c.text===RETIREMENT_OUTCOME_SQL).args,[f.token,installation,device,'internal_receiver',f.requestId,f.fingerprint]);
 assert.ok(f.state.calls.some(c=>c.text.includes('REPEATABLE READ, READ ONLY')));
 assert.equal(f.state.calls.some(c=>c.text===PIN_CONTEXT_SQL||c.text===PIN_SET_CONTEXT_SQL||/pg_advisory_xact_lock|\b(?:INSERT|UPDATE|DELETE)\b/.test(c.text)),false);
 assert.equal(hasPhonePinContext(f.db),false);assert.deepEqual(f.state.claims,{});
 assert.equal(JSON.stringify(body).includes(f.token),false);assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('unknown retirement can only report unknown and has no no-commit/replay assertion',async()=>{
 const f=retirementFixture();f.state.outcome={...f.state.outcome,state:'unknown',ack:null};
 const body=await (await f.invoke(f.retirementRequest())).json();assert.equal(body.data.state,'unknown');assert.equal(body.data.ack,null);
 assert.deepEqual(Object.keys(body.data).sort(),['protocol','requestId','fingerprint','state','ack'].sort());
});
for(const [label,change]of [
 ['bearer',{Authorization:'Bearer '+'e'.repeat(64)}],['device',{'X-BuriMunsi-Device':'c'.repeat(64)}],
 ['installation',{'X-BuriMunsi-Installation':id(77)}],['profile',{'X-BuriMunsi-Profile':'staff'}],
 ['fingerprint',{'X-BuriMunsi-Handoff-Fingerprint':'c'.repeat(64)}]
])test('historical outcome rejects changed raw '+label+' proof',async()=>{
 const f=retirementFixture();await assert.rejects(f.invoke(f.retirementRequest(change)),e=>e.code==='session_unavailable'&&e.status===401);
 assert.equal(hasPhonePinContext(f.db),false);
});
test('expired/revoked original proof cannot recover even a committed historical ACK',async()=>{
 const f=retirementFixture();f.state.outcomeError=Object.assign(Error('Synthetic expiry/current approval/PIN revocation'),{code:'42501'});
 await assert.rejects(f.invoke(f.retirementRequest()),e=>e.status===401);
});
test('replica, query data and caller-selected scope cannot expose retirement receipt',async()=>{
 let f=retirementFixture();f.state.replica=true;await assert.rejects(f.invoke(f.retirementRequest()),e=>e.code==='command_primary_required');
 assert.equal(f.state.calls.some(c=>c.text===RETIREMENT_OUTCOME_SQL),false);
 f=retirementFixture();await assert.rejects(f.invoke(f.retirementRequest({},'?replay=true')),e=>e.code==='invalid_query');assert.equal(f.state.calls.length,0);
 f=retirementFixture();await assert.rejects(f.invoke(f.retirementRequest({'X-BuriMunsi-Group':'another-group'})),e=>e.status===403);
});
for(const edit of [v=>({...v,installationId:id(88)}),v=>({...v,requestId:id(88)}),v=>({...v,fingerprint:'c'.repeat(64)}),
 v=>({...v,state:'unknown'}),v=>({...v,ack:{...v.ack,gateway_token:'c'.repeat(64)}}),v=>({...v,ack:{...v.ack,requestId:id(88)}})])
 test('limited SQL receipt cannot publish inconsistent or secret-bearing ACK',async()=>{
  const f=retirementFixture();f.state.outcome=edit(f.state.outcome);await assert.rejects(f.invoke(f.retirementRequest()));assert.equal(hasPhonePinContext(f.db),false);
 });

test('a current session shares one read snapshot without a writer; a near expiry session renews once',async()=>{
 const f=fixture(),login=await f.login();let active=false,reads=0;
 f.db.withNativeReadSnapshot=async fn=>{active=true;reads++;try{return await fn(f.sql);}finally{active=false;}};
 f.db.ownsNativeRead=tx=>active&&tx===f.sql;
 const request=()=>f.request({login:false,path:'/session',token:login.token});
 const read=async(principal)=>{
  assert.equal(principal.nativeAccountId,login.profile.id);
  return new Response('ok');
 };
 assert.equal((await f.invoke(request(),read)).status,200);
 assert.equal(reads,1);assert.equal(f.state.calls.filter(x=>x.text===PIN_RENEW_SQL).length,0);
 f.state.time=login.expiresAt-30000;
 assert.equal((await f.invoke(request(),read)).status,200);
 assert.equal(f.state.calls.filter(x=>x.text===PIN_RENEW_SQL).length,1);
 f.state.revoked=true;await assert.rejects(f.invoke(request(),read),{code:'session_unavailable'});
});
test('login with Home returns the new token even when its optional projection is unavailable',async()=>{
 const f=fixture();
 const response=await f.invoke(f.request({query:'?include=home'}),async(principal,env,req)=>{
  assert.equal(new URL(req.url).search,'?include=home');
  assert.equal(req.method,'GET');assert.equal(req.headers.get('X-BuriMunsi-Group'),principal.groupId);
  return new Response('',{status:503});
 });
 const data=(await response.json()).data;
 assert.match(data.token,/^[a-f0-9]{64}$/);assert.equal(data.home,null);
 assert.equal(f.state.sessions.size,1);
});

test('fresh Staff login can attach scoped Home and extended read routes keep their original permissions',async()=>{
 const f=fixture();
 f.state.account.role='staff';f.state.account.capabilities=['records.read'];
 f.db.withNativeReadSnapshot=fn=>f.db.transaction(async sql=>{
  await sql.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const response=await fn(sql);await f.db.applicationWork.assert();return response;
 });
 const {handler}=freshRead(f);
 let homeReads=0;
 f.state.readQuery=(text,args)=>{
  assert.match(text,/WITH credited AS MATERIALIZED/);assert.equal(args[0],'actual-group');homeReads++;
  return [{balance:1000,today:1000,members:1,unallocated:0,unallocated_amount:0,id:null}];
 };
 const context={BURIMUNSI_PRODUCT_MODE:'standalone'};
 const response=await f.invoke(f.request({query:'?include=home'}),(_principal,_env,req)=>handler(req),context);
 assert.equal(response.status,200,await response.clone().text());
 const {data,binding}=await response.json();
 assert.equal(data.profile.role,'staff');assert.equal(data.home.groupBalanceRwf,1000);assert.equal(binding.actorId,id(2));
 assert.equal(f.state.sessions.has(await sha256(data.token)),true);
 const read=path=>{
  const req=f.request({login:false,token:data.token,path});
  return f.invoke(req,()=>handler(req),context);
 };
 const before=f.state.transactions;
 const home=await read('/home');
 assert.equal(home.status,200,await home.clone().text());
 assert.equal((await home.json()).data.groupBalanceRwf,1000);
 assert.equal(f.state.transactions-before,1);
 assert.equal((await read('/staff')).status,403);
 assert.equal((await read('/members/suggestions')).status,403);
 assert.equal(homeReads,2);
});

test('fresh snapshot rolls back when the original response binding changes after actor verification',async()=>{
 const f=fixture(),login=await f.login(),{handler}=freshRead(f);
 const req=f.request({login:false,token:login.token,path:'/session',query:'?include=home'});
 f.state.readQuery=()=>{
  req.headers.set('X-BuriMunsi-Generation','8');
  return [{balance:1000,today:1000,members:1,unallocated:0,unallocated_amount:0,id:null}];
 };
 const before=f.state.rollbacks;
 await assert.rejects(f.invoke(req,()=>handler(req),{BURIMUNSI_PRODUCT_MODE:'standalone'}),{code:'request_not_admitted'});
 assert.equal(f.state.rollbacks-before,1);assert.equal(hasPhonePinContext(f.db),false);
});
