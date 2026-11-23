import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openApplicationWork} from '../../../../supabase/functions/_shared/application-fence.js';
import {drainBuriMunsiPaymentSms} from '../../../../supabase/functions/_shared/domain/burimunsi/payment-sms-delivery.mjs';
import {createOpenSmsReceiptTransport} from '../../../../supabase/functions/_shared/opensms-receipts.js';

// All HTTP stays inside the supplied fetch implementation. The PostgreSQL
// claim, consent recheck, body, message identity and carrier-part verifier are real.
export async function openFixturePayerWorker({client,collectionId:group,enabledAt,applicationId:app='app_10000000-0000-4000-8000-000000000003',
  lostReply=true,lostClaimReply=false,context=async tx=>tx.unsafe("SET LOCAL ROLE collect_runtime; SET LOCAL collect.edge_verified='true'; SET LOCAL test.work_kind='jobs'")}){
  const build='a'.repeat(64);let witness;
  const work=await openApplicationWork({sourceSha256:build,kind:'jobs',backend:{
    async register(admissionId,sourceSha256,kind){return (witness={contractVersion:1,admissionId,epoch:1,sourceSha256,kind,state:'active',mode:'open'});},
    async lease(){return {row:witness,assert:async()=>witness,release:async()=>{}};},
    async status(){return {...witness,found:true};},
    async close(id,epoch,sha,state,reason,externalDispatches,uncertainDispatches){return {...witness,state,reason,externalDispatches,uncertainDispatches};}
  }});
  const origin='https://rrlduytparvsjfmegalh.supabase.co';
  const env={BURIMUNSI_PAYMENT_SMS_ENABLED:'true',BURIMUNSI_PAYMENT_SMS_COLLECTION_ID:group,BURIMUNSI_PAYMENT_SMS_ENABLED_AT:enabledAt,
    COLLECT_RECEIPT_SMS_ENABLED:'true',COLLECT_RECEIPT_SMS_APPROVAL_SHA256:'c'.repeat(64),OPENSMS_RECEIPT_APPLICATION_ID:app,
    OPENSMS_RECEIPT_APPLICATION_TOKEN:'synthetic-only-'.repeat(3),OPENSMS_RECEIPT_BASE_URL:origin+'/functions/v1/collect-sms',
    SUPABASE_URL:origin,APP_ENVIRONMENT:'production',COLLECT_SMS_ENABLED:'true',COLLECT_SMS_DISPATCH_PAUSED:'false',COLLECT_SMS_CORE_SOURCE_SHA256:build,
    BUILD_SOURCE_ID:build,COLLECT_FENCE_WORK:work,DB:{applicationWork:work,
      context:async tx=>{
        await context(tx);
        await tx.unsafe("SELECT set_config('collect.fence_admission_id',$1,true)",[work.tuple()[0]]);
      },
      transaction:async fn=>{
        await client.query('BEGIN');
        let result, claimed=false;
        try{
          result=await fn({unsafe:async(sql,args)=>{
            if(sql.includes('burimunsi_claim_payment_sms_v2'))claimed=true;
            return (await client.query(sql,args)).rows;
          }});
          await client.query('COMMIT');
        }catch(error){await client.query('ROLLBACK');throw error;}
        if(claimed && lostClaimReply){lostClaimReply=false;throw Error('fixture lost the database claim commit acknowledgement');}
        return result;
      }}};
  const http=[];let submitted;
  const digest=text=>createHash('sha256').update(text).digest('hex');
  const makeTransport=config=>createOpenSmsReceiptTransport(config,{fetchImpl:async(url,options)=>{
    http.push(options.method);
    if(options.method==='POST'){
      assert.equal(submitted,undefined);submitted=JSON.parse(options.body);
      assert.equal(options.headers['Idempotency-Key'],submitted.message_id.substring(app.length+1));
      if(lostReply)throw Error('fixture gateway received the request and lost its reply');
      return Response.json({message_id:submitted.message_id,state:'accepted'},{status:202});
    }
    assert.equal(url,env.OPENSMS_RECEIPT_BASE_URL+'/v1/messages/'+encodeURIComponent(submitted.message_id));
    const timestamp=new Date().toISOString();
    const fields=[submitted.message_id,app,'receipt',submitted.to,submitted.text,'80',submitted.not_after,timestamp,''];
    const message={...submitted,application_id:app,available_at:timestamp,payload_digest:digest('collect-sms-payload-v1\n'+fields.map(v=>Buffer.byteLength(v)+':'+v).join('')),
      state:'delivered',campaign_id:null,content_redacted_at:null,updated_at:timestamp};
    return Response.json({message,attempts:[{message_id:message.message_id,attempt_id:'fixture-carrier',installation_id:'fixture-handset',parts_total:1}],
      parts:[{message_id:message.message_id,attempt_id:'fixture-carrier',part_index:0,sent_at:timestamp,delivered_at:timestamp,delivery_failed_at:null,delivery_unknown_at:null}]});
  }});
  async function carrierDelivered(){
    assert.ok(submitted,'the gateway has received the original message');
    await client.query(`INSERT INTO collect_sms.messages(message_id,application_id,kind,idempotency_key,state)
      VALUES($1,$2,'receipt',$3,'delivered') ON CONFLICT(message_id) DO UPDATE SET state=excluded.state`,
      [submitted.message_id,app,submitted.message_id.substring(app.length+1)]);
  }
  return {carrierDelivered,drain:()=>drainBuriMunsiPaymentSms(env,{makeTransport}),complete:()=>work.finish(),requests:http,
    get submitted(){return submitted;}};
}
