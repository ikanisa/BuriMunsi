import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const moduleRoot=process.env.COLLECT_FENCE_CONTROL_SOURCE_ROOT;
const {CONTROL_ROLLBACK_ACK,sqlFenceBackend,openApplicationWork,assertWorkOwner}=await import(moduleRoot?pathToFileURL(join(moduleRoot,'application-fence.js')).href:new URL('../application-fence.js',import.meta.url).href);
const SOURCE='a'.repeat(64),ID='11111111-1111-4111-8111-111111111111';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

// Fake wire only: the real sqlFenceBackend owns every BEGIN/ROLLBACK/reserve and
// real openApplicationWork owns register/close. This is not native PG proof.
function fixture({begin=async()=>[],rollback=async()=>[],role=async()=>[],verifyAdmission}={}){
 const events=[],rows=new Map(),releaseAcks=[];
 const tx={unsafe(text,values=[]){events.push(text);if(text.startsWith('BEGIN'))return begin();if(text==='ROLLBACK')return rollback();if(text.includes('SET LOCAL ROLE collect_runtime'))return role();if(text.startsWith('SELECT private.collect_fence_assert_work'))return Promise.resolve([{result:{...rows.get(values[0]),mode:'open'}}]);return Promise.resolve([]);},release(ack){releaseAcks.push(ack);events.push('RESERVATION_RELEASE');}};
 const control={async reserve(){events.push('RESERVE');return tx;}};
 const business={async begin(options,fn){assert.equal(options,'ISOLATION LEVEL READ COMMITTED');return fn({async unsafe(text,values=[]){events.push(text);if(text.startsWith('SELECT private.collect_fence_register')){const [id,source,kind]=values;const row={contractVersion:1,admissionId:id,sourceSha256:source,epoch:1,kind,state:'active',mode:'open'};rows.set(id,row);return[{result:{...row}}];}if(text.startsWith('SELECT private.collect_fence_close')){const [id,,source,state,reason,externalDispatches,uncertainDispatches]=values;const row={...rows.get(id),sourceSha256:source,state,reason,externalDispatches,uncertainDispatches};rows.set(id,row);return[{result:{...row}}];}if(text.startsWith('SELECT private.collect_fence_work_status'))return[{result:{...rows.get(values[0]),found:rows.has(values[0])}}];return[];}});}};
 const backend=sqlFenceBackend(business,control,verifyAdmission);
 const register=()=>backend.register(ID,SOURCE,'http_collect');
 return{backend,events,rows,register,releaseAcks,releases:()=>releaseAcks.length,rollbacks:()=>events.filter(x=>x==='ROLLBACK').length,closes:()=>events.filter(x=>x.startsWith('SELECT private.collect_fence_close')).length,open:()=>openApplicationWork({backend,sourceSha256:SOURCE,kind:'http_collect',id:ID})};
}

test('registration runs its optional check after role setup in the same transaction',async()=>{
 const f=fixture({verifyAdmission:tx=>tx.unsafe('SELECT 42 AS deployment_check')});
 await f.register();
 assert.match(f.events[0],/SET LOCAL ROLE collect_runtime/);
 assert.equal(f.events[1],'SELECT 42 AS deployment_check');
 assert.match(f.events[2],/SELECT private\.collect_fence_register/);
 await f.backend.status(ID);
 assert.equal(f.events.filter(sql=>sql.includes('deployment_check')).length,1);
});

test('registration proof failure cannot dispatch register or lease work',async()=>{
 const f=fixture({verifyAdmission:async()=>{throw Error('synthetic_deployment_rejected');}});
 await assert.rejects(f.open(),{code:'application_fence_unavailable'});
 assert.equal(f.rows.size,0);
 assert.equal(f.events.some(sql=>sql.includes('collect_fence_register')||sql==='RESERVE'),false);
});

test('local ownership check avoids another wire assertion and refuses lost work',async()=>{
 const f=fixture(),work=await f.open();
 const assertionCount=()=>f.events.filter(sql=>sql.startsWith('SELECT private.collect_fence_assert_work')).length;
 const before=assertionCount();
 assert.doesNotThrow(()=>assertWorkOwner(work));
 assert.equal(assertionCount(),before);
 work.abandon('lease_lost');
 assert.throws(()=>assertWorkOwner(work),{code:'application_fence_unavailable'});
 assert.equal(assertionCount(),before);
 await work.finish();
});

test('control release waits for original rollback ACK; concurrent cleanup never duplicates SQL or releases early',async()=>{
 const raw=deferred(),f=fixture({rollback:()=>raw.promise});await f.register();const lease=await f.backend.lease(ID,1,SOURCE);let settled=false;const first=lease.release().then(()=>{settled=true;}),second=lease.release();await tick();assert.equal(f.rollbacks(),1);assert.equal(f.releases(),0);assert.equal(settled,false);await assert.rejects(lease.assert(),{code:'application_fence_unavailable'});raw.resolve([]);await Promise.all([first,second]);assert.equal(f.releases(),1);await lease.release();assert.equal(f.rollbacks(),1);assert.equal(f.releases(),1);
 assert.deepEqual(f.releaseAcks,[CONTROL_ROLLBACK_ACK]);
});

