import {ApiError,json,readJson} from './core.js';
import {adminAccountSession} from './admin_accounts.js';
import {activePhoneOperator} from './admin_email_policy.js';
import {BURI_ADMIN_PRIVATE_HEADERS,requireBuriMunsiAdmin} from './admin_burimunsi_authority.js';
import {BURIMUNSI_PRODUCT_MODE} from '../burimunsi-standalone.js';
import {BuriError} from './burimunsi/errors.js';
import {exactKeys,requireRequestId} from './burimunsi/values.js';
import {PostgresBrowserOnboarding} from './burimunsi/postgres-browser-onboarding.js';
import {previewOnboardingFile} from './burimunsi/smart-onboarding-request.js';
import {readNativeJson} from './burimunsi/wire/native-http.mjs';
import {ContractViolation,validateNativeQuery,validateNativeRequest} from './burimunsi/wire/native-contract.mjs';
import {MAX_NATIVE_BATCH_REQUEST_BYTES,MAX_NATIVE_PREVIEW_REQUEST_BYTES,nativeRequestErrorStatus} from './burimunsi/wire/request-boundary.mjs';
import {defs} from './burimunsi/wire/burimunsi.generated.mjs';
import {validateSchema} from './burimunsi/wire/runtime.mjs';

const BASE='/api/admin/burimunsi/members/enrollment';
const MESSAGES={
  access_denied:'Your account cannot enroll members in this group.',
  invalid_name:'Enter the member name.',
  invalid_phone:'Enter the full Rwanda MoMo phone number.',
  attestation_required:'Confirm ownership, the savings terms and privacy consent.',
  invalid_request:'Check the member enrollment fields.',
  invalid_request_id:'Use the original enrollment request reference.',
  duplicate_phone:'This number does not identify one eligible member.',
  idempotency_conflict:'Use the original enrollment request and session.',
  invalid_import:'Check the selected rows and their row numbers.',
  invalid_query:'Check the suggestion filters.',
  invalid_cursor:'Refresh the suggestions.',
  cursor_expired:'Refresh the suggestions.',
  cursor_scope_changed:'The suggestions changed. Refresh them.',
  session_unavailable:'Your session has ended. Sign in again.',
  json_required:'Send the selected file or rows as JSON.',
  smart_import_invalid:'Choose the file again.',
  smart_import_consent_required:'Confirm sharing this document with OpenAI for text extraction.',
  smart_import_disclosure_required:'Review the disclosure for this file.',
  smart_import_disclosure_changed:'Review the current file disclosure again.',
  smart_import_ocr_unavailable:'Document text extraction is unavailable. Use CSV or enter the member manually.',
  smart_import_decoder_unavailable:'This document cannot be decoded here. Use CSV or enter the member manually.',
  smart_import_pending:'The original file preview is still unconfirmed.',
  smart_import_ocr_unconfirmed:'The original text extraction could not be confirmed.',
  smart_import_timeout:'The original file preview could not be confirmed in time.',
  smart_import_size_invalid:'The selected file exceeds its size limit.',
  smart_import_rows_limit:'Choose a file containing up to 500 member rows.',
  smart_import_type_invalid:'Choose a supported member list or document.',
  smart_import_type_mismatch:'The contents and file type do not match.',
  smart_import_type_unsupported:'This file type is unavailable.',
  smart_import_csv_invalid:'Choose a readable CSV member list.',
  smart_import_csv_headers_invalid:'Include a member name and mobile number column in the CSV.'
};

function matchingKey(request,body) {
  const id=requireRequestId(body.requestId);
  if(request.headers.get('Idempotency-Key')!==id)throw new ApiError(400,'invalid_request_id',MESSAGES.invalid_request_id);
  return id;
}

function checkedResponse(operation,result) {
  try{validateSchema(defs,operation+'.data',result);}
  catch{throw new ApiError(503,'enrollment_unavailable','The enrollment response could not be confirmed.');}
  return result;
}

export async function adminBuriMunsiMemberEnrollment(request,env) {
  const url=new URL(request.url);
  if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return null;
  if(env.BURIMUNSI_PRODUCT_MODE!==BURIMUNSI_PRODUCT_MODE)throw new ApiError(404,'not_found','This member action is unavailable.');
  const path=url.pathname.slice(BASE.length);
  const recovery=path.match(/^\/(import\/)?requests\/([^/]+)$/);
  const methods={'':['GET','POST'],'/suggestions':['GET'],'/import/preview':['POST'],'/import':['POST']};
  if(!recovery&&!Object.hasOwn(methods,path))throw new ApiError(404,'not_found','This member action does not exist.');
  if(path!=='/suggestions'&&url.search)throw new ApiError(400,'invalid_request','Use this member action without filters.');
  if(!(recovery?['GET']:methods[path]).includes(request.method))throw new ApiError(405,'method_not_allowed','Use the enrollment form or its request outcome.');
  const account=await adminAccountSession(request,env);
  await requireBuriMunsiAdmin({request,env,account,permissions:['users.manage','collections.manage'],
    adminMessage:MESSAGES.access_denied,unavailableCode:'enrollment_unavailable',unavailableMessage:'Member enrollment is unavailable.'});
  const proof=activePhoneOperator(account);
  if(proof?.operatorRole!=='admin'||proof.collectionId!==env.BURIMUNSI_COLLECTION_ID)throw new ApiError(403,'access_denied',MESSAGES.access_denied);
  try{
    const enrollment=new PostgresBrowserOnboarding({env,account,proof});
    let result;
    if(recovery){
      const id=requireRequestId(recovery[2]);
      result=recovery[1]?await enrollment.lookupImport(id):await enrollment.lookup(id);
    }else if(path==='/suggestions'){
      const query=validateNativeQuery('onboardingSuggestions',url.search.slice(1));
      result=checkedResponse('onboardingSuggestions',await enrollment.suggestions(query));
    }else if(path==='/import/preview'||path==='/import'){
      await enrollment.currentActor();
      const preview=path==='/import/preview',operation=preview?'onboardingPreview':'membersImport';
      const body=await readNativeJson(request,{maxBytes:preview?MAX_NATIVE_PREVIEW_REQUEST_BYTES:MAX_NATIVE_BATCH_REQUEST_BYTES});
      validateNativeRequest(operation,body);
      if(preview)result=checkedResponse(operation,await previewOnboardingFile(request,body,source=>enrollment.preview(source)));
      else {
        matchingKey(request,body);
        result=await enrollment.importMembers(body);
      }
    }else if(request.method==='GET')result=await enrollment.context();
    else {
      const body=exactKeys(await readJson(request,2048),['requestId','name','phone','verifiedOwnership','acceptedTerms','consentRecorded']);
      const requestId=matchingKey(request,body);
      result=await enrollment.apply({...body,requestId});
    }
    return json(result,200,BURI_ADMIN_PRIVATE_HEADERS);
  }catch(error){
    if(error instanceof ApiError)throw error;
    if(error instanceof ContractViolation)throw new ApiError(nativeRequestErrorStatus(error),'invalid_request','Check the file, selected rows or filters.');
    if(error instanceof BuriError&&Object.hasOwn(MESSAGES,error.code))throw new ApiError(error.status,error.code,MESSAGES[error.code]);
    if(error instanceof BuriError&&error.code.startsWith('smart_import_'))throw new ApiError(error.status,error.code,'The file preview could not be confirmed.');
    if(error?.code==='42501')throw new ApiError(403,'access_denied',MESSAGES.access_denied);
    throw new ApiError(503,'enrollment_unavailable','The enrollment outcome could not be confirmed.');
  }
}
