import {ApiError,json,readJson,uuid} from './core.js';
import {activePhoneOperator,adminEmailArguments} from './admin_email_policy.js';
import {BURI_ADMIN_PRIVATE_HEADERS as headers,requireBuriMunsiAdmin,rethrowWorkflowSessionFailure} from './admin_burimunsi_authority.js';
import {AdminScopeSetup} from './burimunsi/admin-scope-setup.js';
import {requireId} from './burimunsi/values.js';

const fail=(status,code,message)=>{throw new ApiError(status,code,message);};
function known(error,env){
 if(error instanceof ApiError)throw error;
 rethrowWorkflowSessionFailure(error,env);
 if(error?.code==='42501')fail(403,'burimunsi_scope_denied','The administrator or approved receiving installation changed.');
 if(error?.message==='gateway_handoff_unavailable')fail(503,'gateway_handoff_unavailable','Preserve the working phone and receipts. Replacement is not available.');
 if(['40001','23505'].includes(error?.code))fail(409,'burimunsi_scope_changed','The group, receiver, device or original request changed. Refresh before continuing.');
 if(error?.message==='burimunsi_setup_delivery_expired')fail(410,'burimunsi_setup_delivery_expired','This pairing code expired or was superseded. Refresh setup before continuing.');
 if(['22023','22P02'].includes(error?.code))fail(400,'invalid_setup','Check the selected setup fields.');
}
/** Existing MoMo tools and shared owner cookie/CSRF, not a second admin panel. */
export async function adminBuriMunsiSetup(request,env,account,actor,parts,url){
 await requireBuriMunsiAdmin({request,env,account,
  permissions:['admin_users.manage','receivers.manage','receivers.read'],
  adminMessage:'An administrator configures receiving phones.',
  unavailableCode:'burimunsi_setup_unavailable',unavailableMessage:'Receiving setup is unavailable.'});
 const service=new AdminScopeSetup({env,actorArgs:adminEmailArguments(account),actorId:actor.userId,sessionId:actor.sessionId});
 for(const key of url.searchParams.keys())if(key!=='collectionId'||url.searchParams.getAll(key).length!==1)fail(400,'invalid_request','Choose one collection.');
 const boundGroup=activePhoneOperator(account)?.collectionId;
 const selected=url.searchParams.get('collectionId')??boundGroup??null;
 if(selected!==null)requireId(selected);
 if(boundGroup && selected!==boundGroup)fail(409,'burimunsi_scope_changed','This group is outside your Admin account.');
 const recovery=parts.length>=3&&parts[1]==='requests'?uuid(parts[2]):null;
 if(parts.length!==1&&!(recovery&&(parts.length===3||parts.length===4&&['delivery','cancel'].includes(parts[3]))))
  fail(404,'not_found','This receiving setup action does not exist.');
 try{
  if(request.method==='GET'){
   if(parts.length===4)fail(405,'method_not_allowed','Use the protected delivery action.');
   return json(recovery?await service.lookup(selected??'',recovery):await service.directory(selected),200,headers);
  }
  if(request.method!=='POST')fail(405,'method_not_allowed','Use the setup view or its explicit action.');
  const body=await readJson(request,2048);
  if(boundGroup && body.collectionId!==boundGroup)fail(409,'burimunsi_scope_changed','This group is outside your Admin account.');
  if(parts.length===4){
   if(Object.keys(body).length!==1||typeof body.collectionId!=='string')fail(400,'invalid_request','Supply the original collection.');
   return json(parts[3]==='cancel'?await service.cancel(body.collectionId,recovery):await service.delivery(body.collectionId,recovery),200,headers);
  }
  if(parts.length!==1||url.search)fail(400,'invalid_request','Use the setup action without filters.');
  if(uuid(body.requestId)!==body.requestId||request.headers.get('Idempotency-Key')!==body.requestId)
   fail(400,'idempotency_required','Use the exact retained request identity.');
  return json(await service.apply(body),200,headers);
 }catch(error){known(error,env);
  fail(503,'burimunsi_setup_unconfirmed','Setup could not be confirmed. Check the original request before continuing.');
 }
}
