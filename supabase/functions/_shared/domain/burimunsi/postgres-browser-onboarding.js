import {PostgresBrowserEnrollment} from './postgres-browser-enrollment.js';
import {MemberService} from './member-service.js';
import {ScopedCursor} from './cursor.js';
import {requireThat} from './errors.js';
import {authorize} from './policy.js';
import {canonicalJson,requireRequestId,sha256} from './values.js';
import {findOnboardingCandidate,listOnboardingSuggestions,SMART_SUGGESTIONS_CTE} from './smart-onboarding-suggestions.js';
import {previewSmartOnboardingImport} from './smart-onboarding-import.js';
import {createSmartOnboardingPolicy} from './smart-onboarding-policy.js';
import {createGuardedSmartOnboardingImport} from './smart-onboarding-dispatch.js';
import {PostgresSmartOnboardingJournal} from './smart-onboarding-journal.js';
import {defs} from './wire/burimunsi.generated.mjs';
import {validateSchema} from './wire/runtime.mjs';

const IMPORT='burimunsi.members_import';
const SHA=/^[a-f0-9]{64}$/;

function cursorFor(env) {
  const key=env.BURIMUNSI_CURSOR_KEY_BASE64;
  requireThat(typeof key==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(key),'enrollment_unavailable',503);
  const binary=atob(key);
  requireThat(binary.length===32&&btoa(binary)===key,'enrollment_unavailable',503);
  return new ScopedCursor(Uint8Array.from(binary,char=>char.charCodeAt(0)));
}

function checkedBatch(response,requestId) {
  try{validateSchema(defs,'membersImport.data',response);}catch{requireThat(false,'invalid_command_receipt',503);}
  const {results}=response;
  requireThat(response.requestId===requestId&&new Set(results.map(item=>item.row)).size===results.length&&
    results.every(item=>(['created','already_registered'].includes(item.status))===(item.memberId!==null))&&
    response.created===results.filter(item=>item.status==='created').length,'invalid_command_receipt',503);
  return response;
}

/** Use the actual browser cookie witness in each read, command and OCR journal
 * transaction. A browser session has no Android installation or device grant. */
export class PostgresBrowserOnboarding extends PostgresBrowserEnrollment {
  constructor({env,account,proof}) {
    super({db:env.DB,account,proof});
    this.env=env;
  }

  get db(){return this.authority.db;}

  async session(sql,{id}) {
    requireThat(id===this.sessionId,'session_unavailable',401);
    const {dbActor,now}=await this.scope(sql);
    return authorize(dbActor,this.groupId,'members.enroll',{now});
  }

  currentActor() {
    return this.read((_sql,{dbActor,now})=>authorize(dbActor,this.groupId,'members.enroll',{now}));
  }

  suggestions({q='',limit=40,cursor=null}) {
    return this.read(async(sql,{dbActor,now})=>{
      authorize(dbActor,this.groupId,'members.enroll',{now});
      // Bind a continuation to all eligible hints, including changes to source
      // admission, number suffixes or existing memberships between pages.
      const [snapshot]=await sql.unsafe(`${SMART_SUGGESTIONS_CTE}
        SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(filtered) ORDER BY candidate_id)::text,'[]'),'UTF8')),'hex')
          AS revision FROM filtered`,[this.groupId,q.trim()]);
      const revision=snapshot?.revision;
      requireThat(typeof revision==='string'&&SHA.test(revision),'invalid_suggestion',503);
      const scope={groupId:this.groupId,actorId:this.actorId,snapshot:revision,sort:'onboarding_suggestions',
        filterHash:await sha256(canonicalJson({q,limit,sessionId:this.sessionId}))};
      const after=cursor?await cursorFor(this.env).read(cursor,scope,now):null;
      const page=await listOnboardingSuggestions(sql,{groupId:this.groupId,q,limit,after});
      const nextCursor=page.after?await cursorFor(this.env).create({...scope,after:page.after,
        expiresAt:Math.min(dbActor.expiresAt,now+15*60*1000)}):null;
      return {items:page.items.map(item=>({...item,id:item.candidateId,groupId:this.groupId})),
        totalCount:page.totalCount,nextCursor,revision,asOf:new Date(now).toISOString()};
    });
  }

