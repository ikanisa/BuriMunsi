// Runs on the socket-only managed archive fixture after its protected synthetic
// team is enrolled. These calls use the production HTTP gate and PostgreSQL stores.
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Buffer} from 'node:buffer';
import {applicationWorkTuple, openApplicationWork, sqlFenceBackend} from '../../functions/_shared/application-fence.js';
import {CONTRACT_VERSION} from '../../functions/_shared/domain/burimunsi/wire/native-contract.mjs';
import {createPhonePinRequestGate, phonePinReadSelector} from '../../functions/_shared/domain/burimunsi/phone-pin-request.js';
import {PostgresDatabase} from '../../functions/_shared/postgres.js';
import {PostgresNativeAuthStore} from '../../functions/_shared/domain/burimunsi/postgres-auth-store.js';
import {PostgresPhonePinSessions} from '../../functions/_shared/domain/burimunsi/postgres-phone-pin-sessions.js';
import {PostgresOperatorDirectory} from '../../functions/_shared/domain/burimunsi/postgres-operator-directory.js';
import {PostgresRecordsStore} from '../../functions/_shared/domain/burimunsi/postgres-records-store.js';
import {RecordsService} from '../../functions/_shared/domain/burimunsi/records-service.js';
import {handleAdmin} from '../../functions/_shared/domain/admin_bridge.js';
import {PostgresNativeObservations} from '../../functions/_shared/domain/burimunsi/postgres-observations.js';
import {SupabaseObjectBucket} from '../../functions/_shared/storage/bucket.js';
import {ProtectedStorageProtocol} from '../../functions/_shared/storage/protocol.js';
import {PostgresStorageWitnesses} from '../../functions/_shared/domain/burimunsi/postgres-storage-witnesses.js';
import {PostgresPostingCustody} from '../../functions/_shared/domain/burimunsi/postgres-posting-custody.js';
import {decrypt} from '../../functions/_shared/domain/encryption.js';
import {PostgresNativeAutoWorker} from '../../functions/_shared/domain/burimunsi/postgres-native-auto-worker.js';
import {PostgresNativeSmsLedger} from '../../functions/_shared/domain/burimunsi/postgres-native-sms-ledger.js';
import {MOMO_SCHEMA_VERSION} from '../../functions/_shared/domain/momo_pipeline.js';
import {validateProviderProfile} from '../../functions/_shared/domain/momo_pipeline.js';
import {createNativeHandler} from '../../functions/_shared/domain/burimunsi/http.js';

const group = 'browser-fixture-group';
const origin = 'https://synthetic.invalid';
const home = '/session?include=home';
const payments = '/payments?filter=all&sort=newest&limit=100';
const accounts = [
  {role:'staff', profile:'staff', id:'20000000-0000-4000-8000-000000000002', version:2},
  {role:'admin', profile:'internal_receiver', id:'20000000-0000-4000-8000-000000000001', version:1},
];
const token = () => randomBytes(32).toString('hex');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const unused = () => { throw Error('Unexpected write or external operation'); };

