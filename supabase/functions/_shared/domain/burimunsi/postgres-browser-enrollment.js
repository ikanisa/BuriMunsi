import {auditStatement} from '../core.js';
import {requireThat} from './errors.js';
import {canonicalJson,requireId,requireRequestId,sha256} from './values.js';
import {PostgresNativeAuthority} from './postgres-authority.js';
import {validateDirectMemberInput,writeDirectMemberRecord} from './postgres-collect-members.js';
import {PostgresMemberRematchQueue} from './postgres-rematch-job-store.js';
import {COLLECT_MUTATION_LOCK} from '../../postgres-mutation-lock.js';

const OPERATION='burimunsi.browser_member_enrollment';
const SCOPE_SQL=`SELECT c.title AS label,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms
 FROM private.burimunsi_browser_pin_session($1,$2,$3) AS resolved(actor)
 JOIN private.burimunsi_accounts a ON a.id=$4::uuid AND a.collection_id=$1
 JOIN app.collections c ON c.id=a.collection_id AND c.status='active'
 WHERE resolved.actor->>'collectionId'=a.collection_id AND resolved.actor->>'accountId'=a.id::text
   AND resolved.actor->>'principalId'=a.principal_user_id AND a.principal_user_id=$5
   AND resolved.actor->>'sessionId'=$6 AND resolved.actor->>'publicId'=$7 AND resolved.actor->>'adminId'=$8
   AND resolved.actor->>'operatorRole'='admin' AND a.role='admin' AND a.active AND NOT a.removed
   AND 'members.enroll'=ANY(a.capabilities)
   AND resolved.actor->'permissions' ?& ARRAY['users.manage','collections.manage']
   AND private.assert_actor('users.manage',NULL,NULL,1::bigint,NULL::bigint)=a.principal_user_id
   AND private.assert_actor('collections.manage',NULL,NULL,1::bigint,NULL::bigint)=a.principal_user_id
 FOR SHARE OF a,c`;

function checkedMember(member,groupId) {
  requireThat(member&&typeof member==='object'&&member.groupId===groupId&&typeof member.name==='string'&&
    member.name.trim().length>0&&typeof member.phone==='string'&&/^\+2507[2389]\d{7}$/.test(member.phone)&&
    typeof member.active==='boolean'&&Number.isSafeInteger(member.version)&&member.version>=1&&Number.isSafeInteger(member.balanceRwf),
    'member_contract_violation',503);
  requireId(member.id);
  return {id:member.id,groupId,name:member.name,phone:member.phone,active:member.active,version:member.version,balanceRwf:member.balanceRwf};
}

export class PostgresBrowserEnrollment {
  constructor({db,proof,account}) {
    this.groupId=proof.collectionId;
    this.actorId=proof.accountId;
    this.sessionId=account.auth_session_id;
    this.actor={userId:account.principal_id,sessionId:this.sessionId};
    this.authority=new PostgresNativeAuthority({db,groupId:this.groupId});
    this.queue=new PostgresMemberRematchQueue(this.groupId);
    this.scopeArgs=[this.groupId,account.token_hash,account.origin,this.actorId,
      this.actor.userId,this.sessionId,account.public_id,account.id];
  }

  async scope(sql) {
    const rows=await sql.unsafe(SCOPE_SQL,this.scopeArgs);
    requireThat(rows.length===1,'access_denied',403);
    const {label,now_ms}=rows[0],now=Number(now_ms);
    requireThat(typeof label==='string'&&label.trim().length>0&&Number.isSafeInteger(now)&&now>0,'member_contract_violation',503);
    return {label,now};
  }

