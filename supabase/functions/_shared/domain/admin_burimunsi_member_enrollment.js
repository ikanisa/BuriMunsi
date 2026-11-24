import {ApiError,json,readJson} from './core.js';
import {adminAccountSession} from './admin_accounts.js';
import {activePhoneOperator} from './admin_email_policy.js';
import {BURI_ADMIN_PRIVATE_HEADERS,requireBuriMunsiAdmin} from './admin_burimunsi_authority.js';
import {BURIMUNSI_PRODUCT_MODE} from '../burimunsi-standalone.js';
import {BuriError} from './burimunsi/errors.js';
import {exactKeys,requireRequestId} from './burimunsi/values.js';
import {PostgresBrowserEnrollment} from './burimunsi/postgres-browser-enrollment.js';

const BASE='/api/admin/burimunsi/members/enrollment';
const MESSAGES={
  access_denied:'Your account cannot enroll members in this group.',
  invalid_name:'Enter the member name.',
  invalid_phone:'Enter the full Rwanda MoMo phone number.',
  attestation_required:'Confirm ownership, the savings terms and privacy consent.',
  invalid_request:'Check the member enrollment fields.',
  invalid_request_id:'Use the original enrollment request reference.',
  duplicate_phone:'This number does not identify one eligible member.',
  idempotency_conflict:'Use the original enrollment request and session.'
};

export async function adminBuriMunsiMemberEnrollment(request,env) {
  const url=new URL(request.url);
  if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return null;
  if(env.BURIMUNSI_PRODUCT_MODE!==BURIMUNSI_PRODUCT_MODE)throw new ApiError(404,'not_found','This member action is unavailable.');
  const recovery=url.pathname.match(/^\/api\/admin\/burimunsi\/members\/enrollment\/requests\/([^/]+)$/);
  if(url.pathname!==BASE&&!recovery)throw new ApiError(404,'not_found','This member action does not exist.');
  if(url.search)throw new ApiError(400,'invalid_request','Use this member action without filters.');
  if(request.method!=='GET'&&(request.method!=='POST'||recovery))throw new ApiError(405,'method_not_allowed','Use the enrollment form or its request outcome.');
  const account=await adminAccountSession(request,env);
  await requireBuriMunsiAdmin({request,env,account,permissions:['users.manage','collections.manage'],
    adminMessage:MESSAGES.access_denied,unavailableCode:'enrollment_unavailable',unavailableMessage:'Member enrollment is unavailable.'});
  const proof=activePhoneOperator(account);
  if(proof?.operatorRole!=='admin'||proof.collectionId!==env.BURIMUNSI_COLLECTION_ID)throw new ApiError(403,'access_denied',MESSAGES.access_denied);
  try{
    const enrollment=new PostgresBrowserEnrollment({db:env.DB,account,proof});
    let result;
    if(recovery)result=await enrollment.lookup(requireRequestId(recovery[1]));
    else if(request.method==='GET')result=await enrollment.context();
    else {
      const body=exactKeys(await readJson(request,2048),['requestId','name','phone','verifiedOwnership','acceptedTerms','consentRecorded']);
      const requestId=requireRequestId(body.requestId);
      if(request.headers.get('Idempotency-Key')!==requestId)throw new ApiError(400,'invalid_request_id',MESSAGES.invalid_request_id);
      result=await enrollment.apply({...body,requestId});
    }
    return json(result,200,BURI_ADMIN_PRIVATE_HEADERS);
  }catch(error){
    if(error instanceof ApiError)throw error;
    if(error instanceof BuriError&&Object.hasOwn(MESSAGES,error.code))throw new ApiError(error.status,error.code,MESSAGES[error.code]);
    if(error?.code==='42501')throw new ApiError(403,'access_denied',MESSAGES.access_denied);
    throw new ApiError(503,'enrollment_unavailable','The enrollment outcome could not be confirmed.');
  }
}
