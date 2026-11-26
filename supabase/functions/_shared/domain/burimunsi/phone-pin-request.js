import {assertWorkOwner} from '../../application-fence.js';
import {BuriError,requireThat,requirePort} from './errors.js';
import {normalizePhone,requirePin,requireId,requireRequestId,sha256,exactKeys} from './values.js';
import {PinHasher,newBearer,PIN_ITERATIONS} from './pin.js';
import {lockCollectMutation} from '../../postgres-mutation-lock.js';
import {BURIMUNSI_PRODUCT_MODE} from '../../burimunsi-standalone.js';
import {requireActiveNativeRequest} from './wire/request-boundary.mjs';
import {validateNativeRequest,requestBinding,bindNativeResponse,CONTRACT_VERSION} from './wire/native-contract.mjs';
import {isPhonePinRecordRead,nativeRequestUrl,readNativeJson,requireNativeHttpsOrigin} from './wire/native-http.mjs';
import {PIN_READ_ACTOR_SQL,PIN_CLOCK_SKEW_MS} from './postgres-session-row.js';
import {pgInteger} from './postgres-values.js';

// Proof is scoped to the admitted request-owned database, never an environment
// flag, actor object, stored hash or client-selected collection. Raw credentials
// remain in this closure and are passed only as parameterized SQL arguments.
const proofs=new WeakMap(),active=new WeakSet();
const recordReadPath=/^\/v1\/burimunsi\/(?:session|home|payments(?:\/[A-Za-z0-9_-]+(?:\/history)?)?|members(?:\/[A-Za-z0-9_-]+)?|ledger|staff|audit)$/;
const responseBindingHeaders=['X-BuriMunsi-Request','X-BuriMunsi-Generation','X-BuriMunsi-Contract','X-BuriMunsi-Payment-Reference-Version'];

class ReadSnapshotRefusal extends Error {
  constructor(response){super('read_snapshot_declined');this.response=response;}
}

export const PIN_CONTEXT_SQL='SELECT * FROM private.burimunsi_pin_session_context($1,$2::uuid,$3,$4)';
export const PIN_SET_CONTEXT_SQL='SELECT private.burimunsi_set_pin_context($1,$2::uuid,$3,$4) AS result';
export const PIN_RENEW_SQL='SELECT * FROM private.burimunsi_pin_renew_session($1,$2::uuid,$3,$4,$5,$6)';
export const PIN_LOGOUT_SQL='SELECT private.burimunsi_pin_logout_barrier($1,$2::uuid,$3,$4,$5,$6) AS result';
export const RETIREMENT_OUTCOME_SQL='SELECT private.burimunsi_gateway_retirement_outcome($1,$2::uuid,$3,$4,$5::uuid,$6) AS result';
export {PIN_CLOCK_SKEW_MS};
export function hasPhonePinContext(db){return proofs.has(db);}

function activeReadSnapshot(db) {
  const proof=proofs.get(db),snapshot=proof?.snapshot;
  if(!snapshot)return null;
  const {request,work}=snapshot,[token,installation,device,profile]=proof.values;
  requireThat(db.applicationWork===work,'request_not_admitted',503);
  requireActiveNativeRequest(request);
  requireThat(request.headers.get('Authorization')==='Bearer '+token&&request.headers.get('X-BuriMunsi-Installation')===installation&&
    request.headers.get('X-BuriMunsi-Device')===device&&request.headers.get('X-BuriMunsi-Profile')===profile&&
    request.headers.get('X-BuriMunsi-Group')===proof.groupId&&request.headers.get('X-BuriMunsi-Auth')==='phone_pin'&&
    !request.headers.has('X-BuriMunsi-Collect-Session'),'session_unavailable',401);
  requireThat(responseBindingHeaders.every((name,index)=>request.headers.get(name)===snapshot.binding[index]),'request_not_admitted',503);
  return snapshot;
}

// These are identifiers for the transaction's actor reload, not an actor that
// can authorize data by itself. Bind them to the original request and lease.
export function phonePinReadSelector(db,request) {
  const snapshot=activeReadSnapshot(db);if(!snapshot)return null;
  requireThat(snapshot.request===request,'request_not_admitted',503);
  snapshot.selected=true;
  return snapshot.identity;
}

