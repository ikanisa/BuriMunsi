import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createNativeRosterJpegDecoder,NATIVE_JPEG_IDENTITY,NATIVE_JPEG_PROTOCOL} from '../../../supabase/functions/_shared/roster_native_jpeg_decoder.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');

async function jpegPreview({post,admin,staff,source,group,withPreviewBindings,inspectPreview,check}) {
  const jpeg=await readFile(new URL('../../../supabase/functions/_shared/tests/fixtures/roster-image-progressive.jpg',import.meta.url));
  const fileBytes=jpeg.toString('base64'),model='synthetic-test-model',build=hash('synthetic JPEG build');
  const policy={schema_version:2,status:'owner_authorized',enabled:true,purpose:'collect_roster_static_jpeg_preview',
    provider:'openai',responses_endpoint:'https://api.openai.com/v1/responses',decoder_protocol:NATIVE_JPEG_PROTOCOL,
    decoder_identity:NATIVE_JPEG_IDENTITY,decoder_build_sha256:build,model,collection_id:group,source_sha256:source,
    authorization_evidence_sha256:hash('synthetic owner approval'),technical_checks_sha256:hash('synthetic technical checks'),
    authorized_at:new Date(Date.now()-60000).toISOString(),valid_until:null,request_consent_required:true,preview_only:true};
  const policyJson=JSON.stringify(policy);
  const bindings={BURIMUNSI_SMART_ONBOARDING_ADVANCED_ENABLED:'true',ROSTER_DECODER_PROTOCOL:NATIVE_JPEG_PROTOCOL,
    ROSTER_DECODER_URL:NATIVE_JPEG_IDENTITY,ROSTER_DECODER_BUILD_SHA256:build,
    ROSTER_DECODER:createNativeRosterJpegDecoder({protocol:NATIVE_JPEG_PROTOCOL,identity:NATIVE_JPEG_IDENTITY,approvedBuildSha256:build}),
    ROSTER_AI_APPROVAL_JSON:policyJson,ROSTER_AI_APPROVAL_SHA256:hash(policyJson),ROSTER_AI_MODEL:model,MOMO_AI_MODEL:model,
    OPENAI_API_KEY:'synthetic-test-key-in-process-only',DATA_KEY_ID:'fixture-preview',DATA_ENCRYPTION_KEY:Buffer.alloc(32,83).toString('base64')};
  const disclosure='burimunsi-ocr-disclosure-v1';
  const input={mimeType:'image/jpeg',fileBytes,externalOcrConsent:true,importFlowId:randomUUID(),ocrDisclosureVersion:disclosure};
  let calls=0;
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');calls++;
      const body=JSON.parse(options.body);
      assert.equal(body.input[0].content[0].image_url,'data:image/jpeg;base64,'+fileBytes);
      assert.equal(body.model,model);assert.equal(body.store,false);assert.deepEqual(body.tools,[]);
      return Response.json({object:'response',status:'completed',error:null,incomplete_details:null,tools:[],output:[
        {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',annotations:[],
          text:JSON.stringify({rows:[{momoName:'Synthetic OCR',momoNumber:'0780000091'}]})}]}]});
    };
    await withPreviewBindings(bindings,async()=>{
      check(await post('/import/preview',staff,input),403);
      check(await post('/import/preview',admin,{...input,externalOcrConsent:false}),403);
      const {importFlowId,...noFlow}=input;
      check(await post('/import/preview',admin,noFlow),403);
      assert.equal(calls,0);
      const first=check(await post('/import/preview',admin,input),200);
      assert.equal(first.sourceKind,'image');
      assert.deepEqual(first.rows.map(item=>[item.momoName,item.momoNumber]),[['Synthetic OCR','+250780000091']]);
      assert.deepEqual(check(await post('/import/preview',admin,{...input,importFlowId:randomUUID()}),200),first);
      assert.equal(calls,1);
      assert.deepEqual(await inspectPreview(hash(jpeg)),[{state:'completed',disclosure,kid:'fixture-preview',encrypted:true}]);
    });
  }finally{globalThis.fetch=original;}
}

