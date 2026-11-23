import {ApiError,json,readJson,requirePermission} from './core.js';
import {accountDatabase} from './admin_accounts.js';

const GROUP=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHANNEL=/^buri:ops:[a-f0-9]{64}$/;

export async function adminLiveReceivers(request,env,account,actor){
 if(request.method!=='POST')throw new ApiError(405,'method_not_allowed','Use POST to subscribe.');
 if(new URL(request.url).search)throw new ApiError(400,'invalid_request','Choose the collection in the request body.');
 requirePermission(actor,'sms.read');
 const input=await readJson(request,512);
 if(Object.keys(input).some(key=>key!=='collectionId')||
  (Object.hasOwn(input,'collectionId')&&(typeof input.collectionId!=='string'||!GROUP.test(input.collectionId)))){
  throw new ApiError(400,'invalid_request','Choose a valid collection.');
 }
 // This is the normal cookie/CSRF and session-bound database transaction.
 // Neither the caller's request nor the returned topic supplies a principal.
 const scoped=accountDatabase(env,account,'sms.read');
 let result;
 try{
  const [reply]=await scoped.DB.batch([scoped.DB.prepare('SELECT private.burimunsi_admin_live_issue(?::text) AS channel').bind(input.collectionId??null)]);
  result=reply?.results?.[0]?.channel;
 }catch(error){
  if(error?.code==='42501')throw new ApiError(403,'permission_required','This collection is unavailable.');
  if(error?.code==='22023')throw new ApiError(400,'collection_required','Choose a collection for live updates.');
  throw error;
 }
 const expiry=Date.parse(result?.expiresAt);
 if(!result||!CHANNEL.test(result.topic)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==result.expiresAt||
  expiry<=Date.now()||expiry>Date.now()+305000)throw new ApiError(503,'live_unavailable','Live updates are unavailable.');
 return json({topic:result.topic,expiresAt:result.expiresAt});
}