test('rejected control rollback quarantines reservation and never retries or returns it to the pool',async()=>{
 const f=fixture({rollback:async()=>{throw Error('synthetic rollback acknowledgement lost');}});await f.register();const lease=await f.backend.lease(ID,1,SOURCE);await assert.rejects(lease.release());await assert.rejects(lease.release());await assert.rejects(lease.assert());assert.equal(f.rollbacks(),1);assert.equal(f.releases(),0);
});

test('ambiguous rejected BEGIN attempts original rollback and holds reservation until ACK',async()=>{
 const raw=deferred(),failure=Error('synthetic BEGIN acknowledgement lost'),f=fixture({begin:async()=>{throw failure;},rollback:()=>raw.promise});await f.register();let settled=false;const leasing=f.backend.lease(ID,1,SOURCE);const observed=assert.rejects(leasing,error=>error===failure).then(()=>{settled=true;});await tick();assert.equal(f.rollbacks(),1);assert.equal(f.releases(),0);assert.equal(settled,false);raw.resolve([]);await observed;assert.equal(f.releases(),1);assert.equal(f.events.some(x=>x.includes('pg_advisory_xact_lock_shared')),false);
});

test('synchronous BEGIN dispatch failure still requires acknowledged rollback before reservation reuse',async()=>{
 const f=fixture({begin:()=>{throw Error('synthetic sync BEGIN failure');}});await f.register();await assert.rejects(f.backend.lease(ID,1,SOURCE));assert.equal(f.rollbacks(),1);assert.equal(f.releases(),1);assert.equal(f.events.indexOf('ROLLBACK')<f.events.indexOf('RESERVATION_RELEASE'),true);
});

test('ambiguous BEGIN plus rejected rollback is quarantined; cancellation closes only original registration',async()=>{
 const f=fixture({begin:async()=>{throw Error('synthetic BEGIN acknowledgement lost');},rollback:async()=>{throw Error('synthetic rollback lost');}});await assert.rejects(f.open(),{code:'application_fence_unavailable'});assert.equal(f.releases(),0);assert.equal(f.rollbacks(),1);assert.equal(f.rows.size,1);assert.equal(f.rows.get(ID).reason,'cancelled_before_work');assert.equal(f.rows.get(ID).externalDispatches,0);assert.equal(f.closes(),1);
});

test('post-BEGIN setup failure and rejected rollback quarantine the control reservation',async()=>{
 const f=fixture({role:async()=>{throw Error('synthetic role setup denied');},rollback:async()=>{throw Error('synthetic rollback lost');}});await assert.rejects(f.open());assert.equal(f.releases(),0);assert.equal(f.rollbacks(),1);assert.equal(f.rows.get(ID).reason,'cancelled_before_work');assert.equal(f.closes(),1);
});

test('exact durable close is preserved when later cleanup rejects; no fabricated unresolved rewrite or replay',async()=>{
 const f=fixture({rollback:async()=>{throw Error('synthetic rollback lost');}}),work=await f.open();let sends=0;await work.dispatch('smtp',()=>{sends++;});work.unknown('smtp');const result=await work.finish();assert.equal(result.state,'settled');assert.equal(result.reason,'completed_with_unknown_obligation');assert.equal(result.uncertainDispatches,1);assert.equal(result.providerSettlement,false);assert.equal(result.wholeSystemAcceptance,false);assert.equal(f.closes(),1);assert.equal(f.rows.get(ID).state,'settled');assert.equal(f.rows.get(ID).reason,'completed_with_unknown_obligation');assert.equal(f.releases(),0);assert.equal(f.rollbacks(),1);assert.equal(sends,1);
});

test('finish awaits cleanup ACK after exact close while original reservation remains unavailable',async()=>{
 const raw=deferred(),f=fixture({rollback:()=>raw.promise}),work=await f.open();let finished=false;const done=work.finish().then(value=>{finished=true;return value;});await tick();assert.equal(f.closes(),1);assert.equal(f.rows.get(ID).state,'settled');assert.equal(finished,false);assert.equal(f.releases(),0);raw.resolve([]);assert.equal((await done).state,'settled');assert.equal(f.releases(),1);assert.equal(f.closes(),1);
});

test('5s cleanup observation timeout preserves original raw rollback; late ACK alone releases once',async()=>{
 const raw=deferred(),f=fixture({rollback:()=>raw.promise});await f.register();const lease=await f.backend.lease(ID,1,SOURCE),start=performance.now();await assert.rejects(lease.release(),{code:'application_fence_unavailable'});const elapsed=performance.now()-start;assert.ok(elapsed>=4500&&elapsed<8000);assert.equal(f.rollbacks(),1);assert.equal(f.releases(),0);await assert.rejects(lease.assert());raw.resolve([]);await tick();assert.equal(f.releases(),1);await lease.release();assert.equal(f.rollbacks(),1);assert.equal(f.releases(),1);
 assert.deepEqual(f.releaseAcks,[undefined]);
});

test('late rollback rejection after observation timeout remains quarantined without unhandled or repeat SQL',async()=>{
 const raw=deferred(),f=fixture({rollback:()=>raw.promise});await f.register();const lease=await f.backend.lease(ID,1,SOURCE);await assert.rejects(lease.release(),{code:'application_fence_unavailable'});assert.equal(f.releases(),0);raw.reject(Error('synthetic late rollback lost'));await tick();await assert.rejects(lease.release());assert.equal(f.releases(),0);assert.equal(f.rollbacks(),1);
});