  async preview(input) {
    const actor=await this.currentActor();
    if(this.env.BURIMUNSI_SMART_ONBOARDING_ADVANCED_ENABLED!=='true') {
      return previewSmartOnboardingImport({bytes:input.bytes,mimeType:input.mimeType,ocr:{consent:input.externalOcrConsent}});
    }
    const policy=createSmartOnboardingPolicy({env:this.env});
    const journal=new PostgresSmartOnboardingJournal({authority:this,env:this.env});
    const importer=createGuardedSmartOnboardingImport({env:this.env,groupId:this.groupId,policy,journal});
    return importer.preview({...input,actor,groupId:this.groupId,authorize:()=>this.currentActor()});
  }

  async batchReceipt(sql,requestId) {
    const rows=await sql.unsafe(`SELECT session_id,operation,fingerprint,response FROM private.burimunsi_command_receipts
      WHERE collection_id=$1 AND actor_id=$2::uuid AND request_id=$3::uuid`,[this.groupId,this.actorId,requestId]);
    if(!rows.length)return null;
    const [receipt]=rows;
    requireThat(rows.length===1&&receipt.operation===IMPORT&&receipt.session_id===this.sessionId,'idempotency_conflict',409);
    requireThat(typeof receipt.fingerprint==='string'&&SHA.test(receipt.fingerprint),'invalid_command_receipt',503);
    return {operation:IMPORT,fingerprint:receipt.fingerprint,sessionId:this.sessionId,response:checkedBatch(receipt.response,requestId)};
  }

  lookupImport(requestId) {
    requireRequestId(requestId);
    return this.read(async sql=>(await this.batchReceipt(sql,requestId))?.response??{requestId,outcome:'not_found'});
  }

  importMembers(input) {
    // Standalone BuriMunsi records payments and allocates them explicitly.
    return new MemberService({store:this,groupId:this.groupId,paymentsOnly:true})
      .importMembers({id:this.actorId,sessionId:this.sessionId},input);
  }

  inMemberTransaction(run) {
    return this.write(async sql=>{
      const {now}=await this.scope(sql);
      const check=(group,actorId,sessionId=this.sessionId)=>requireThat(group===this.groupId&&actorId===this.actorId&&
        sessionId===this.sessionId,'access_denied',403);
      return run({
        reloadActor:id=>this.session(sql,{id}),
        retainedCommand:(group,actorId,requestId)=>{
          check(group,actorId);
          return this.batchReceipt(sql,requestId);
        },
        onboardingCandidate:command=>{
          check(command.groupId,command.actorId,command.sessionId);
          return findOnboardingCandidate(sql,command);
        },
        createDirectMember:command=>{
          check(command.groupId,command.actorId,command.sessionId);
          return this.createMemberRecord(sql,command,now);
        },
        recordMemberImportAttestation:command=>{
          check(command.groupId,command.actorId,command.sessionId);
          return this.attestMember(sql,command,now);
        },
        retainCommand:async command=>{
          check(command.groupId,command.actorId,command.sessionId);
          requireThat(command.operation===IMPORT&&SHA.test(command.fingerprint),'invalid_command_receipt',503);
          const response=checkedBatch(command.response,command.requestId);
          const rows=await sql.unsafe(`INSERT INTO private.burimunsi_command_receipts
            (collection_id,actor_id,request_id,session_id,operation,fingerprint,response,created_at)
            VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::text::jsonb,$8) RETURNING request_id`,
            [this.groupId,this.actorId,command.requestId,this.sessionId,IMPORT,command.fingerprint,JSON.stringify(response),now]);
          requireThat(rows.length===1&&rows[0].request_id===command.requestId,'invalid_command_receipt',503);
        }
      });
    });
  }
}