  async read(operation) {
    const {db}=this.authority;
    return db.withLockedReadSnapshot(async sql=>{
      await sql.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)",[this.groupId]);
      const scope=await this.scope(sql);
      return operation(sql,scope);
    });
  }

  async write(operation) {
    const {db}=this.authority;
    await this.authority.assertOwned();
    return db.transaction(async sql=>{
      // Browser context verification takes row locks. Serialize writers before
      // taking those locks so concurrent submissions can read the same receipt.
      await sql.unsafe('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',[COLLECT_MUTATION_LOCK]);
      await db.context(sql);
      await sql.unsafe("SELECT set_config('burimunsi.collection_id',$1,true)",[this.groupId]);
      const result=await operation(sql);
      await this.authority.assertOwned();
      return result;
    });
  }

  context() {
    return this.read((_sql,{label})=>({collectionId:this.groupId,label,canEnroll:true}));
  }

  async prior(sql,requestId,fingerprint=null) {
    const rows=await sql.unsafe(`SELECT session_id,operation,fingerprint,response FROM private.burimunsi_command_receipts
      WHERE collection_id=$1 AND actor_id=$2::uuid AND request_id=$3::uuid`,[this.groupId,this.actorId,requestId]);
    if(rows.length===0)return null;
    const receipt=rows[0];
    requireThat(rows.length===1&&receipt.session_id===this.sessionId&&receipt.operation===OPERATION&&
      (fingerprint===null||receipt.fingerprint===fingerprint),'idempotency_conflict',409);
    const member=checkedMember(receipt.response,this.groupId);
    return {requestId,outcome:'applied',member};
  }

  lookup(requestId) {
    requireRequestId(requestId);
    return this.read(async sql=>await this.prior(sql,requestId)??{requestId,outcome:'not_found'});
  }

  async apply(command) {
    const {name,phone,requestId}=command;
    requireRequestId(requestId);
    validateDirectMemberInput(command);
    requireThat(command.verifiedOwnership===true&&command.acceptedTerms===true&&command.consentRecorded===true,'attestation_required');
    const fingerprint=await sha256(canonicalJson({operation:OPERATION,groupId:this.groupId,...command}));
    return this.write(async sql=>{
      const current=await this.scope(sql);
      const prior=await this.prior(sql,requestId,fingerprint);
      if(prior)return prior;
      // Match the native lock order even while automated posting is paused.
      await this.queue.scope(sql,{allowDisabled:true});
      const record=await writeDirectMemberRecord(this.authority,sql,{groupId:this.groupId,name,phone},current.now);
      const member=checkedMember(record,this.groupId);
      const audited=await this.authority.db.statement(sql,auditStatement({DB:this.authority.db},this.actor,
        record.existing?'burimunsi.enrollment.attested':'burimunsi.enroll','user',member.id,{
          collection_id:this.groupId,browser_account_id:this.actorId,verifiedOwnership:true,acceptedTerms:true,consentRecorded:true
        },requestId));
      requireThat(audited?.success===true&&audited.meta?.changes===1,'member_contract_violation',503);
      await sql.unsafe(`INSERT INTO private.burimunsi_audit (id,collection_id,actor_id,action,entity_id,request_id,at_ms)
        VALUES ($1::uuid,$2,$3::uuid,'burimunsi.members_import.attested',$4,$5::uuid,$6)`,
        [crypto.randomUUID(),this.groupId,this.actorId,member.id,requestId,current.now]);
      if(!record.existing)await this.queue.enqueueInTransaction(sql,{groupId:this.groupId,memberId:member.id,requestId});
      await this.scope(sql);
      const retained=await sql.unsafe(`INSERT INTO private.burimunsi_command_receipts
        (collection_id,actor_id,request_id,session_id,operation,fingerprint,response,created_at)
        VALUES($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8) RETURNING request_id::text AS request_id`,
        [this.groupId,this.actorId,requestId,this.sessionId,OPERATION,fingerprint,JSON.stringify(member),current.now]);
      requireThat(retained.length===1&&retained[0].request_id===requestId,'member_contract_violation',503);
      return {requestId,outcome:'applied',member};
    });
  }
}