export function claimPhonePinReadSnapshot(db,groupId) {
  const snapshot=activeReadSnapshot(db);if(!snapshot)return null;
  requireThat(!snapshot.claimed&&snapshot.identity.groupId===groupId,'request_not_admitted',503);
  snapshot.claimed=true;
  return snapshot.sql;
}

// Consume only the row from the exact proof and SQL snapshot already claimed
// by this records request. All clocks, directory proof and permissions are still
// checked by the session reader before it returns an actor.
export function takePhonePinReadActor(db,sql,groupId,sessionId,now) {
  const snapshot=activeReadSnapshot(db);
  if(!snapshot?.actorEvidence)return undefined;
  const {identity,actorEvidence}=snapshot;
  requireThat(snapshot.selected&&snapshot.claimed&&snapshot.sql===sql&&db.ownsNativeRead(sql)&&
    identity.groupId===groupId&&identity.sessionId===sessionId,'request_not_admitted',503);
  snapshot.actorEvidence=undefined;
  const {row,createdAt,dbCheckedAt,startedAt}=actorEvidence;
  if(row===null)return null;
  requireThat(row.collection_id===groupId&&row.session_id===sessionId&&row.id===identity.id&&
    row.principal_user_id===snapshot.principalUserId&&row.installation_id===identity.installationId&&
    row.installation_profile===proofs.get(db).values[3],'session_unavailable',401);
  const expiresAt=integer(row.expires_at);
  if(expiresAt<=now||createdAt>now+PIN_CLOCK_SKEW_MS)return null;
  // The elapsed time starts before the SQL was sent. If database expiry could
  // have elapsed in transit, run the original database check on this snapshot.
  if(expiresAt-dbCheckedAt<=Math.ceil(performance.now()-startedAt))return undefined;
  return row;
}

export function ownsPhonePinReadSnapshot(db,sql) {
  const snapshot=activeReadSnapshot(db);
  return snapshot?.sql===sql;
}

