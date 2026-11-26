// W01: local proxy + exact Edge handler + embedded SQL, fixture sessions only.
// This does not substitute for concurrent native PostgreSQL or hosted UAT.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createAdminWorker} from '../../../deploy/platform-admin/src/index.js';
import {BURIMUNSI_ADMIN_COOKIE} from '../../../deploy/platform-admin/src/admin-session-realm.js';
import {adminBuriMunsiPayments} from '../../../supabase/functions/_shared/domain/admin_burimunsi_payments.js';

const {vars} = JSON.parse(await readFile(new URL('../../../deploy/platform-admin/wrangler.burimunsi.jsonc', import.meta.url)));
const origin = vars.ADMIN_ORIGIN;
const group = 'w01-fixture', payment = 'fixture-payment', member = 'fixture-member';
const path = '/api/admin/burimunsi/payments/' + payment + '/allocation-receipt';
const hash = value => createHash('sha256').update(value).digest('hex');

test('the Admin Worker preserves the original allocation request through the actual readback handler and database', async t => {
  const engine = await PGlite.create();
  t.after(() => engine.close());
  await engine.exec(`
    CREATE SCHEMA private;
    CREATE SCHEMA burimunsi;
    CREATE TABLE private.test_sessions (token_hash text PRIMARY KEY, actor jsonb NOT NULL);
    CREATE FUNCTION private.burimunsi_browser_pin_session(text,text,text)
      RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT actor FROM private.test_sessions
      WHERE token_hash=$2 AND actor->>'collectionId'=$1 $$;
    CREATE FUNCTION private.assert_actor(text,text,text,bigint,bigint) RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT 'fixture-principal'::text $$;
    CREATE TABLE private.burimunsi_accounts(id uuid PRIMARY KEY, collection_id text,
      principal_user_id text, role text, active boolean, removed boolean, capabilities text[]);
    CREATE TABLE private.burimunsi_command_receipts(collection_id text NOT NULL,actor_id uuid NOT NULL,
      request_id uuid NOT NULL,session_id uuid NOT NULL, operation text NOT NULL,response jsonb NOT NULL,
      PRIMARY KEY(collection_id,actor_id,request_id));
    CREATE TABLE burimunsi.payments(collection_id text, id text,member_id text,version bigint,
      PRIMARY KEY(collection_id,id));`);
  const account = randomUUID(), requestId = randomUUID(), firstSession = randomUUID();
  const browserToken = 'a'.repeat(64), otherBrowserToken = 'b'.repeat(64);
  const now = Math.floor(Date.now()/1000);
  for (const [token,session] of [[browserToken,firstSession],[otherBrowserToken,randomUUID()]]) {
    const actor = {collectionId:group, accountId:account, principalId:'fixture-principal', adminId:'fixture-admin',
      sessionId:session, publicId:session, proofId:session, authVersion:1, accountVersion:1, credentialVersion:1,
      operatorRole:'admin', storageRole:'owner', phone:'+250780000001', name:'Fixture', permissions:['payments.read'],
      expiresAt:now+600, verifiedAt:now-1};
    await engine.query('INSERT INTO private.test_sessions VALUES ($1,$2::jsonb)', [hash(token),JSON.stringify(actor)]);
  }
  await engine.query("INSERT INTO private.burimunsi_accounts VALUES ($1,$2,'fixture-principal','admin',true,false,ARRAY['payments.allocate','records.read'])",[account,group]);
  await engine.query('INSERT INTO burimunsi.payments VALUES ($1,$2,NULL,1)',[group,payment]);
  const forwarded=[];
  let proxiedWrites=0;
  const db = {
    applicationWork:{assert:async()=>{}}, setBrowserPasscodeAccount(){}, context(){}, readContext(){},
    transaction(){proxiedWrites++;throw new Error('Receipt GET must never try an allocation');},
    prepare(sql){return {bind:(...params)=>({first:async()=>{
      let position=0;
      return (await engine.query(sql.replace(/\?/g,()=>'$'+ ++position),params)).rows[0];
    }})};},
    withLockedReadSnapshot:fn=>engine.transaction(tx=>fn({unsafe:async(sql,args)=>
      (await tx.query(sql,args)).rows})),
  };
  const worker=createAdminWorker({fetchImpl:async request=>{
    forwarded.push({method:request.method,key:request.headers.get('Idempotency-Key')});
    assert.equal(new URL(request.url).pathname,'/functions/v1/admin-api'+path);
    assert.equal(request.headers.get('Origin'),origin);
    try {
      return await adminBuriMunsiPayments(new Request(origin+path,request),{
        DB:db, BURIMUNSI_PRODUCT_MODE:'standalone', BURIMUNSI_COLLECTION_ID:group, ADMIN_ORIGINS:origin,
      });
    } catch (error) {
      return Response.json({error:{code:error.code}}, {status:error.status??500});
    }
  }});
  const env={...vars,ASSETS:{fetch:()=>assert.fail('Never dispatch a static asset')}};
  const read=async(token=browserToken,key=requestId)=>{
    const response=await worker.fetch(new Request(origin+path,{headers:{
      'Cookie':BURIMUNSI_ADMIN_COOKIE+'='+token,'Idempotency-Key':key,
    }}),env);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.equal(response.headers.get('Set-Cookie'),null);
    return {status:response.status,body:await response.json()};
  };
  assert.deepEqual(await read(),{status:200,body:{state:'unconfirmed',requestId}});
  // Replicate only the authoritative committed state from a lost-ack scenario.
  // The receiver never POSTs: true writer/transaction concurrency is separate.
  await engine.transaction(async tx=>{
    await tx.query('UPDATE burimunsi.payments SET member_id=$1,version=2 WHERE collection_id=$2 AND id=$3',[member,group,payment]);
    await tx.query("INSERT INTO private.burimunsi_command_receipts VALUES ($1,$2,$3,$4,'burimunsi.allocate',$5::jsonb)",
      [group,account,requestId,firstSession,JSON.stringify({paymentId:payment, memberId:member, version:2, state:'allocated'})]);
  });
  assert.deepEqual(await read(),{status:200,body:{state:'committed',requestId,
    receipt:{paymentId:payment,memberId:member,version:2}}});
  assert.deepEqual(await read(otherBrowserToken),{status:200,body:{state:'unconfirmed',requestId}});
  const unrelated=randomUUID();
  assert.deepEqual(await read(browserToken,unrelated),{status:200,body:{state:'unconfirmed',requestId:unrelated}});
  // A later change to the payment is not proof that the historical receipt
  // still describes its current allocation. Keep it unresolved and read-only.
  await engine.query('UPDATE burimunsi.payments SET version=3 WHERE collection_id=$1 AND id=$2',[group,payment]);
  assert.deepEqual(await read(),{status:503,body:{error:{code:'allocation_receipt_inconsistent'}}});
  assert.equal(proxiedWrites,0);
  assert.deepEqual(forwarded,[requestId,requestId,requestId,unrelated,requestId].map(key=>({method:'GET',key})));
  assert.equal((await engine.query('SELECT count(*)::int n FROM private.burimunsi_command_receipts')).rows[0].n,1);
});
