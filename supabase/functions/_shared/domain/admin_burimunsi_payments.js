import {adminAccountSession,validateAdminOrigin} from './admin_accounts.js';
import {managedAdminObservationsEnabled,readPaymentSmsEvidence} from './admin_burimunsi_observations.js';
import {BURI_ADMIN_PRIVATE_HEADERS} from './admin_burimunsi_authority.js';
import {paymentsContext,readScopedAdminHome} from './admin_burimunsi_payment_scope.js';
import {readAllocationMemberPage} from './admin_burimunsi_allocation_members.js';
import {ApiError,json,readJson} from './core.js';
import {lockCollectMutation} from '../postgres-mutation-lock.js';
import {BuriError,requireThat} from './burimunsi/errors.js';
import {assignPayment,readPayment,readPayments,
  readMemberPaymentStatement,readOptionalMemberPaymentBalance,MEMBER_STATEMENT_PAGE_SIZE,MEMBER_STATEMENT_MAX_ROWS} from './burimunsi/postgres-payments.js';
import {readPaymentAnalysis} from './burimunsi/postgres-payment-analysis.js';
import {parsePaymentAnalysisQuery} from './burimunsi/payment-analysis-shared.mjs';
import {canonicalJson,exactKeys,requireId,requireRequestId,sha256} from './burimunsi/values.js';

const base='/api/admin/burimunsi/';
const operation='burimunsi.allocate';
function query(url,allowed,{maxOffset=100000}={}) {
  const values={};
  for(const [key,value] of url.searchParams){
    requireThat(allowed.includes(key)&&!Object.hasOwn(values,key),'invalid_query');
    values[key]=value;
  }
  requireThat(values.q===undefined||values.q.length<=80,'invalid_query');
  for(const [key,fallback,max] of [['limit',25,100],['offset',0,maxOffset]]){
    if(!allowed.includes(key))continue;
    const raw=values[key];
    requireThat(raw===undefined||/^\d{1,16}$/.test(raw)&&Number.isSafeInteger(Number(raw))&&Number(raw)<=max&&(key!=='limit'||Number(raw)>0),'invalid_query');
    values[key]=raw===undefined?fallback:Number(raw);
  }
  requireThat(!values.status||['allocated','unallocated'].includes(values.status),'invalid_query');
  requireThat(!values.direction||['incoming','outgoing'].includes(values.direction),'invalid_query');
  if(values.memberId!==undefined)requireId(values.memberId);
  return values;
}

export async function readScopedAdminMemberPaymentDetail(env,account,{memberId,include,readProfile}) {
  const {db,groupId,authority,scoped}=paymentsContext(env,account);
  try {
    requireThat(account.permissions.includes('users.read')&&account.permissions.includes('collections.read'),'access_denied',403);
    return await db.withLockedReadSnapshot(async sql=>{
      await sql.unsafe("SET LOCAL statement_timeout='1250ms'");
      requireThat((await scoped(sql)).canReadStatement,'access_denied',403);
      // Lock and recheck both personal grants for the profile as well as the
      // existing Payments guard. Profile/financial data use this same snapshot.
      const [result]=await sql.unsafe(`SELECT (private.assert_actor('users.read',NULL,NULL,1::bigint,NULL::bigint)=$1
        AND private.assert_actor('collections.read',NULL,NULL,1::bigint,NULL::bigint)=$1) AS allowed`,[account.principal_id]);
      requireThat(result?.allowed===true,'access_denied',403);
      const profile=await readProfile(sql,account,memberId,groupId);
      const membership=profile.related.memberships[0];
      requireThat(profile.resource.id===memberId&&membership?.user_id===memberId&&membership.group_id===groupId,'member_statement_unavailable',404);
      const projection=include==='balance'
        ? {member_balance:await readOptionalMemberPaymentBalance(sql,groupId,memberId,membership.id)}
        : {member_statement:await readMemberPaymentStatement(sql,groupId,memberId,{offset:0})};
      if(projection.member_statement)requireThat(projection.member_statement.membershipId===membership.id,'member_statement_unavailable',404);
      await authority.assertOwned();
      return {...profile,...projection};
    });
  } catch(error) {
    if(error instanceof BuriError)throw new ApiError(error.status,error.code,'The requested member record is unavailable.');
    if(error?.code==='42501')throw new ApiError(403,'permission_required','The requested member record is unavailable.');
    throw error;
  }
}

