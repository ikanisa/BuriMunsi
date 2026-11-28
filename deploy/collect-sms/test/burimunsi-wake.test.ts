import assert from 'node:assert/strict';
import {app} from '../src/index.ts';
import type {Env} from '../src/types.ts';
import {sha256} from '../src/util.ts';

Deno.test('only the originally enrolled managed receipt sender can request a content-free private wake',async()=>{
 const device='synthetic-managed-sender',token='device_'+crypto.randomUUID(),digest=await sha256(token);
 const group=crypto.randomUUID(),application='app_'+crypto.randomUUID(),key='sb_publishable_synthetic_test_gateway';
 const topic='buri:gw:'+'a'.repeat(64),expiresAt=new Date(Date.now()+300000).toISOString();
 let calls=0;
 const database={prepare(sql:string){return {bind(...args:unknown[]){return {async first(column?:string){
  if(sql.includes('FROM applications WHERE token_hash'))return null;
  if(sql.includes('FROM devices WHERE token_hash'))return args[0]===digest?{installation_id:device,allowed_kinds:'["receipt"]'}:null;
  if(sql.includes('burimunsi_gateway_wake_channel')) {
   assert.equal(column,'channel');assert.deepEqual(args,[device,digest,group,application]);calls++;
   return {topic,expiresAt};
  }
  throw Error('Unexpected test query');
 }}}}}};
 const env={DB:database,ROOT_ADMIN_TOKEN:'r'.repeat(48),OTP_HMAC_KEY:'f'.repeat(48),ENVIRONMENT:'production',
  FCM_ENABLED:'false',DISPATCH_PAUSED:'false',BURIMUNSI_PRODUCT_MODE:'standalone',BURIMUNSI_PAYMENT_SMS_ENABLED:'true',
  BURIMUNSI_PAYMENT_SMS_COLLECTION_ID:group,OPENSMS_RECEIPT_APPLICATION_ID:application,
  SUPABASE_URL:'https://rrlduytparvsjfmegalh.supabase.co',SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:key})};
 const path='https://rrlduytparvsjfmegalh.supabase.co/v1/device/wake-channel';
 const request=(bearer:string,patch:Record<string,string>={},body='{}')=>app.fetch(new Request(path,{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body}),{...env,...patch} as unknown as Env);
 assert.equal((await request('invalid')).status,401);assert.equal((await request(env.ROOT_ADMIN_TOKEN)).status,403);
 assert.equal((await request(token,{DISPATCH_PAUSED:'true'})).status,404);
 assert.equal((await request(token,{SUPABASE_PUBLISHABLE_KEYS:'{"default":"sb_secret_wrong"}'})).status,404);
 assert.equal((await request(token,{BURIMUNSI_PRODUCT_MODE:'other'})).status,404);
 assert.equal((await request(token,{},'{"installation_id":"another-device"}')).status,400);
 const response=await request(token);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control')??'',/no-store/);
 const payload=await response.json();assert.deepEqual(Object.keys(payload).sort(),['expiresAt','publishableKey','serverTime','topic']);assert.equal(payload.topic,topic);
 assert.equal(payload.expiresAt,expiresAt);assert.equal(payload.publishableKey,key);assert.equal(new Date(payload.serverTime).toISOString(),payload.serverTime);
 assert.equal(calls,1);
});

Deno.test("wake unavailable does not prevent an authenticated pull, and an operational pause still fences work", async () => {
  const installation = "synthetic-receipt-gateway";
  const credential = "device_" + crypto.randomUUID();
  const credentialDigest = await sha256(credential);
  const receipt = {
    message_id: "synthetic-receipt",
    application_id: "synthetic-application",
    kind: "receipt",
    assignment_version: 2,
    owner_installation_id: installation,
  };
  let batches = 0;
  const db = {
    prepare(sql: string) {
      assert(!sql.includes("burimunsi_gateway_wake_channel"), "disabled wake must not request a capability");
      return {
        bind(...values: unknown[]) {
          return {
            sql,
            async first() {
              if (sql.includes("FROM applications WHERE token_hash")) return null;
              if (sql.includes("FROM devices WHERE token_hash")) {
                assert.equal(values[0], credentialDigest);
                return { installation_id: installation, allowed_kinds: '["receipt"]' };
              }
              assert(sql.includes("FROM devices WHERE installation_id="));
              assert.equal(values[0], installation);
              return { ready: true, sim_slot: null };
            },
          };
        },
      };
    },
    async batch(statements: {sql: string}[]) {
      batches++;
      if (statements[0]?.sql.startsWith("UPDATE devices")) return [];
      assert(statements[0]?.sql.includes("SELECT m.* FROM messages"));
      assert(statements[1]?.sql.includes("cancel_requested=1"));
      return [{ results: [receipt] }, { results: [] }];
    },
  };
  const root = "https://rrlduytparvsjfmegalh.supabase.co";
  const env = {
    DB: db, ROOT_ADMIN_TOKEN: "r".repeat(48), OTP_HMAC_KEY: "f".repeat(48),
    ENVIRONMENT: "production", DISPATCH_PAUSED: "false",
    BURIMUNSI_PRODUCT_MODE: "standalone", BURIMUNSI_PAYMENT_SMS_ENABLED: "true",
    BURIMUNSI_PAYMENT_SMS_COLLECTION_ID: "synthetic-collection",
    OPENSMS_RECEIPT_APPLICATION_ID: receipt.application_id, SUPABASE_URL: root,
    // No publishable key, so the wake channel must be unavailable.
  } as unknown as Env;
  const headers = { Authorization: "Bearer " + credential, "Content-Type": "application/json" };
  const wake = await app.fetch(new Request(root + "/v1/device/wake-channel", {
    method: "POST", headers, body: "{}",
  }), env);
  assert.equal(wake.status, 404);
  assert.equal((await wake.json()).error.code, "wake_unavailable");
  assert.equal(batches, 0);
  const pull = () => new Request(root + "/v1/device/jobs", { headers });
  const polled = await app.fetch(pull(), env);
  assert.equal(polled.status, 200);
  assert.deepEqual((await polled.json()).jobs, [receipt]);
  assert.equal(batches, 2);
  const paused = await app.fetch(pull(), { ...env, DISPATCH_PAUSED: "true" });
  assert.equal(paused.status, 200);
  const empty = await paused.json();
  assert.deepEqual(empty.jobs, []);
  assert.deepEqual(empty.cancellations, []);
  assert.equal(empty.dispatch_permit_until, empty.server_time);
  assert.equal(batches, 2, "a paused pull must not advance work");
});