export async function applyPhonePinContext(db,sql,groupId){
  const proof=proofs.get(db);if(!proof)return false;
  requireThat(proof.groupId===groupId,'access_denied',403);
  if(ownsPhonePinReadSnapshot(db,sql))return true;
  let rows;
  try{rows=await sql.unsafe(PIN_SET_CONTEXT_SQL,proof.values);}
  catch(error){if(error?.code==='42501')throw new BuriError('session_unavailable',401);throw error;}
  requireThat(rows.length===1&&rows[0].result?.collection_id===groupId,'session_unavailable',401);
  return true;
}
const integer=v=>pgInteger(v,{minimum:0,code:'session_unavailable'});
function current(row,installation,profile,now){
  requireThat(row&&row.installation_id===installation&&row.profile===profile,'session_unavailable',401);
  requireId(row.collection_id);requireId(row.principal_user_id);requireRequestId(row.account_id);requireRequestId(row.native_session_id);
  requireThat(Number.isSafeInteger(now)&&now>=0&&integer(row.created_at)-now<=PIN_CLOCK_SKEW_MS&&integer(row.expires_at)>now&&
    ['admin','staff'].includes(row.role)&&Array.isArray(row.capabilities),'session_unavailable',401);
  return Object.freeze({verified:true,authMethod:'phone_pin',groupId:row.collection_id,principalUserId:row.principal_user_id,
    principalSessionId:row.native_session_id,nativeAccountId:row.account_id,installationId:installation,installationProfile:profile});
}
function headers(){return {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff','X-BuriMunsi-Contract':CONTRACT_VERSION};}
function requirePinTransition(request,url,{includeHome=false}={}){
  requireRequestId(request.headers.get('X-BuriMunsi-Request'));
  const generation=request.headers.get('X-BuriMunsi-Generation');
  requireThat(/^(0|[1-9][0-9]{0,15})$/.test(generation??'')&&Number.isSafeInteger(Number(generation)),'invalid_generation',400);
  requireThat(request.headers.get('X-BuriMunsi-Contract')===CONTRACT_VERSION,'contract_version',400);
  requireThat(url.search===''||includeHome,'invalid_query',400);
}

/** Bounded native phone/PIN authentication. No Auth identity, browser session
 * or MFA proof is created. SQL revalidates approved principals and all opaque
 * proof components.
 */
export function createPhonePinRequestGate({origin,secrets,networkBucket,clock=()=>Date.now(),sessionTtlMs=1800000}){
  requireThat(typeof networkBucket==='function'&&typeof clock==='function'&&Number.isSafeInteger(sessionTtlMs)&&
    sessionTtlMs>=60000&&sessionTtlMs<=28800000,'authentication_unconfigured',503);
  requireNativeHttpsOrigin(origin);
  // Managed email bootstrap does not invoke PIN authentication. Validate the
  // PIN secret only when this explicit native protocol is actually selected.
  let hasher;
  const pinHasher=()=>hasher??=new PinHasher({pepper:secrets.pinPepper,pepperId:secrets.pinPepperId});
  // An unknown identity performs the same configured derivation after durable
  // admission; this constant record is never an account or usable credential.
  const dummy={algorithm:'pbkdf2-sha256+hmac-v1',pepperId:secrets.pinPepperId,iterations:PIN_ITERATIONS,
    salt:'00000000000000000000000000000000',hash:'0000000000000000000000000000000000000000000000000000000000000000'};
  return async function withPhonePinRequest({request,env},operation){
    requireActiveNativeRequest(request);
    const url=nativeRequestUrl(request,origin),path=url.pathname,method=request.method;
    const login=method==='POST'&&path==='/v1/burimunsi/session/login';
    const logout=method==='POST'&&path==='/v1/burimunsi/session/logout';
    const retirement=method==='GET'&&/^\/v1\/burimunsi\/gateway\/replacements\/([a-f0-9-]{36})\/outcome$/.exec(path);
    const readSession=method==='GET'&&path==='/v1/burimunsi/session';
    const includeHome=(readSession||login)&&url.search==='?include=home'||
      readSession&&env.BURIMUNSI_PRODUCT_MODE===BURIMUNSI_PRODUCT_MODE&&url.search==='?include=home_savings';
    const renewing=readSession||(method==='POST'&&path==='/v1/burimunsi/session/passcode');
    const db=env?.DB,work=db?.applicationWork;requirePort(db,['transaction','context','readContext','setClaims']);requirePort(work,['assert']);
    const supportsReadSnapshot=typeof db.withNativeReadSnapshot==='function';
    const combinedRead=method==='GET'&&(supportsReadSnapshot?recordReadPath.test(path):
      env.BURIMUNSI_PRODUCT_MODE===BURIMUNSI_PRODUCT_MODE&&(path==='/v1/burimunsi/payments'||readSession&&includeHome));
    requireThat(!active.has(db),'native_context_busy',503);
    requireThat(request.headers.get('X-BuriMunsi-Auth')==='phone_pin'&&!request.headers.has('X-BuriMunsi-Collect-Session'),'invalid_credentials',401);
    const installation=requireRequestId(request.headers.get('X-BuriMunsi-Installation')),
      profile=request.headers.get('X-BuriMunsi-Profile'),device=request.headers.get('X-BuriMunsi-Device');
    requireThat(['staff','internal_receiver'].includes(profile)&&/^[a-f0-9]{64}$/.test(device??''),'invalid_credentials',401);
    if(login)requireThat(!request.headers.has('X-BuriMunsi-Group')&&!request.headers.has('authorization'),'invalid_credentials',401);
    if(login||logout||retirement||renewing)requirePinTransition(request,url,{includeHome});
    const owned=async(durable=false)=>{requireActiveNativeRequest(request);requireThat(db.applicationWork===work,'request_not_admitted',503);
      if(durable)await work.assert();else await assertWorkOwner(work);
      requireThat(db.applicationWork===work,'request_not_admitted',503);requireActiveNativeRequest(request);};
    const transaction=async(write,fn)=>db.transaction(async sql=>{
      await owned();if(write){
        await db.context(sql);
        // GET /session writes only through the database's guarded lease renewal.
        // Login, logout and passcode changes keep their exclusive mutation lock.
        if(!readSession)await lockCollectMutation(sql);
      }
      else{await sql.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');await db.readContext(sql,{isolation:'repeatable read'});}
      const result=await fn(sql);await owned(true);return result;
    });
    active.add(db);const local={...env};delete local.AUTH_ACTOR;delete local.AUTH_VERIFIED;delete local.ADMIN_AUTH_EXCHANGE;
    const readOnly=fn=>supportsReadSnapshot?db.withNativeReadSnapshot(fn):transaction(false,fn);
    const setContext=async(sql,values)=>{
      const rows=await sql.unsafe(PIN_SET_CONTEXT_SQL,values);
      requireThat(rows.length<=1,'session_unavailable',401);
      return rows[0]?.result;
    };
    const serveRead=async(sql,principal,values,readRequest=request,actorEvidence=undefined)=>{
      const identity=Object.freeze({id:principal.nativeAccountId,sessionId:principal.principalSessionId,
        installationId:installation,groupId:principal.groupId});
      const snapshot={request:readRequest,work,identity,sql,actorEvidence,principalUserId:principal.principalUserId,claimed:false,selected:false,
        binding:responseBindingHeaders.map(name=>readRequest.headers.get(name))};
      proofs.set(db,Object.freeze({groupId:principal.groupId,values,snapshot}));
      activeReadSnapshot(db);
      const response=await operation(principal,local,readRequest);
      requireActiveNativeRequest(request);activeReadSnapshot(db);
      requireThat(response instanceof Response,'request_not_admitted',503);
      if(!response.ok)throw new ReadSnapshotRefusal(response);
      requireThat(!snapshot.selected||snapshot.claimed,'request_not_admitted',503);
      return response;
    };
    try{
      db.setClaims({});
      // The combined branch enters the assertion-owning transaction next. No
      // async work or authority-bearing I/O occurs before that entry check.
      if(!combinedRead)await owned();
      if(logout){
        // The narrow barrier is allowed even when account access is temporarily
        // suspended. It validates exact device proofs and can only revoke them;
        // no general actor or protected data is exposed by this path.
        const token=(request.headers.get('authorization')??'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        requireThat(token,'session_unavailable',401);
        const groupId=requireId(request.headers.get('X-BuriMunsi-Group'));
        const body=validateNativeRequest('logout',await readNativeJson(request));
        let value;
        try{value=await transaction(true,async sql=>{
          const rows=await sql.unsafe(PIN_LOGOUT_SQL,[token,installation,device,profile,groupId,body.replacementToken??null]);
          requireThat(rows.length===1&&rows[0].result,'session_unavailable',401);return rows[0].result;
        });}catch(error){if(error?.code==='42501')throw new BuriError('session_unavailable',401);throw error;}
        exactKeys(value,['accountId','collectionId']);requireRequestId(value.accountId);
        requireThat(value.collectionId===groupId,'session_unavailable',401);
        const binding=requestBinding(request,installation,groupId);binding.actorId=value.accountId;
        const response=bindNativeResponse({operation:'logout'},binding,body,{signedOut:true});
        await owned();return new Response(JSON.stringify(response),{status:200,headers:headers()});
      }
      if(retirement){
        // A retired proof is useful only for this historical ACK. Never install
        // a native actor/context, compose ports, disclose data or retry a write.
        const requestId=requireRequestId(retirement[1]),fingerprint=request.headers.get('X-BuriMunsi-Handoff-Fingerprint');
        const token=(request.headers.get('authorization')??'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        requireThat(token&&/^[a-f0-9]{64}$/.test(fingerprint??''),'session_unavailable',401);
        let value;
        try{value=await transaction(false,async sql=>{
          requireThat((await sql.unsafe('SELECT pg_is_in_recovery() AS replica'))[0]?.replica===false,'command_primary_required',503);
          const rows=await sql.unsafe(RETIREMENT_OUTCOME_SQL,[token,installation,device,profile,requestId,fingerprint]);
          requireThat(rows.length===1&&rows[0].result,'session_unavailable',401);return rows[0].result;
        });}catch(error){if(error?.code==='42501')throw new BuriError('session_unavailable',401);throw error;}
        exactKeys(value,['kind','collectionId','actorId','sessionId','installationId','profile','requestId','fingerprint','state','ack']);
        requireId(value.collectionId);requireRequestId(value.actorId);requireRequestId(value.sessionId);
        requireThat(value.kind==='gateway_retirement_outcome'&&value.installationId===installation&&value.profile===profile&&
          value.requestId===requestId&&value.fingerprint===fingerprint&&['retired','unknown'].includes(value.state),
          'gateway_outcome_inconsistent',503);
        requireThat(request.headers.get('X-BuriMunsi-Group')===value.collectionId,'native_scope_changed',403);
        const binding=requestBinding(request,installation,value.collectionId);binding.actorId=value.actorId;
        const data={protocol:'burimunsi.receiver-retirement.v1',requestId,fingerprint,state:value.state,ack:value.ack};
        const response=bindNativeResponse({operation:'retirementOutcome',recordId:requestId},binding,null,data,undefined,fingerprint);
        await owned();return new Response(JSON.stringify(response),{status:200,headers:headers()});
      }
      if(login){
        const body=validateNativeRequest('login',await readNativeJson(request));
        const phone=normalizePhone(body.phone),pin=requirePin(body.pin),network=await networkBucket(request);await owned();
        requireThat(/^[a-f0-9]{64}$/.test(network??''),'trusted_network_resolver_required',503);
        const now=clock(),phoneHash=await sha256(phone),deviceHash=await sha256(device);
        const budget=await transaction(true,async sql=>{
          const rows=await sql.unsafe(
            'SELECT private.burimunsi_pin_login_account($1,$2,$3::uuid,$4,$5,$6,$7) AS result',
            [phone,phoneHash,installation,network,now,deviceHash,profile]);
          requireThat(rows.length===1&&typeof rows[0].result?.allowed==='boolean','authentication_unavailable',503);return rows[0].result;
        });
        // The denied budget transaction has already committed. No identity read,
        // PBKDF2, registration or session creation happens after denial.
        requireThat(budget.allowed,'try_again_later',429);
        const account=budget.account,verified=await pinHasher().verify(account?phone:'+250780000000',pin,account?.pinHash??dummy);await owned();
        requireThat(verified&&account?.phone===phone&&account.active===true&&account.removed===false,'invalid_credentials',401);
        requireId(account.groupId);requireRequestId(account.id);requireId(account.principalUserId);
        const token=newBearer(),id=crypto.randomUUID(),createdAt=clock(),expiresAt=createdAt+sessionTtlMs;
        const tokenHash=await sha256(token);
        const created=await transaction(true,async sql=>{
          const rows=await sql.unsafe('SELECT private.burimunsi_pin_create_session($1,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8,$9,$10,$11) AS result',
            [account.groupId,account.id,installation,profile,deviceHash,account.credentialVersion,id,tokenHash,createdAt,expiresAt,account.version]);
          requireThat(rows.length===1&&rows[0].result?.created===true,'invalid_credentials',401);return rows[0].result;
        }).catch(error=>{if(error?.code==='42501')throw new BuriError('invalid_credentials',401);throw error;});
        requireThat(integer(created.expiresAt)>clock()&&integer(created.expiresAt)<=expiresAt,'session_unavailable',401);
        const binding=requestBinding(request,installation,account.groupId);binding.actorId=account.id;
        const data={groupId:account.groupId,token,expiresAt:integer(created.expiresAt),profile:{id:account.id,name:account.name,phone:account.phone,
          role:account.role,capabilities:[...account.capabilities]}};
        if(includeHome){
          const values=Object.freeze([token,installation,device,profile]);
          try{
            data.home=await readOnly(async sql=>{
              const principal=current(await setContext(sql,values),installation,profile,clock());
              requireThat(principal.groupId===account.groupId&&principal.nativeAccountId===account.id,'session_unavailable',401);
              const authHeaders=new Headers(request.headers);
              authHeaders.delete('Content-Length');authHeaders.delete('Content-Type');
              authHeaders.set('Authorization','Bearer '+token);authHeaders.set('X-BuriMunsi-Group',account.groupId);
              const read=new Request(new URL('/v1/burimunsi/session?include=home',origin),{headers:authHeaders,signal:request.signal});
              const response=await serveRead(sql,principal,values,read);
              const envelope=await response.json();
              requireThat(envelope.ok===true&&envelope.binding?.actorId===account.id&&envelope.binding?.groupId===account.groupId&&
                envelope.binding?.installationId===installation&&envelope.binding?.requestId===binding.requestId&&
                envelope.binding?.generation===binding.generation&&envelope.data?.profile?.id===account.id,'session_unavailable',401);
              return envelope.data.home;
            });
            activeReadSnapshot(db);
          }catch(error){
            if(error?.code==='42501'||error instanceof ReadSnapshotRefusal&&error.response.status<500)throw new BuriError('session_unavailable',401);
            if(['application_fenced','application_fence_unavailable','request_not_admitted'].includes(error?.code)||
                error instanceof BuriError&&error.status<500)throw error;
            data.home=null;
          }
          await owned(true);
        }
        return new Response(JSON.stringify(bindNativeResponse({operation:'login',includeHome},binding,body,data)),{status:200,headers:headers()});
      }
      const token=(request.headers.get('authorization')??'').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      requireThat(token,'session_unavailable',401);const values=Object.freeze([token,installation,device,profile]);
      // A passcode change must still work when the short lease has elapsed. It
      // continues through its normal body, current-authority and current-PIN
      // checks after exact proof revalidation.
      // No other business command may use an expired proof.
      const requestedGroup=request.headers.get('X-BuriMunsi-Group');
      if(renewing)requireId(requestedGroup);
      const readPrincipal=row=>{
        const principal=current(row,installation,profile,clock());
        requireThat(requestedGroup===principal.groupId,'native_scope_changed',403);
        return principal;
      };
      if(combinedRead){
        const needsRenewal=new Error('native_read_needs_renewal');
        const readSnapshot=allowRenewal=>readOnly(async sql=>{
          let row,actorEvidence;
          const readActor=env.BURIMUNSI_PRODUCT_MODE===BURIMUNSI_PRODUCT_MODE&&db.ownsNativeRead?.(sql)===true&&
            isPhonePinRecordRead(path,url.search);
          try{
            if(readActor) {
              const startedAt=performance.now();
              const rows=await sql.unsafe(PIN_READ_ACTOR_SQL,[...values,requestedGroup,clock()]);
              requireThat(rows.length===1,'session_unavailable',401);
              row=rows[0].result;
              actorEvidence={row:rows[0].actor??null,createdAt:integer(row?.created_at),
                dbCheckedAt:integer(rows[0].checked_at),startedAt};
            }else{
              row=await setContext(sql,values);
            }
          }
          catch(error){
            // Only the PIN setter's missing or expired four-part proof may
            // enter renewal. A directory or permission failure stays a denial.
            if(allowRenewal&&error?.code==='42501'&&(!readActor||error.message==='session_changed'))throw needsRenewal;
            throw error;
          }
          if(allowRenewal&&(!row||integer(row.expires_at)<=clock()+60000))throw needsRenewal;
          return serveRead(sql,readPrincipal(row),values,request,actorEvidence);
        });
        try{
          let response;
          try{response=await readSnapshot(readSession);}
          catch(error){
            if(error!==needsRenewal)throw error;
            // The write fence requires READ COMMITTED. Commit renewal before
            // reopening a read-only snapshot and revalidating all four proofs.
            await transaction(true,async sql=>{
              const rows=await sql.unsafe(PIN_RENEW_SQL,[...values,requestedGroup,sessionTtlMs]);
              requireThat(rows.length===1,'session_unavailable',401);
              readPrincipal(rows[0]);
            });
            response=await readSnapshot(false);
          }
          activeReadSnapshot(db);
          return response;
        }catch(error){
          if(error instanceof ReadSnapshotRefusal)return error.response;
          if(error?.code==='42501')throw new BuriError('session_unavailable',401);
          throw error;
        }
      }
      let principal;
      try{principal=await transaction(renewing,async sql=>{
        const rows=await sql.unsafe(renewing?PIN_RENEW_SQL:PIN_CONTEXT_SQL,
          renewing?[...values,requestedGroup,sessionTtlMs]:values);
        requireThat(rows.length===1,'session_unavailable',401);
        return readPrincipal(rows[0]);
      });}catch(error){if(error?.code==='42501')throw new BuriError('session_unavailable',401);throw error;}
      proofs.set(db,Object.freeze({groupId:principal.groupId,values}));
      const result=await operation(principal,local);await owned();return result;
    }finally{proofs.delete(db);try{db.setClaims({});}finally{active.delete(db);}}
  };
}
