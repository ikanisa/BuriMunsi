import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAutoProcessingResult} from '../scheduled-native-auto.js';
import {runEdgeJobCycle} from '../edge-job-cycle.js';

test('scheduled native results report only bounded processing metadata',()=>{
 assert.deepEqual(nativeAutoProcessingResult({status:'complete',processed:1,results:[
  {state:'completed',relation:'accepted',rawBody:'synthetic private content'}]}),
  {status:'complete',processed:1,results:[{state:'completed',relation:'accepted'}]});
 assert.equal(nativeAutoProcessingResult({status:'complete',processed:0,results:[]}).status,'complete');
 assert.equal(nativeAutoProcessingResult({status:'complete',processed:1,results:[{state:'security_message'}]}).status,'complete');
 assert.equal(nativeAutoProcessingResult({status:'complete',processed:1,results:[{state:'non_payment'}]}).status,'complete');
 assert.equal(nativeAutoProcessingResult({status:'complete',processed:1,results:[{state:'retry'}]}).status,'complete');
});
test('scheduled native results never report unknown, invalid or malformed work as complete',()=>{
 for(const result of [
  {status:'complete',processed:1,results:[{state:'failed'}]},
  {status:'complete',processed:1,results:[{state:'failed',reason:'provider_unavailable'}]},
  {status:'complete',processed:1,results:[{state:'completed',relation:'invalid'}]},
  {status:'complete',processed:2,results:[]},
  {status:'disabled',processed:0,results:[]},
 ]) assert.equal(nativeAutoProcessingResult(result).status,'unconfirmed');
});

test('the standalone signed cycle only parses and records Payments even with old payer flags', async () => {
 const source = 'a'.repeat(64), approval = 'b'.repeat(64), model = 'synthetic-model';
 const native = {contract:'collect.native-sms-automation.v1',source_sha256:source,approval_sha256:approval,model_id:model,batch_limit:1};
 const env = {
  BURIMUNSI_PRODUCT_MODE:'standalone', COLLECT_JOBS_MODE:'maintenance_only', MOMO_PROCESSING_PAUSED:'true',
  BURIMUNSI_NATIVE_AUTO_TRANSACTIONS_ENABLED:'true', BURIMUNSI_PAYMENT_SMS_ENABLED:'true',
  BURIMUNSI_NATIVE_FINANCIAL_QUEUE_ENABLED:'true', MOMO_AI_ENABLED:'true', MOMO_AI_MODEL:model,
  COLLECT_JOB_NATIVE_SMS_APPROVAL_SHA256:approval, BUILD_SOURCE_ID:source,
  OPENAI_API_KEY:'fixture', AI:{run(){ throw Error('Unscheduled provider call'); }},
 };
 const calls = [];
 const oldLane = name => async () => { calls.push(name); return {status:'unconfirmed'}; };
 const workers = {
  cleanup:async () => ({status:'complete',examined_limit:100,purged:0,provider_calls:0}),
  cleanupDiagnostics:async () => ({status:'complete',removed:0}),
  processNativeAuto:async (_env,{limit}) => {
   assert.equal(limit,1);calls.push('parse');
   return {status:'complete',processed:1,results:[{state:'completed',relation:'duplicate'}]};
  },
  processReceipts:oldLane('receipt'),processNotifications:oldLane('notification'),processNativeSmsLedger:oldLane('ledger'),
  processPaymentSms:oldLane('payer-message'),processCanonical:oldLane('secondary-parser'),processNativeFinancialWork:oldLane('financial'),
 };
 const payload = {native_sms_admission:native};
 const dispatch = {dispatchId:'fixture',processing:null,notifications:null};
 const result = await runEdgeJobCycle(env,payload,dispatch,{allowed:true,enabled:true,admission:native},workers);
 assert.deepEqual(calls,['parse']);
 assert.equal(result.status,200);
 assert.deepEqual(result.body.native_auto_processing,{status:'complete',processed:1,results:[{state:'completed',relation:'duplicate'}]});
 assert.deepEqual(result.body.processing,{status:'disabled',paused:true,processed:0,results:[]});
 for (const key of ['notifications','native_sms_ledger','payment_receipt_sms','canonical_processing','native_financial_work']) {
  assert.equal(Object.hasOwn(result.body,key),false);
 }
 const withAllocation = await runEdgeJobCycle({...env,BURIMUNSI_PAYMENT_SMS_ENABLED:'false',BURIMUNSI_ALLOCATION_SMS_ENABLED:'true'},
  payload,dispatch,{allowed:true,enabled:true,admission:native},{...workers,processAllocationSms:async()=>{
   calls.push('allocated');return {status:'complete',processed:1,outcome:'accepted',gateway_state:'delivered'};
  }});
 assert.equal(withAllocation.status,200);
 assert.deepEqual(withAllocation.body.allocation_receipt_sms,{status:'complete',processed:1,outcome:'accepted',gateway_state:'delivered'});
 assert.equal(Object.hasOwn(withAllocation.body,'payment_receipt_sms'),false);
 assert.deepEqual(calls,['parse','parse','allocated']);
 const denied = await runEdgeJobCycle(env,payload,{...dispatch,processing:{}},{allowed:true,enabled:true,admission:native},workers);
 assert.equal(denied.status,503);
 assert.deepEqual(calls,['parse','parse','allocated']);
});