export async function qualifyUnpairedCustody({pool, inspect, source}) {
  const backend = sqlFenceBackend(pool, pool);
  async function admitted(fn, kind = 'http_collect') {
    const admission = await openApplicationWork({backend, sourceSha256:source, kind});
    try {
      return await fn(new PostgresDatabase(pool, {}, admission));
    } finally {
      assert.equal((await admission.finish()).state, 'settled');
    }
  }

  async function issue(account, ttl) {
    const actor = {...account, session:randomUUID(), installation:randomUUID(), device:token(), bearer:token()};
    await admitted(db => db.transaction(async sql => {
      await db.context(sql);
      const now = Date.now();
      const rows = await sql.unsafe(`SELECT private.burimunsi_pin_create_session(
        $1,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,$9,$10,$6) AS result`,
      [group, actor.id, actor.installation, actor.profile, hash(actor.device), actor.version,
        actor.session, hash(actor.bearer), now, now+ttl]);
      assert.equal(rows[0].result.created, true);
    }));
    return actor;
  }

  const objects=new Map();
  const storageOrigin='https://storage.fixture.invalid';
  const receipt='You have received 1,250 RWF from Example Person 0788123456. Reference: ABC123. Fee 10 RWF. Balance 9,000 RWF.';
  const transport={
    async probe(key){
      const item=objects.get(key);
      return item?{headStatus:200,getStatus:200,absent:false,bucketVerified:true,bytes:new Uint8Array(item),etag:'fixture'}:
        {headStatus:404,getStatus:404,absent:true,bucketVerified:true};
    },
    async uploadImmutable(key,bytes){
      assert.ok(!objects.has(key),'a durable upload must not be repeated');
      assert.ok(!new TextDecoder().decode(bytes).includes(receipt),'plaintext must not leave the adapter');
      objects.set(key,new Uint8Array(bytes));return{status:200};
    },
  };
  async function consent(actor,input,path='observation-consent',probeLegacy=false){
    return admitted(async db=>{
      const env={DB:db,BURIMUNSI_PRODUCT_MODE:'standalone',SUPABASE_URL:storageOrigin,
        SUPABASE_SECRET_KEY:'sb_secret_fixture_only',DATA_KEY_ID:'synthetic-key',
        DATA_ENCRYPTION_KEY:Buffer.alloc(32,29).toString('base64'),COLLECT_FENCE_WORK:db.applicationWork};
      const media=new SupabaseObjectBucket(env);
      media.transport=transport;
      media.protocol=new ProtectedStorageProtocol({transport,journal:media.journal});
      env.PRIVATE_MEDIA=media;
      const gate=createPhonePinRequestGate({origin,secrets:{},networkBucket:unused});
      const headers={
        'X-BuriMunsi-Contract':CONTRACT_VERSION, 'X-BuriMunsi-Request':randomUUID(),
        'X-BuriMunsi-Generation':'1', 'X-BuriMunsi-Auth':'phone_pin',
        'X-BuriMunsi-Installation':actor.installation,'X-BuriMunsi-Profile':actor.profile,
        'X-BuriMunsi-Device':actor.device,'X-BuriMunsi-Group':actor.requestGroup??group,Authorization:'Bearer '+actor.bearer,
      };
      const request = new Request(origin+'/v1/burimunsi'+(path.startsWith('/')?path:'/sms/'+path),input?{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(input)}:{headers});
      const response=await gate({request,env},async principal=>{
        const authority=new PostgresNativeAuthStore({db,groupId:group,createOperatorPrincipal:unused});
        if(path.startsWith('/')){
          const sessions=new PostgresPhonePinSessions({db,groupId:group});
          const directory=new PostgresOperatorDirectory({db,groupId:group,managedSessions:sessions});
          const recordsAuthority=new PostgresNativeAuthStore({db,groupId:group,sessionBinding:sessions,operatorDirectory:directory,createOperatorPrincipal:unused});
          const store=new PostgresRecordsStore({authority:recordsAuthority,nativeAutoRecordsEnabled:true,sourceReader:{revision:unused,page:unused,detail:unused}});
          const records=new RecordsService({store,groupId:group,cursor:{create:unused,read:unused}});
          return createNativeHandler({origin,groupId:group,strictContract:true,allowHomeSavings:true,records,
            auth:{login:unused,authenticate:()=>authority.read(tx=>authority.session(tx,{id:principal.principalSessionId})),logout:unused,changePasscode:unused,manageStaff:unused},
            contributions:{allocate:unused},members:{enroll:unused,setActive:unused},gateway:{status:unused,replace:unused},networkBucket:unused,
            readRecordActor:req=>phonePinReadSelector(db,req)})(request);
        }
        if(probeLegacy){
          await assert.rejects(authority.write(async tx=>{
            const ctx=(await tx.unsafe('SELECT private.burimunsi_observation_context() AS result'))[0].result;
            assert.ok(validateProviderProfile(ctx));
            await tx.unsafe('SELECT private.burimunsi_observation_legacy_retry_prepare($1::uuid,$2,$3,$4,$5,$6::bigint)',
              [input.requestId,hash('synthetic fingerprint'),randomUUID(),ctx.profile_version,ctx.profile_sha256,ctx.consentGeneration]);
          }),e=>e.code==='55000'&&e.message==='burimunsi_observation_source_key_required');
          return Response.json({reason:'burimunsi_observation_source_key_required'});
        }
        const storageWitnesses=new PostgresStorageWitnesses({db,groupId:group,namespace:media.namespace,media,applicationWorkTuple});
        const custody=new PostgresPostingCustody({db,groupId:group,namespace:media.namespace,storageWitnesses,
          decrypt:(body,aad)=>decrypt(env,body,aad)});
        const observations=new PostgresNativeObservations({authority,env,validateProviderProfile,custody,storageWitnesses});
        const handler=createNativeHandler({origin,groupId:group,strictContract:true,observations,
          auth:{login:unused,authenticate:()=>authority.read(tx=>authority.session(tx,{id:principal.principalSessionId})),
            logout:unused,changePasscode:unused,manageStaff:unused},
          records:{home:unused,page:unused,detail:unused,exportLedger:unused,commandStatus:unused},
          contributions:{allocate:unused},members:{enroll:unused,setActive:unused},
          gateway:{status:unused,replace:unused},networkBucket:unused});
        return handler(request);
      });
      return {status:response.status,body:await response.json(),cache:response.headers.get('Cache-Control')};
    });
  }
  try {
    const count=async()=> (await inspect("SELECT count(*)::int AS count FROM app.momo_gateway_credentials",[]))[0].count;
    assert.equal(await count(),0);
    const first=await issue(accounts[1],600000), second=await issue(accounts[1],600000),
      staff=await issue(accounts[0],600000);
    assert.notEqual(first.installation,second.installation);
    for(const a of [second,first]){
      const initial=await consent(a);
      assert.equal(initial.status,200,JSON.stringify(initial.body));
      const next={enabled:true,generation:initial.body.data.generation+1};
      const accepted=await consent(a,next);
      assert.equal(accepted.status,200,JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.data,next);
    }
    const stamp=new Date(Date.now()-60_000).toISOString();
    const requestId=randomUUID();
    const live={requestId,rawSender:'Example Money',rawBody:receipt,sourceMode:'live',complete:true,
      capturedAt:stamp,serviceCentreAt:stamp,inboxReceivedAt:null,subscriptionId:1};
    const rejected=await consent(first,live,'observations');
    assert.equal(rejected.status,503,JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code,'observation_unavailable');
    const sqlCause=await consent(first,live,'observations',true);
    assert.equal(sqlCause.body.reason,'burimunsi_observation_source_key_required');

    const noReservation=await inspect('SELECT count(*)::int AS n FROM private.burimunsi_observation_requests WHERE request_id=$1',[requestId]);
    assert.equal(noReservation[0].n,0);assert.equal(objects.size,0);
    console.log('PASS contract-valid new live unkeyed source fails closed before reservation or storage');

    const inputs=[first,second].map((a,i)=>({requestId:randomUUID(),sourceKey:hash('test-inbox:'+a.installation),
      rawSender:'Example Money',rawBody:receipt,sourceMode:'catch_up',complete:false,capturedAt:stamp,serviceCentreAt:stamp,inboxReceivedAt:stamp,subscriptionId:i+1}));
    const observations=[];
    for(const [i,a] of [first,second].entries()){
      const result=await consent(a,inputs[i],'observations');
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal(result.body.data.status,'source_unresolved');
      assert.equal(result.body.data.financialEffects,0);
      observations.push(result.body.data);
    }
    assert.equal(objects.size,2);
    assert.notEqual(observations[0].sourceId,observations[1].sourceId);
    const replay=await consent(first,inputs[0],'observations');
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.deepEqual(replay.body.data,observations[0]);assert.equal(objects.size,2);
    const rows=await inspect(`SELECT o.installation_id::text,o.body_sha256,j.state
      FROM private.burimunsi_unresolved_observations o JOIN private.storage_put_intents j ON j.object_key=o.object_key
      WHERE o.source_id IN($1,$2)`,observations.map(r=>r.sourceId));
    assert.deepEqual(new Set(rows.map(r=>r.installation_id)),new Set([first.installation,second.installation]));
    assert.ok(rows.every(r=>r.body_sha256===hash(receipt)&&r.state==='committed'));
    const candidateRows=await admitted(db=>db.transaction(async tx=>{
      await db.context(tx);
      await tx.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)",[group]);
      return tx.unsafe('SELECT private.burimunsi_auto_sources(10) AS result');
    }),'jobs');
    const jobRows=await inspect('SELECT count(*)::int AS n FROM private.burimunsi_auto_sms_jobs WHERE collection_id=$1',[group]);
    assert.equal(jobRows[0].n,0);
    const expected=observations.map(r=>r.sourceId).sort();
    assert.deepEqual(candidateRows[0].result.map(r=>r.sourceId).sort(),expected);
    console.log('PASS fenced jobs candidate selector returns both durable catch-up sources; no job rows written until an actual claim');

    console.log('PASS actual unpaired phone observation HTTP, encryption, PG custody and exact replay across two installations; no pairing or posting');
    const denied=await consent(staff,{enabled:true,generation:1});
    assert.equal(denied.status,403,JSON.stringify(denied.body));
    if(Deno.env.get('BURI_QA_UNPAIRED_WORKER')==='1'){
      const B={...inputs[1],requestId:randomUUID(),sourceKey:hash('synthetic-b'),rawBody:receipt.replace('ABC123','XYZ777')};
      const unmatchedBody=receipt.replace('Example Person 0788123456','Other Person 0788123999').replace('ABC123','XYZ888');
      const C={...inputs[0],requestId:randomUUID(),sourceKey:hash('synthetic-c'),rawBody:unmatchedBody};
      for(const [i,x] of [B,C].entries()){
        const posted=await consent(i===0?second:first,x,'observations');
        assert.equal(posted.status,200,JSON.stringify(posted.body));observations.push(posted.body.data);
      }
      const outgoing='You have sent 400 RWF to Example Shop 0788123456. Reference: OUT400. Fee 10 RWF. Balance 8,600 RWF.';
      const contradictory='You have sent 900 RWF to Example Shop 0788123456. Reference: OUT900. Fee 10 RWF. Balance 7,700 RWF. Transaction failed.';
      const outgoingInbox=new Date(Date.parse(stamp)+10_000).toISOString();
      const outgoingSmsc=new Date(Date.parse(stamp)+5_000).toISOString();
      for(const text of [outgoing,contradictory]){
        const debit=await consent(first,{...inputs[0],requestId:randomUUID(),sourceKey:hash(text),rawBody:text,capturedAt:outgoingInbox,inboxReceivedAt:text===outgoing?outgoingInbox:stamp,serviceCentreAt:text===outgoing?outgoingSmsc:stamp},'observations');
        assert.equal(debit.status,200,JSON.stringify(debit.body)); observations.push(debit.body.data);
      }
      let calls=0;
      const extraction=(reference,name='Example Person',phone='0788123456')=>({
        schema_version:MOMO_SCHEMA_VERSION,event_kind:'incoming_receipt',payment_outcome:'successful',
        transaction_id_raw:reference,original_transaction_id_raw:null,transaction_datetime_raw:null,
        principal_amount_raw:'1,250',currency_raw:'RWF',payer_name_raw:name,payer_identifier_raw:phone,
        payment_reference_raw:null,fee_amount_raw:'10',wallet_balance_after_raw:'9,000',
        evidence:{incoming_success:'You have received',principal:'You have received 1,250 RWF',transaction_id:'Reference: '+reference,
          transaction_datetime:null,payer:'from '+name+' '+phone,fee:'Fee 10 RWF',wallet_balance_after:'Balance 9,000 RWF'},issues:[],
      });
      const debitExtraction=(ref,amount,balance)=>({...extraction(ref,'Example Shop','0788123456'),event_kind:'outgoing',principal_amount_raw:amount,wallet_balance_after_raw:balance,
        evidence:{...extraction(ref).evidence,incoming_success:'You have sent',principal:'You have sent '+amount+' RWF',payer:'to Example Shop 0788123456',wallet_balance_after:'Balance '+balance+' RWF'}});
      const runResult=[extraction('ABC123'),extraction('ABC123'),extraction('XYZ777'),extraction('XYZ888','Other Person','0788123999'),debitExtraction('OUT400','400','8,600'),debitExtraction('OUT900','900','7,700')];
      const workerEnv=db=>{
        const env={DB:db,BURIMUNSI_PRODUCT_MODE:'standalone',SUPABASE_URL:storageOrigin,SUPABASE_SECRET_KEY:'sb_secret_fixture_only',
          DATA_KEY_ID:'synthetic-key',DATA_ENCRYPTION_KEY:Buffer.alloc(32,29).toString('base64'),COLLECT_FENCE_WORK:db.applicationWork,
          MOMO_AI_ENABLED:'true',MOMO_AI_MODEL:'synthetic-model',AI:{async run(){const output=runResult[Math.min(calls,5)];calls++;return {response:output};}}};
        const media=new SupabaseObjectBucket(env);media.transport=transport;
        media.protocol=new ProtectedStorageProtocol({transport,journal:media.journal});env.PRIVATE_MEDIA=media;
        return env;
      };
      const actual=[];
      for(const id of observations.map(r=>r.sourceId)){
        actual.push(await admitted(db=>new PostgresNativeAutoWorker({env:workerEnv(db),groupId:group}).process(id),'jobs'));
      }
      assert.deepEqual(actual.map(r=>r.relation),['accepted','duplicate','accepted','accepted','accepted','accepted'],JSON.stringify(actual));
      assert.equal(calls,6);
      console.log('PASS actual worker: accepted, duplicate (different installation), distinct equal-amount accepted, unmatched payer accepted for posting evaluation');
      const ledger=[];
      for(const id of [observations[0].sourceId,observations[2].sourceId,observations[3].sourceId]){
        ledger.push(await admitted(db=>new PostgresNativeSmsLedger({env:workerEnv(db),groupId:group}).process(id),'jobs'));
      }
      assert.deepEqual(ledger.map(r=>r.state),['posted','posted','unmatched'],JSON.stringify(ledger));
      const lines=await inspect(`SELECT l.amount_minor::int AS amount,l.member_id,t.provider_transaction_id,t.mode
        FROM app.ledger_entries l LEFT JOIN app.momo_financial_links f ON f.payment_id=l.payment_id
        LEFT JOIN app.momo_transactions t ON t.id=f.transaction_id
        WHERE l.collection_id=$1 ORDER BY t.provider_transaction_id`,[group]);
      assert.deepEqual(Array.from(lines),['ABC123','XYZ777'].map(ref=>({amount:1250,member_id:'synthetic-capture-member',provider_transaction_id:ref,mode:'historical'})));
      assert.equal(lines.reduce((n,r)=>n+r.amount,0),2500);
      const link=await inspect(`SELECT count(*)::int AS n FROM app.momo_transactions t JOIN app.momo_financial_links f ON f.transaction_id=t.id
        WHERE t.provider_transaction_id='XYZ888'`,[]);
      assert.equal(link[0].n,0);
      const staff=await issue(accounts[0],60_000);
      const home=await consent(staff,null,'/home?include=savings');
      const bundle=await consent(staff,null,'/session?include=home,savings');
      const prior=await consent(staff,null,'/session?include=home');
      const plain=await consent(staff,null,'/home');
      const facts={lifetimeContributionsRwf:2500,outgoingPaymentsRwf:400,latestWalletBalanceRwf:8600,lastWalletSmsAt:outgoingInbox,reconciliationStatus:'mismatch'};
      assert.equal(home.status,200,JSON.stringify(home)); assert.equal(bundle.status,200,JSON.stringify(bundle));
      assert.equal(prior.status,200,JSON.stringify(prior)); assert.equal(plain.status,200,JSON.stringify(plain));
      for(const res of [home,bundle,prior,plain])assert.equal(res.cache,'no-store');
      assert.deepEqual(home.body.data.savings,facts);
      assert.deepEqual(bundle.body.data.home.savings,facts);
      assert.equal(Object.hasOwn(prior.body.data.home,'savings'),false);
      assert.equal(Object.hasOwn(plain.body.data,'savings'),false);
      assert.equal((await consent(staff,null,'/home?include=savings&include=savings')).status,400);
      for(const refused of [{...staff,bearer:token()},{...staff,requestGroup:'unrelated-collection'}]){
        let denied;
        try{denied=await consent(refused,null,'/home?include=savings');}
        catch(error){denied={status:error.status};}
        assert.ok([401,403].includes(denied.status),JSON.stringify(denied));
        assert.equal(denied.body?.data,undefined);
      }
      console.log('PASS original Home/session selectors unchanged, new exact inclusion scoped and no-store');

      console.log('STAFF HOME SYNTHETIC',JSON.stringify(home));
      const stored = await inspect(`SELECT t.provider_transaction_id,t.event_kind,j.payment_outcome,j.original_sms_at,
        (SELECT count(*)::int FROM app.momo_financial_links f WHERE f.transaction_id=t.id) AS ledger_links
        FROM app.momo_transactions t JOIN private.burimunsi_auto_sms_jobs j ON j.transaction_id=t.id
        WHERE t.provider_transaction_id IN ('OUT400','OUT900') ORDER BY t.provider_transaction_id`,[]);
      console.log('SYNTHETIC OUTBOUND FACTS',JSON.stringify(stored));
      assert.ok(stored.length>=1);
      assert.ok(stored.every(row=>row.ledger_links===0&&new Date(row.original_sms_at).toISOString()===(row.provider_transaction_id==='OUT400'?outgoingInbox:stamp)));
      console.log('PASS actual automatic ledger: two equal values with distinct references posted exactly twice, no member match no credit');
    }
    assert.equal(await count(),0);
    console.log('PASS real phone-PIN HTTP observation consent for two unpaired installations of the same Admin; Staff denied; no gateway credential');
  }finally{await pool.end();}
}
