import {LEGACY_ADMIN_OWNER_EMAIL} from '../admin-security.js';
import {BURIMUNSI_PRODUCT_MODE} from '../burimunsi-standalone.js';
import {ApiError} from './core.js';
import {fenceFailure} from '../application-fence.js';
import {activePhoneOperator} from './admin_email_policy.js';

/** The database revalidates the active cookie, principal, role and grants in
 * the same transaction as each protected operation. */
export async function preliminaryCurrentOwner(env,account){
 if(env?.BURIMUNSI_PRODUCT_MODE===BURIMUNSI_PRODUCT_MODE){
  const proof=activePhoneOperator(account);
  return Boolean(proof?.operatorRole==='admin' && proof.collectionId===env.BURIMUNSI_COLLECTION_ID);
 }
 if(account?.role!=='owner')return false;
 if(env?.COLLECT_ADMIN_DYNAMIC_OWNER_AUTH_ENABLED!=='true')return account.email===LEGACY_ADMIN_OWNER_EMAIL;
 if(typeof account.id!=='string'||typeof account.principal_id!=='string'||typeof account.email!=='string')return false;
 try{
  const row=await env.DB.prepare('SELECT private.collect_owner_is(?,?,?) AS result')
   .bind(account.id,account.principal_id,account.email).first();
  return row?.result===true;
 }catch(error){
  if(['application_fenced','application_fence_unavailable'].includes(error?.code))throw error;
  if(['collect_fence_closed','collect_fence_unavailable'].includes(error?.message))throw fenceFailure(error);
  throw new ApiError(503,'owner_identity_unavailable','The current owner identity could not be confirmed. Try again later.');
 }
}
