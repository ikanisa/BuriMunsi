import {activePhoneOperator} from './admin_email_policy.js';
import {ApiError} from './core.js';
import {requireThat} from './burimunsi/errors.js';
import {PostgresNativeAuthority} from './burimunsi/postgres-authority.js';
import {readPaymentsHome,setPaymentsScope} from './burimunsi/postgres-payments.js';

const scopeSql=`SELECT a.id,a.role,'payments.allocate'=ANY(a.capabilities) AS can_allocate,
 (resolved.actor->'permissions' ? 'sms.read') AND ('sms.read'=ANY(a.capabilities)) AS can_read_sms,
 resolved.actor->'permissions' ?& ARRAY['users.read','collections.read'] AS can_read_statement
 FROM private.burimunsi_browser_pin_session($1,$2,$3) AS resolved(actor)
 JOIN private.burimunsi_accounts a ON a.id=$4::uuid AND a.collection_id=$1
 WHERE resolved.actor->>'collectionId'=a.collection_id AND resolved.actor->>'accountId'=a.id::text
   AND resolved.actor->>'principalId'=a.principal_user_id AND a.principal_user_id=$5
   AND resolved.actor->>'sessionId'=$6 AND resolved.actor->>'publicId'=$7 AND resolved.actor->>'adminId'=$8
   AND resolved.actor->>'operatorRole'=a.role AND a.role IN ('admin','staff') AND a.active AND NOT a.removed
   AND 'records.read'=ANY(a.capabilities) AND resolved.actor->'permissions' ? 'payments.read'
   AND private.assert_actor('payments.read',NULL,NULL,1::bigint,NULL::bigint)=a.principal_user_id`;
const overviewGrant=" AND private.assert_actor('overview.read',NULL,NULL,1::bigint,NULL::bigint)=a.principal_user_id";

export function paymentsContext(env,account) {
  const proof=activePhoneOperator(account);
  const groupId=env.BURIMUNSI_COLLECTION_ID;
  if(!proof||proof.collectionId!==groupId||!account.permissions.includes('payments.read'))
    throw new ApiError(403,'permission_required','Payments are unavailable for this account.');
  const db=env.DB,authority=new PostgresNativeAuthority({db,groupId});
  const scopeArgs=[groupId,account.token_hash,account.origin,proof.accountId,
    account.principal_id,account.auth_session_id,account.public_id,account.id];
  const scoped=async (sql,{requireOverview=false}={})=>{
    await setPaymentsScope(sql,groupId);
    const rows=await sql.unsafe(scopeSql+(requireOverview?overviewGrant:'')+' FOR SHARE OF a',scopeArgs);
    requireThat(rows.length===1,'access_denied',403);
    const actor=rows[0];
    return {showSms:actor.role==='admin'&&account.permissions.includes('sms.read'),
      canAnalyzeSms:actor.role==='admin'&&actor.can_read_sms===true&&account.permissions.includes('sms.read'),
      canReadStatement:actor.can_read_statement===true,
      canAllocate:actor.can_allocate===true};
  };
  return {db,groupId,proof,authority,scoped};
}

export async function readScopedAdminHome(sql,{groupId,scoped},{bootstrap=false}={}) {
  const projection=await scoped(sql,{requireOverview:bootstrap});
  if(bootstrap&&projection.showSms)requireThat(projection.canAnalyzeSms,'access_denied',403);
  const home=await readPaymentsHome(sql,groupId,new Date().toISOString(),projection,{adminTotals:true});
  return {...home,recentPayments:home.recentPayments.map(row=>({...row,canAllocate:projection.canAllocate}))};
}
