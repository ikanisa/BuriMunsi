// Exercise the Edge's pinned driver against the socket-only managed PG17 fixture.
import assert from 'node:assert/strict';
import postgres from 'npm:postgres@3.4.7';
import {openApplicationWork,sqlFenceBackend} from '../../../../supabase/functions/_shared/application-fence.js';
import {PostgresDatabase} from '../../../../supabase/functions/_shared/postgres.js';
import {createPhonePinRequestGate} from '../../../../supabase/functions/_shared/domain/burimunsi/phone-pin-request.js';
import {createNativeHandler} from '../../../../supabase/functions/_shared/domain/burimunsi/http.js';
import {PostgresNativeAuthStore} from '../../../../supabase/functions/_shared/domain/burimunsi/postgres-auth-store.js';
import {PostgresNativeObservations} from '../../../../supabase/functions/_shared/domain/burimunsi/postgres-observations.js';
import {validateProviderProfile} from '../../../../supabase/functions/_shared/domain/momo_pipeline.js';

const [socket,portText,database]=Deno.args;
assert.match(socket,/^\/(?:private\/)?tmp\/collect-pg-transfer-[a-zA-Z0-9]+\/s$/);
assert.match(database,/^collect_archive_[a-f0-9]{24}_test$/);
const port=Number(portText);assert.ok(Number.isInteger(port)&&port>=51000&&port<=60999);
const sql=postgres({host:socket,port,database,user:'postgres',ssl:false,max:5,prepare:false,onnotice() {},
 types:{whole:{to:20,from:[20,1700],serialize:String,parse:v=>{const n=Number(v);assert.ok(Number.isSafeInteger(n));return n;}}}});
const {phone,group,source}=await new Response(Deno.stdin.readable).json();
const origin='https://fixture.invalid',unused=()=>assert.fail('unexpected fixture service');
const backend=sqlFenceBackend(sql,sql);
const gate=createPhonePinRequestGate({origin,secrets:{pinPepper:new Uint8Array(32),pinPepperId:'fixture'},networkBucket:unused});
const run={runId:crypto.randomUUID(),expectedConsentGeneration:1,state:'checking',candidateCount:0,missingCount:0,
 pendingCount:0,phoneLatestKey:null,parsedLatestKey:null,collectionRevision:null};

async function route(path,body,{previousBinding=false}={}){
 const work=await openApplicationWork({backend,sourceSha256:source,kind:'http_collect'});
 try{
  const db=new PostgresDatabase(sql,{},work),env={DB:db,PRIVATE_MEDIA:{put:unused,get:unused}};
  const request=new Request(origin+'/v1/burimunsi/sms/observations'+path,{method:'POST',headers:{
   'x-burimunsi-auth':'phone_pin','x-burimunsi-installation':phone.install,'x-burimunsi-profile':phone.profile,'x-burimunsi-device':phone.device,
   'x-burimunsi-contract':'burimunsi.native.v1','x-burimunsi-request':crypto.randomUUID(),'x-burimunsi-generation':'1',
   'x-burimunsi-group':group,authorization:'Bearer '+phone.token,'content-type':'application/json'},body:JSON.stringify(body)});
  return await gate({request,env},async principal=>{
   const authority=new PostgresNativeAuthStore({db,groupId:group,createOperatorPrincipal:unused});
   if(previousBinding){
    await assert.rejects(()=>authority.write(tx=>tx.unsafe('SELECT private.burimunsi_observation_inbox_check($1::jsonb)',[JSON.stringify(body)])),
     error=>error.code==='42501'&&error.message==='burimunsi_observation_consent_changed');
    return;
   }
   const observations=new PostgresNativeObservations({authority,env,validateProviderProfile,custody:{journal:unused,sameJournal:unused,decrypt:unused},
    storageWitnesses:{stage:unused,prefetch:unused,sealed:unused,forget:unused}});
   const authenticate=()=>authority.read(tx=>authority.session(tx,{id:principal.principalSessionId}));
   const handler=createNativeHandler({origin,groupId:group,strictContract:true,verifiedObservationStatusEnabled:true,networkBucket:unused,
    auth:{login:unused,logout:unused,changePasscode:unused,manageStaff:unused,authenticate},observations,
    records:{home:unused,page:unused,detail:unused,exportLedger:unused,commandStatus:unused},
    contributions:{allocate:unused},members:{enroll:unused,setActive:unused},gateway:{status:unused,replace:unused}});
   return handler(request);
  });
 }finally{assert.equal((await work.finish()).state,'settled');}
}
async function data(path,body,status=200){
 const response=await route(path,body);const result=await response.json();
 assert.equal(response.status,status,JSON.stringify(result));return result.data;
}
try{
 const [identity]=await sql.unsafe("SELECT inet_server_addr() IS NULL AS local,current_setting('cluster_name') AS name,current_user AS actor,current_setting('server_version_num')::int/10000 AS major");
 assert.deepEqual({...identity},{local:true,name:'collect_archive_next_fixture',actor:'postgres',major:17});
 await route('/inbox-check',run,{previousBinding:true});
 await data('/inbox-check',{...run,expectedConsentGeneration:2},403);
 assert.equal((await data('/inbox-check',run)).state,'checking');
 const id=crypto.randomUUID();
 assert.deepEqual((await data('/processing-status',{sourceIds:[id]})).statuses,[{sourceId:id,status:'unknown',canRetry:false}]);
 const item={sourceKey:'3'.repeat(64),bodySha256:'4'.repeat(64),rawSender:'+15555219877',
  inboxReceivedAt:new Date().toISOString(),serviceCentreAt:null,subscriptionId:1};
 const items=Array.from({length:10},(_,i)=>({...item,sourceKey:(10-i).toString(16).padStart(64,'0'),
  bodySha256:(i+1).toString(16).repeat(64),...(i===1?{gatewayEnvelopeId:crypto.randomUUID()}:{})}));
 const batch={runId:run.runId,items,includeProcessing:true};
 for(let attempt=0;attempt<2;attempt++){
  const page=await data('/reconcile-batch',batch);
  assert.deepEqual(page.items,items.map(x=>({sourceKey:x.sourceKey,state:'missing',sourceId:null})));
 }
 assert.equal((await data('/inbox-check',{...run,state:'incomplete',candidateCount:10,missingCount:10,phoneLatestKey:items[0].sourceKey})).state,'incomplete');
 console.log(JSON.stringify({driver:'postgres@3.4.7',original:'42501 consent_changed',staleConsent:403,checkpoint:200,processingStatus:200,page:200,missing:'incomplete'}));
}finally{await sql.end();}
