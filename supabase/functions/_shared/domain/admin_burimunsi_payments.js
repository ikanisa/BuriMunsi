import {adminAccountSession,validateAdminOrigin} from './admin_accounts.js';
import {BURI_ADMIN_PRIVATE_HEADERS} from './admin_burimunsi_authority.js';
import {activePhoneOperator} from './admin_email_policy.js';
import {ApiError,json,readJson} from './core.js';
import {lockCollectMutation} from '../postgres-mutation-lock.js';
import {BuriError,requireThat} from './burimunsi/errors.js';
import {PostgresNativeAuthority} from './burimunsi/postgres-authority.js';
import {assignPayment,readPayment,readPaymentAnalysisRows,readPayments,readPaymentsHome,setPaymentsScope} from './burimunsi/postgres-payments.js';
import {analyzeCanonicalPaymentRows,parsePaymentAnalysisQuery} from './burimunsi/payment-analysis-shared.mjs';
import {canonicalJson,exactKeys,requireId,requireRequestId,sha256} from './burimunsi/values.js';

const base='/api/admin/burimunsi/';
const operation='burimunsi.allocate';
const scopeSql=`SELECT a.id,a.role,'payments.allocate'=ANY(a.capabilities) AS can_allocate,
 (resolved.actor->'permissions' ? 'sms.read') AND ('sms.read'=ANY(a.capabilities)) AS can_read_sms
 FROM private.burimunsi_browser_pin_session($1,$2,$3) AS resolved(actor)
 JOIN private.burimunsi_accounts a ON a.id=$4::uuid AND a.collection_id=$1
 WHERE resolved.actor->>'collectionId'=a.collection_id AND resolved.actor->>'accountId'=a.id::text
   AND resolved.actor->>'principalId'=a.principal_user_id AND a.principal_user_id=$5
   AND resolved.actor->>'sessionId'=$6 AND resolved.actor->>'publicId'=$7 AND resolved.actor->>'adminId'=$8
   AND resolved.actor->>'operatorRole'=a.role AND a.role IN ('admin','staff') AND a.active AND NOT a.removed
   AND 'records.read'=ANY(a.capabilities) AND resolved.actor->'permissions' ? 'payments.read'
   AND private.assert_actor('payments.read',NULL,NULL,1::bigint,NULL::bigint)=a.principal_user_id
 FOR SHARE OF a`;

function query(url,allowed) {
  const values={};
  for(const [key,value] of url.searchParams){
    requireThat(allowed.includes(key)&&!Object.hasOwn(values,key),'invalid_query');
    values[key]=value;
  }
  requireThat(values.q===undefined||values.q.length<=80,'invalid_query');
  for(const [key,fallback,max] of [['limit',25,100],['offset',0,100000]]){
    if(!allowed.includes(key))continue;
    const raw=values[key];
    requireThat(raw===undefined||/^\d{1,6}$/.test(raw)&&Number(raw)<=max&&(key!=='limit'||Number(raw)>0),'invalid_query');
    values[key]=raw===undefined?fallback:Number(raw);
  }
  requireThat(!values.status||['allocated','unallocated'].includes(values.status),'invalid_query');
  requireThat(!values.direction||['incoming','outgoing'].includes(values.direction),'invalid_query');
  if(values.memberId!==undefined)requireId(values.memberId);
  return values;
}

