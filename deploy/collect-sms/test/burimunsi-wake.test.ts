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