export async function adminBuriMunsiPayments(request,env) {
  const url=new URL(request.url),path=url.pathname;
  if(path!==base+'home'&&path!==base+'payments'&&!path.startsWith(base+'payments/'))return null;
  if(env.BURIMUNSI_PRODUCT_MODE!=='standalone')throw new ApiError(404,'not_found','This workspace is unavailable.');
  validateAdminOrigin(request,env);
  const account=await adminAccountSession(request,env);
  const {db,groupId,proof,authority,scoped}=paymentsContext(env,account);
  const evidenceMatch=/^payments\/([A-Za-z0-9_-]+)\/sms-evidence$/.exec(path.slice(base.length));
  const relative=path.slice(base.length),match=/^payments\/([A-Za-z0-9_-]+)(\/allocate)?$/.exec(relative);
  const statusMatch=/^payments\/([A-Za-z0-9_-]+)\/allocation-receipt$/.exec(relative);
  try{
    let result;
    if(relative==='payments/analysis'){
      if(request.method!=='POST')throw new ApiError(404,'not_found','This Payments action does not exist.');
      query(url,[]);
      const input=await readJson(request,8192);
      result=await db.withLockedReadSnapshot(async sql=>{
        await sql.unsafe("SET LOCAL statement_timeout='1250ms'");
        const {canAnalyzeSms:showSms,canAllocate}=await scoped(sql);
        let criteria;
        try{criteria=parsePaymentAnalysisQuery(input,showSms);}
        catch(error){if(error instanceof TypeError)requireThat(false,'invalid_payment_analysis',400);throw error;}
        const page=await readPaymentAnalysis(sql,groupId,criteria,{showSms,canAllocate});
        await authority.assertOwned();
        return {...page,asOf:new Date().toISOString()};
      });
    }else if(request.method==='GET'&&relative==='home'){
      query(url,[]);
      result=await db.withLockedReadSnapshot(sql=>readScopedAdminHome(sql,{groupId,scoped}));
    }else if(request.method==='GET'&&relative==='payments'&&url.searchParams.has('statement')){
      const {statement,memberId,offset,revision}=query(url,['statement','memberId','offset','revision'],{maxOffset:MEMBER_STATEMENT_MAX_ROWS-1});
      requireThat(statement==='1'&&memberId&&offset%MEMBER_STATEMENT_PAGE_SIZE===0&&
        (revision===undefined?offset===0:/^[0-9a-f]{64}$/.test(revision)),'invalid_query');
      requireThat(account.permissions.includes('users.read')&&account.permissions.includes('collections.read'),'access_denied',403);
      result=await db.withLockedReadSnapshot(async sql=>{
        await sql.unsafe("SET LOCAL statement_timeout='1250ms'");
        requireThat((await scoped(sql)).canReadStatement,'access_denied',403);
        const page=await readMemberPaymentStatement(sql,groupId,memberId,{offset,revision});
        await authority.assertOwned();
        return page;
      });
    }else if(request.method==='GET'&&relative==='payments'){
      const filters=query(url,['status','direction','memberId','q','limit','offset'],{maxOffset:Number.MAX_SAFE_INTEGER});
      result=await db.withLockedReadSnapshot(async sql=>{
        const projection=await scoped(sql);
        return {...await readPayments(sql,groupId,{...filters,...projection}),canAllocate:projection.canAllocate,asOf:new Date().toISOString()};
      });
    }else if(request.method==='GET'&&relative==='payments/members'){
      const {q='',limit,after}=query(url,['q','limit','after']);
      if(after!==undefined)requireId(after);
      result=await db.withLockedReadSnapshot(async sql=>{
        requireThat((await scoped(sql)).canAllocate,'access_denied',403);
        const page=await readAllocationMemberPage(sql,groupId,{q,limit,after});
        await authority.assertOwned();
        return page;
      });
    }else if(evidenceMatch){
      if(request.method!=='GET'||!managedAdminObservationsEnabled(env))
        throw new ApiError(404,'not_found','This Payments view is unavailable.');
      query(url,[]);
      const paymentId=requireId(evidenceMatch[1]);
      result=await db.withLockedReadSnapshot(async sql=>{
        await sql.unsafe("SET LOCAL statement_timeout='1250ms'");
        requireThat((await scoped(sql)).canAnalyzeSms,'access_denied',403);
        const evidence=await readPaymentSmsEvidence(sql,groupId,paymentId);
        await authority.assertOwned();
        return {paymentId,groupId,evidence};
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
        const payment=await readPayment(sql,groupId,requireId(match[1]),{...projection,financialDate:true});
        requireThat(payment,'record_unavailable',404);
        return {...payment,canAllocate:projection.canAllocate&&!payment.evidenceDisputed};
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
    if(error instanceof BuriError&&error.code==='payment_analysis_changed')
      throw new ApiError(409,error.code,'Payments changed between pages. Refresh to return to the first page.');
    if(error instanceof BuriError&&error.code==='payment_evidence_conflict')
      throw new ApiError(409,error.code,'Conflicting receipt evidence holds this payment for review.');
    if(error instanceof BuriError&&error.code==='member_statement_scope_too_large')
      throw new ApiError(503,error.code,'This membership is too large for a complete statement.');
    if(error instanceof BuriError&&error.code==='member_statement_changed')
      throw new ApiError(409,error.code,'The statement changed. Refresh to review the current transactions.');
    if(error instanceof BuriError)throw new ApiError(error.status,error.code,'Check the payment or chosen member and try again.');
    if(error?.code==='42501')throw new ApiError(403,'permission_required','This Payments action is unavailable.');
    throw new ApiError(503,'payments_unavailable','The Payments result could not be confirmed.');
  }
}