export async function adminBuriMunsiPayments(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path!==base+'home'&&path!==base+'payments'&&!path.startsWith(base+'payments/'))return null;
  if(env.BURIMUNSI_PRODUCT_MODE!=='standalone')throw new ApiError(404,'not_found','This workspace is unavailable.');
  validateAdminOrigin(request,env);
  const account=await adminAccountSession(request,env),proof=activePhoneOperator(account);
  const groupId=env.BURIMUNSI_COLLECTION_ID;
  if(!proof||proof.collectionId!==groupId||!account.permissions.includes('payments.read'))
    throw new ApiError(403,'permission_required','Payments are unavailable for this account.');
  const db=env.DB,authority=new PostgresNativeAuthority({db,groupId});
  const scopeArgs=[groupId,account.token_hash,account.origin,proof.accountId,
    account.principal_id,account.auth_session_id,account.public_id,account.id];
  const scoped=async sql=>{
    await setPaymentsScope(sql,groupId);
    const rows=await sql.unsafe(scopeSql,scopeArgs);
    requireThat(rows.length===1,'access_denied',403);
    const actor=rows[0];
    return {showSms:actor.role==='admin'&&account.permissions.includes('sms.read'),
      canAnalyzeSms:actor.role==='admin'&&actor.can_read_sms===true&&account.permissions.includes('sms.read'),
      canAllocate:actor.can_allocate===true};
  };
  const relative=path.slice(base.length),match=/^payments\/([A-Za-z0-9_-]+)(\/allocate)?$/.exec(relative);
  const statusMatch=/^payments\/([A-Za-z0-9_-]+)\/allocation-receipt$/.exec(relative);
  try{
    let result;
    if(relative==='payments/analysis'){
      if(request.method!=='POST')throw new ApiError(404,'not_found','This Payments action does not exist.');
      query(url,[]);
      const input=await readJson(request,8192);
      const {rows,amounts,query:criteria,showSms,asOf}=await db.withLockedReadSnapshot(async sql=>{
        await sql.unsafe("SET LOCAL statement_timeout='1250ms'");
        const {canAnalyzeSms:showSms}=await scoped(sql);
        let criteria;
        try{criteria=parsePaymentAnalysisQuery(input,showSms);}
        catch(error){if(error instanceof TypeError)requireThat(false,'invalid_payment_analysis',400);throw error;}
        const snapshot=await readPaymentAnalysisRows(sql,groupId,{q:criteria.q,showSms});
        await authority.assertOwned();
        return {...snapshot,query:criteria,showSms,asOf:new Date().toISOString()};
      });
      // Work on authorized in-memory projections after SQL and its locks have
      // ended. Membership, ordering, count, totals and page use the same rows.
      const matched=analyzeCanonicalPaymentRows(rows,criteria.filters,criteria.sort,showSms);
      let incoming=0n,outgoing=0n;
      for(const row of matched){
        const exact=amounts.get(row.id);
        requireThat(typeof exact==='bigint','payment_totals_unavailable',503);
        if(row.direction==='incoming')incoming+=exact;
        else if(row.direction==='outgoing')outgoing+=exact;
        else requireThat(false,'payment_totals_unavailable',503);
      }
      const {offset,limit}=criteria;
      await authority.assertOwned();
      result={items:matched.slice(offset,offset+limit),totalCount:rows.length,matchingCount:matched.length,
        directionTotalsRwf:{incoming:incoming.toString(),outgoing:outgoing.toString()},missing:0,offset,limit,asOf};
    }else if(request.method==='GET'&&relative==='home'){
      query(url,[]);
      result=await db.withLockedReadSnapshot(async sql=>readPaymentsHome(sql,groupId,new Date().toISOString(),await scoped(sql)));
    }else if(request.method==='GET'&&relative==='payments'){
      const filters=query(url,['status','direction','memberId','q','limit','offset']);
      result=await db.withLockedReadSnapshot(async sql=>{
        const projection=await scoped(sql);
        return {...await readPayments(sql,groupId,{...filters,...projection}),canAllocate:projection.canAllocate,asOf:new Date().toISOString()};
      });
    }else if(request.method==='GET'&&relative==='payments/members'){
      const {q='',limit}=query(url,['q','limit']);
      result=await db.withLockedReadSnapshot(async sql=>{
        requireThat((await scoped(sql)).canAllocate,'access_denied',403);
        const items=await sql.unsafe(`SELECT u.id,u.full_name AS name
          FROM app.memberships m JOIN app.users u ON u.id=m.user_id
          WHERE m.collection_id=$1 AND m.active=1 AND u.access_status='active' AND u.member_type<>'operator'
            AND strpos(lower(u.full_name),lower($2))>0 ORDER BY u.full_name,u.id LIMIT $3`,[groupId,q,limit]);
        return {items};
      });
    }else if(request.method==='GET'&&statusMatch){
      query(url,[]);
      const paymentId=requireId(statusMatch[1]),requestId=requireRequestId(request.headers.get('Idempotency-Key'));
      result=await db.withLockedReadSnapshot(async sql=>{
        requireThat((await scoped(sql)).canAllocate,'access_denied',403);
        // Absence is not proof of rejection: an original write may still be in
        // flight. Historied receipts from other sessions are indistinguishable.
        const rows=await sql.unsafe(`SELECT r.response,p.member_id,p.version::text AS payment_version
          FROM private.burimunsi_command_receipts r
          LEFT JOIN burimunsi.payments p ON p.collection_id=r.collection_id AND p.id=$6
          WHERE r.collection_id=$1 AND r.actor_id=$2::uuid AND r.request_id=$3::uuid
            AND r.session_id=$4::uuid AND r.operation=$5 AND r.response->>'paymentId'=$6`,
          [groupId,proof.accountId,requestId,account.auth_session_id,operation,paymentId]);
        requireThat(rows.length<=1,'allocation_receipt_inconsistent',503);
        await authority.assertOwned();
        if(!rows.length)return {state:'unconfirmed',requestId};
        const {response,member_id,payment_version}=rows[0];
        requireThat(response&&response.paymentId===paymentId&&response.state==='allocated'&&
          typeof response.memberId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(response.memberId)&&
          response.memberId===member_id&&Number.isSafeInteger(response.version)&&response.version>=2&&
          String(response.version)===payment_version,'allocation_receipt_inconsistent',503);
        return {state:'committed',requestId,receipt:{paymentId,memberId:response.memberId,version:response.version}};
      });
    }else if(request.method==='GET'&&match&&!match[2]){
      query(url,[]);
      result=await db.withLockedReadSnapshot(async sql=>{
        const projection=await scoped(sql);
        const payment=await readPayment(sql,groupId,requireId(match[1]),projection);
        requireThat(payment,'record_unavailable',404);
        return {...payment,canAllocate:projection.canAllocate};
      });
    }else if(request.method==='POST'&&match?.[2]){
      query(url,[]);
      const paymentId=requireId(match[1]),requestId=requireRequestId(request.headers.get('Idempotency-Key'));
      const input=exactKeys(await readJson(request,2048),['memberId','expectedVersion']);
      const memberId=requireId(input.memberId),expectedVersion=input.expectedVersion;
      requireThat(Number.isSafeInteger(expectedVersion)&&expectedVersion>=1,'invalid_version');
      const fingerprint=await sha256(canonicalJson({operation,paymentId,memberId,expectedVersion}));
      await authority.assertOwned();
      result=await db.transaction(async sql=>{
        await lockCollectMutation(sql);
        await db.context(sql);
        requireThat((await scoped(sql)).canAllocate,'access_denied',403);
        const ids=[groupId,proof.accountId,requestId];
        const [prior]=await sql.unsafe(`SELECT session_id,operation,fingerprint,response FROM private.burimunsi_command_receipts
          WHERE collection_id=$1 AND actor_id=$2::uuid AND request_id=$3::uuid FOR UPDATE`,ids);
        if(prior){
          requireThat(prior.session_id===account.auth_session_id&&prior.operation===operation&&prior.fingerprint===fingerprint,'idempotency_conflict',409);
          await authority.assertOwned();
          return prior.response;
        }
        const response=await assignPayment(sql,{groupId,paymentId,memberId,expectedVersion});
        await sql.unsafe(`INSERT INTO private.burimunsi_command_receipts
          (collection_id,actor_id,request_id,session_id,operation,fingerprint,response,created_at)
          VALUES ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8)`,
          [...ids,account.auth_session_id,operation,fingerprint,response,Date.now()]);
        await authority.assertOwned();
        return response;
      });
    }else throw new ApiError(404,'not_found','This Payments action does not exist.');
    return json(result,200,BURI_ADMIN_PRIVATE_HEADERS);
  }catch(error){
    if(error instanceof ApiError)throw error;
    if(error instanceof BuriError&&error.code==='payment_analysis_scope_too_large')
      throw new ApiError(503,error.code,'This collection is too large for exact payment analysis.');
    if(error instanceof BuriError)throw new ApiError(error.status,error.code,'Check the payment or chosen member and try again.');
    if(error?.code==='42501')throw new ApiError(403,'permission_required','This Payments action is unavailable.');
    throw new ApiError(503,'payments_unavailable','The Payments result could not be confirmed.');
  }
}