// All sources, operators and membership rows are synthetic in the owned,
// socket-only phone browser fixture. Never contact a processor.
export async function verifyBrowserMemberOnboarding({call,admin,staff,otherAdmin,relogin,withoutGrant,inspect,group,source,withPreviewBindings,inspectPreview}) {
  const base='burimunsi/members/enrollment';
  const post=(path,view,body,key)=>call(base+path,{...view,body,key});
  const check=(response,expected)=>{
    assert.equal(response.status,expected,JSON.stringify(response.data.error));
    return response.data;
  };
  const csv={mimeType:'text/csv',fileBytes:Buffer.from('Name,Mobile number\nSynthetic File Member,0780000084\n').toString('base64'),
    externalOcrConsent:false};
  const jpeg={mimeType:'image/jpeg',fileBytes:'/9j/2Q==',externalOcrConsent:true,
    importFlowId:randomUUID(),ocrDisclosureVersion:'burimunsi-ocr-disclosure-v1'};
  const requestId=randomUUID();
  const row={row:1,name:'Synthetic File Member',phone:'+250780000084',verifiedOwnership:true,acceptedTerms:true,consentRecorded:true};
  const input={requestId,rows:[row,{...row,row:2},{...row,row:3,phone:'+250780000085',acceptedTerms:false},
    {...row,row:4,phone:''}]};
  const original=await inspect();
  check(await post('/import/preview',{},csv),401);
  check(await post('/import/preview',staff,csv),403);
  check(await post('/import/preview',{...admin,csrf:undefined},csv),403);
  check(await post('/import/preview',admin,{...csv,collectionId:'another-group'}),400);
  check(await post('/import/preview',admin,{...csv,fileBytes:'dHlwbw=Z'}),400);
  check(await call(base+'/suggestions?q=synthetic&q=other',admin),400);
  check(await call(base+'/suggestions?limit=1',staff),403);
  const suggestions=check(await call(base+'/suggestions?q=Synthetic&limit=2',admin),200);
  assert.ok(Array.isArray(suggestions.items));
  assert.match(suggestions.revision,/^[a-f0-9]{64}$/);
  const preview=check(await post('/import/preview',admin,csv),200);
  assert.equal(preview.sourceKind,'csv');
  assert.deepEqual(preview.rows.map(({momoName,momoNumber,status})=>[momoName,momoNumber,status]),
    [[row.name,row.phone,'ready']]);
  assert.equal(check(await post('/import/preview',admin,{...jpeg,externalOcrConsent:false}),403).error.code,
    'smart_import_consent_required');
  assert.equal(check(await post('/import/preview',admin,jpeg),503).error.code,'smart_import_ocr_unavailable');
  await jpegPreview({post,admin,staff,source,group,withPreviewBindings,inspectPreview,check});
  for(const permission of ['users.manage','collections.manage']){
    await withoutGrant(permission,async()=>{
      check(await post('/import/preview',admin,csv),403);
      check(await post('/import',admin,input,requestId),403);
    });
  }
  check(await post('/import',admin,input,randomUUID()),400);
  check(await post('/import',staff,input,requestId),403);
  const lookup=(view,id=requestId)=>call(base+'/import/requests/'+id,view);
  assert.deepEqual(check(await lookup(admin),200),{requestId,outcome:'not_found'});
  assert.deepEqual(await inspect(),original);

  const save=()=>post('/import',admin,input,requestId);
  const [first,second]=await Promise.all([save(),save()]);
  const batch=check(first,200);
  assert.deepEqual(check(second,200),batch);
  assert.equal(batch.created,1);
  assert.deepEqual(batch.results.map(item=>item.status),['created','duplicate_in_batch','needs_verification','invalid']);
  assert.ok(batch.results[0].memberId);
  assert.deepEqual(check(await lookup(admin),200),batch);
  assert.deepEqual(check(await lookup(otherAdmin),200),{requestId,outcome:'not_found'});
  check(await lookup(staff),403);
  const changed={...input,rows:[{...row,name:'Updated request'}]};
  assert.equal(check(await post('/import',admin,changed,requestId),409).error.code,'idempotency_conflict');
  const anotherSession=await relogin();
  assert.equal(check(await lookup(anotherSession),409).error.code,'idempotency_conflict');
  const after=await inspect();
  assert.equal(after.members,original.members+1);
  assert.equal(after.attestations,original.attestations+1);
  assert.equal(after.financial,original.financial);
  assert.equal(after.rematches,original.rematches);
  return {csvPreview:true,scopedSuggestions:true,trueRowAttestations:true,batchReplay:true,
    browserSessionIsolation:true,staffDenied:true,disabledDocumentProvider:true,encryptedJpegPreview:true,
    originalPreviewRecovered:true,mockedProviderCalls:1,externalDispatches:0};
}
