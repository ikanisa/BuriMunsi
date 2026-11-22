package app.cool.mobile.receiver_sms

import android.content.Context
import app.cool.mobile.receiver_sms.ObservationRecovery.Audit
import rw.ikanisa.burimunsi.core.ObservationCandidate
import rw.ikanisa.burimunsi.core.ObservationConsentState
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.core.ObservationProfile
import rw.ikanisa.burimunsi.core.ObservationReconcileReply
import rw.ikanisa.burimunsi.core.ObservationReconcileRequest
import rw.ikanisa.burimunsi.core.ObservationSessionOwner
import rw.ikanisa.burimunsi.core.SmsSourceRef
import rw.ikanisa.burimunsi.core.ObservationInboxCheck
import java.util.UUID
import org.json.JSONObject
import rw.ikanisa.burimunsi.storage.SecureStore
import rw.ikanisa.burimunsi.core.Values
import rw.ikanisa.burimunsi.core.checkContract
import rw.ikanisa.burimunsi.data.ApiFailure
import rw.ikanisa.burimunsi.data.NativeRepository
import java.time.Instant

/** Reconciles handset custody and parser outcomes under one consent, inbox and collection snapshot. */
internal class ObservationInboxAudit(
    private val app: Context,
    private val config: ObservationConfigStore,
    private val heldInbox: ObservationHeldInbox,
    private val lock: Any,
) {
    companion object {
        private const val AUDIT_PAGE = 4
        private var auditProgress:AuditProgress?=null
        private var completedAuditStart:Long?=null
        private var completedAuditRevision:String?=null
        private var completedCheck:ObservationInboxCheck?=null
    }

    private data class AuditScope(val session:ObservationSessionOwner,val fingerprint:String,val legacyHold:Boolean?,
        val consent:ObservationConsentState,val control:ObservationConfigStore.Control,val deviceScope:String,val heldScope:String,val revision:Long,val uncertainLegacy:Boolean)
    private data class AuditProgress(val scope:AuditScope,val last:Long,val unconfirmed:Boolean,val startedAt:Long,
        val collectionRevision:String,val recordedCount:Int,
        val sourceIds:Set<String> = emptySet(),val phoneComplete:Boolean=false,val cloudCursor:String?=null,
        val cloudRevision:String?=null,val cloudTotal:Int?=null,val cloudIds:Set<String> = emptySet(),val cursors:Set<String> = emptySet(),
        val cloudComplete:Boolean=false,
        val runId:String=UUID.randomUUID().toString(),val repairTail:Boolean=false,val candidates:Int=0,val missing:Int=0,val pending:Int=0,
        val phoneHead:Head?=null,val parsedHead:Head?=null,val queuedRepair:Boolean=false,val hasGateway:Boolean=false,val parserPending:Boolean=false,
        val awaiting:Pair<List<ObservationReconcileRequest>,List<ObservationReconcileReply?>>?=null)
    private data class Head(val received:Long,val rowId:Long,val key:String) {
        override fun toString()="Head(redacted)"
    }
    private fun newest(previous:Head?,next:Head):Head =
        if(previous==null || next.received>previous.received || next.received==previous.received&&next.rowId>previous.rowId)next else previous
    private fun AuditProgress.check(state:String)=ObservationInboxCheck(runId,scope.consent.revision.generation,state,
        candidates,missing,pending,phoneHead?.key,parsedHead?.key,collectionRevision)

    private data class AuditAuthority(val scope:AuditScope,val profile:ObservationProfile,val device:String,val held:Set<String>)
    private class AuditAuthorityChanged:Exception()
    private data class AuditRow(val id:Long,val received:Long,val sender:String,val body:String,val sent:Long?,val sub:Int?){
        override fun toString()="AuditRow(redacted)"
    }

    /** A restart can resume looking for missing rows through the previous tail, then
     * must start a new full verification in ascending handset order from row zero. */
    private fun positionStore(scope:AuditScope):SecureStore {
        val parts=listOf(scope.session.owner.collectionId,scope.session.owner.accountId,scope.fingerprint,scope.deviceScope,
            scope.heldScope,scope.consent.revision.generation.toString(),scope.control.revision.toString(),scope.legacyHold.toString())
        return SecureStore(app,"observation-repair-position-"+Values.sha256(parts.joinToString(""){"${it.length}:$it"}))
    }
    private fun restartPosition(scope:AuditScope):Long {
        val saved=positionStore(scope).read()?.let(::JSONObject)?:return 0
        val last=saved.getLong("lastId")
        checkContract(last>=0 && saved.keys().asSequence().toSet()==setOf("epoch","lastId","repairTail"),"observation_cursor_unavailable")
        return if(saved.getString("epoch")!=ObservationInboxRevision.epoch()||saved.getBoolean("repairTail"))last else 0
    }
    private fun savePosition(scope:AuditScope,last:Long,repairTail:Boolean) {
        val value=JSONObject().put("epoch",ObservationInboxRevision.epoch()).put("lastId",last).put("repairTail",repairTail).toString()
        val store=positionStore(scope)
        store.write(value)
        checkContract(store.read()==value,"observation_cursor_unavailable")
    }

    private fun auditAuthority(stopped:()->Boolean):AuditAuthority? {
        if(stopped()||!ObservationInboxRevision.observerActive()||!observationInboxPermitted(app)||!ObservationLegacyOwnership.controlTransitionClear(app))return null
        val session=NativeRepository.observationOwner(app)?:return null
        val initial=NativeRepository.withObservationOwner(app,session){group,account->
            val owner=ObservationOwner(group,account);val profile=config.profile(owner,System.currentTimeMillis())
            val control=config.controlState(owner);val consent=config.consent(owner)
            if(control.paused||consent?.canCapture(observationInboxPermitted(app))!=true||profile?.legacyHold==null)null
            else Triple(profile,consent,control)
        }?:return null
        val (profile,consent,control)=initial
        val (device,keys)=heldInbox.snapshot(session,profile,consent,control,stopped)?:return null
        val uncertainLegacy=if(HeldRecoveryJournal.hasRecords(app)){
            val installation=MomoGatewayStore(app).existingInstallationId()?:return null
            HeldRecoveryJournal.hasUncertain(app,session.owner,installation,Values.sha256(device))
        }else false
        val heldScope=Values.sha256(keys.sorted().joinToString(""){"${it.length}:$it"})
        val scope=AuditScope(session,profile.fingerprint(),profile.legacyHold,consent,control,Values.sha256(device),heldScope,
            ObservationInboxRevision.snapshot(),uncertainLegacy)
        if(stopped()||!ObservationInboxRevision.observerActive()||!observationInboxPermitted(app)||NativeRepository.observationOwner(app)!=session)return null
        return AuditAuthority(scope,profile,device,keys)
    }
    /** A completed local sweep is reusable only for this exact authority and inbox revision. */
    fun sweepScope(stopped:()->Boolean={false}):String? = synchronized(lock){
        try{auditAuthority(stopped)?.scope?.let{scope->
            Values.sha256(listOf(scope.session.owner.collectionId,scope.session.owner.accountId,scope.session.generation.toString(),
                scope.fingerprint,scope.legacyHold.toString(),scope.consent.revision.enabled.toString(),
                scope.consent.revision.generation.toString(),scope.consent.confirmed.toString(),scope.control.paused.toString(),
                scope.control.revision.toString(),scope.deviceScope,scope.heldScope,scope.revision.toString(),scope.uncertainLegacy.toString())
                .joinToString(""){"${it.length}:$it"})
        }}catch(_:Exception){null}
    }
    fun resetAudit()=synchronized(lock){auditProgress=null;completedAuditStart=null;completedAuditRevision=null;completedCheck=null}
    fun auditStartedAt():Long?=synchronized(lock){completedAuditStart}
    fun completedCheck():ObservationInboxCheck?=synchronized(lock){completedCheck}
    fun auditRevision():String?=synchronized(lock){completedAuditRevision}

    /** Verify a bounded page, enqueue positively identified gaps, and certify only a full
     * stable sweep. The encrypted repair cursor is independent of any successful proof. */
    fun auditPage(repo:NativeRepository,stopped:()->Boolean={false},budgetExpired:()->Boolean={false}):Audit = synchronized(lock){
        // A deadline never makes an in-flight page valid. Keep only progress
        // saved before this call; the next cycle revalidates its whole scope.
        fun interrupted():Audit {
            if(stopped()&&budgetExpired())return Audit.YIELD
            auditProgress=null;return Audit.BLOCKED
        }
        // A reply received after the deadline may be checkpointed after the
        // local authority and inbox are rechecked. It cannot start another I/O.
        val localStop={stopped()&&!budgetExpired()}
        val authority=try{auditAuthority(stopped)}catch(_:Exception){null}?:return@synchronized interrupted()
        val scope=authority.scope;val owner=scope.session.owner
        val clock=android.os.SystemClock.elapsedRealtime()
        val previous=auditProgress?.takeIf{it.scope==scope&&clock>=it.startedAt&&clock-it.startedAt<24*60*60_000L}
        val progress:AuditProgress=previous?:run{
            completedAuditStart=null;completedAuditRevision=null;completedCheck=null
            if(stopped())return@synchronized interrupted()
            val runId=UUID.randomUUID().toString()
            repo.reportInboxCheck(ObservationInboxCheck(runId,scope.consent.revision.generation,"checking"))
            if(stopped()||try{auditAuthority(stopped)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
            val status=repo.verifiedObservationStatus()
            if(try{auditAuthority(localStop)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
            ObservationBackground.recordsChanged(app,status.revision)
            if(status.recordedCount !in 0..100_000||status.hasRecorded!=(status.recordedCount>0))return@synchronized Audit.UNCONFIRMED
            val resume=restartPosition(scope)
            auditProgress=AuditProgress(scope,resume,scope.uncertainLegacy || status.hasPending || status.hasUnmatchedCanonical,clock,status.revision,status.recordedCount,runId=runId,repairTail=resume>0)
            return@synchronized Audit.MORE
        }
        if(progress.cloudComplete){
            if(stopped())return@synchronized interrupted()
            val status=repo.verifiedObservationStatus()
            if(try{auditAuthority(localStop)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
            ObservationBackground.recordsChanged(app,status.revision)
            auditProgress=null
            if(status.hasPending||status.hasUnmatchedCanonical||status.revision!=progress.collectionRevision||status.recordedCount!=progress.recordedCount){
                if(!stopped())repo.reportInboxCheck(progress.check("incomplete"))
                return@synchronized Audit.RETRY
            }
            if(status.hasRecorded!=(status.recordedCount>0)||progress.sourceIds.size!=status.recordedCount||
                (!progress.hasGateway&&(progress.cloudTotal!=status.recordedCount||progress.cloudIds!=progress.sourceIds))||
                progress.candidates!=progress.sourceIds.size||progress.phoneHead!=progress.parsedHead){
                if(!stopped())repo.reportInboxCheck(progress.check("incomplete"))
                return@synchronized Audit.UNCONFIRMED
            }
            completedCheck=progress.check("verified")
            completedAuditStart=progress.startedAt
            completedAuditRevision=progress.collectionRevision
            return@synchronized Audit.COMPLETE
        }
        if(progress.phoneComplete){
            if(stopped()||try{auditAuthority(stopped)?.scope!=scope}catch(_:Exception){true}){
                return@synchronized interrupted()
            }
            val page=try{repo.observationPage(cursor=progress.cloudCursor,limit=100)}catch(error:ApiFailure){
                if(error.code in setOf("cursor_scope_changed","cursor_expired","invalid_cursor")){
                    auditProgress=null;return@synchronized Audit.RETRY
                }
                throw error
            }
            val after=try{auditAuthority(localStop)}catch(_:Exception){null}
            if(after?.scope!=scope)return@synchronized interrupted()
            val ids=page.items.map{it.source.id};val total=page.totalCount
            if(total !in 0..100_000||ids.size>100||ids.toSet().size!=ids.size||ids.any{it in progress.cloudIds}||
                (progress.cloudRevision!=null&&page.revision!=progress.cloudRevision)||
                (progress.cloudTotal!=null&&total!=progress.cloudTotal)||
                page.items.any{it.groupId!=owner.collectionId}){
                auditProgress=null;return@synchronized Audit.UNCONFIRMED
            }
            val collected=progress.cloudIds+ids
            if(collected.size>total){auditProgress=null;return@synchronized Audit.UNCONFIRMED}
            val next=page.nextCursor
            if(next!=null){
                if(next in progress.cursors||ids.isEmpty()||collected.size>=total){auditProgress=null;return@synchronized Audit.UNCONFIRMED}
                auditProgress=progress.copy(cloudCursor=next,cloudRevision=page.revision,cloudTotal=total,cloudIds=collected,
                    cursors=progress.cursors+next)
                return@synchronized Audit.MORE
            }
            auditProgress=progress.copy(cloudRevision=page.revision,cloudTotal=total,cloudIds=collected,cloudComplete=true)
            return@synchronized Audit.MORE
        }
        fun open() = queryObservationInbox(app, progress.last, authority.profile.receipt.senders)
        fun takePage(checkStop:()->Boolean=stopped):List<AuditRow>? {
            val cursor=open()?:return null;val rows=mutableListOf<AuditRow>();var previous=progress.last
            cursor.use{
                val id=it.getColumnIndexOrThrow("_id");val date=it.getColumnIndexOrThrow("date")
                val sender=it.getColumnIndexOrThrow("address");val body=it.getColumnIndexOrThrow("body")
                val sent=it.getColumnIndex("date_sent");val sub=it.getColumnIndex("sub_id")
                while(rows.size<AUDIT_PAGE&&it.moveToNext()){
                    if(checkStop()||it.isNull(id)||it.isNull(date))return null
                    val rowId=it.getLong(id);val received=it.getLong(date)
                    if(rowId<=previous||received<=0)return null
                    rows.add(AuditRow(rowId,received,if(it.isNull(sender))"" else it.getString(sender),
                        if(it.isNull(body))"" else it.getString(body),if(sent<0||it.isNull(sent))null else it.getLong(sent).takeIf{v->v>0},
                        if(sub<0||it.isNull(sub))null else it.getInt(sub).takeIf{v->v>=0}));previous=rowId
                }
            }
            return rows
        }
        val rows=try{takePage()}catch(_:Exception){null}?:return@synchronized interrupted()
        var uncertain=progress.unconfirmed
        var candidates=progress.candidates
        var missing=progress.missing
        var pending=progress.pending
        var phoneHead=progress.phoneHead
        var parsedHead=progress.parsedHead
        var queuedRepair=progress.queuedRepair
        var parserPending=progress.parserPending
        val requests=mutableListOf<ObservationReconcileRequest>()
        val decisions=mutableMapOf<Long,ObservationLegacyOwnership.Decision>()
        val candidatesByKey=mutableMapOf<String,AuditRow>()
        for(row in rows){
            if(authority.profile.receipt.senders.none{it.equals(row.sender,ignoreCase=true)})continue
            val decision=ObservationLegacyOwnership.classify(app,owner,row.id,row.received,row.sender,row.body,row.sub)
            if(decision==ObservationLegacyOwnership.Decision.OTHER_SIM)continue
            val key=heldInboxSourceKey(authority.device,owner.collectionId,row.id,row.received)
            candidates++
            phoneHead=newest(phoneHead,Head(row.received,row.id,key))
            decisions[row.id]=decision
            if(decision==ObservationLegacyOwnership.Decision.HOLD || !ObservationCandidate.accepts(row.sender,row.body,authority.profile.receipt)){
                uncertain=true;pending++;continue
            }
            val gateway=if(decision==ObservationLegacyOwnership.Decision.OWNED)
                ObservationLegacyOwnership.gatewayEnvelopeId(app,owner,row.id,row.received,row.sender,row.body,row.sent,row.sub) else null
            if(decision==ObservationLegacyOwnership.Decision.OWNED&&gateway==null){uncertain=true;pending++;continue}
            candidatesByKey[key]=row
            requests.add(ObservationReconcileRequest(key,Values.sha256(row.body),row.sender,
                row.sent?.let{Instant.ofEpochMilli(it).toString()},Instant.ofEpochMilli(row.received).toString(),row.sub,gateway))
        }
        fun verify(items:List<ObservationReconcileRequest>):List<ObservationReconcileReply?> {
            if(items.isEmpty())return emptyList()
            if(stopped())throw InterruptedException()
            if(try{auditAuthority(stopped)?.scope!=scope}catch(_:Exception){true})throw AuditAuthorityChanged()
            return try{
                val replies=repo.reconcileObservations(items,progress.runId.takeUnless{progress.repairTail})
                checkContract(replies.size==items.size&&replies.indices.all{i->replies[i].sourceKey==items[i].sourceKey&&
                    replies[i].state in setOf("matched","missing")&&(replies[i].state=="matched")==(replies[i].sourceId!=null)},
                    "invalid_observation_reconciliation")
                replies
            }catch(error:ApiFailure){
                if(error.code !in setOf("observation_item_conflict","observation_item_unavailable"))throw error
                if(items.size==1)listOf(null) else items.flatMap{verify(listOf(it))}
            }
        }
        val states=try{progress.awaiting?.takeIf{it.first==requests}?.second ?: requests.chunked(4).flatMap{verify(it)}}catch(error:Exception){
            if(stopped()||error is AuditAuthorityChanged)return@synchronized interrupted()
            throw error
        }
        val sourceIds=progress.sourceIds.toMutableSet()
        val ids=states.mapNotNull{it?.sourceId}.distinct().map{SmsSourceRef.Observation(it)}
        val outcomes=if(ids.isEmpty())emptyMap() else {
            if(stopped()){
                if(budgetExpired()&&try{auditAuthority(localStop)?.scope==scope&&takePage(localStop)==rows}catch(_:Exception){false})
                    auditProgress=progress.copy(awaiting=requests to states)
                return@synchronized interrupted()
            }
            repo.observationProcessing(ids)
        }
        // Check the exact rows and all authorities again before a repair can enter either journal.
        val after=try{auditAuthority(localStop)}catch(_:Exception){null}
        if(after?.scope!=scope||try{takePage(localStop)!=rows}catch(_:Exception){true})return@synchronized interrupted()
        for(row in rows){
            val before=decisions[row.id]?:continue
            if(before!=ObservationLegacyOwnership.classify(app,owner,row.id,row.received,row.sender,row.body,row.sub)||
                ObservationInboxRevision.snapshot()!=scope.revision||localStop())return@synchronized interrupted()
        }
        for((index,reply) in states.withIndex()){
            val key=requests[index].sourceKey
            val row=candidatesByKey.getValue(key)
            if(reply==null){uncertain=true;pending++;continue}
            if(reply.state=="missing"){
                uncertain=true;missing++
                if(stopped())return@synchronized interrupted()
                // A baseline or an in-flight historical command never enters live payment processing.
                if(decisions[row.id]==ObservationLegacyOwnership.Decision.OWNED){
                    val gateway=requests[index].gatewayEnvelopeId
                    if(gateway!=null&&ObservationLegacyOwnership.repairGateway(app,owner,row.id,row.received,row.sender,row.body,
                        row.sent,row.sub,gateway))queuedRepair=true
                }else if(key in after.held){
                    if(decisions[row.id]==ObservationLegacyOwnership.Decision.UNOWNED){
                        try{
                            if(heldInbox.recoverMissing(repo,scope.session,scope.consent,authority.profile,authority.device,key,
                                requests[index],row.body))queuedRepair=true
                        }catch(error:ApiFailure){
                            // A scoped content/command conflict holds this row; other missing sources may still be retained.
                            if(error.status!=409)throw error
                        }
                    }
                }else if(decisions[row.id]==ObservationLegacyOwnership.Decision.UNOWNED){
                    val retained=ObservationLegacyOwnership.withDecision(app,owner,row.id,row.received,row.sender,row.body,row.sub){decision->
                        if(decision!=decisions[row.id])null else ObservationCapture.retain(app,scope.session,scope.fingerprint,"inbox:${row.id}",
                            row.sender,row.body,"catch_up",false,requests[index].serviceCentreAt,requests[index].inboxReceivedAt,row.sub,key)
                    }
                    if(retained==ObservationCapture.Result.STORED || retained==ObservationCapture.Result.DUPLICATE)queuedRepair=true
                }
                continue
            }
            val source=reply.sourceId
            if(source==null||!sourceIds.add(source)){uncertain=true;pending++;continue}
            if(sourceIds.size>100_000){auditProgress=null;return@synchronized Audit.UNCONFIRMED}
            val parser=outcomes[SmsSourceRef.Observation(source)]?.status
            if(parser in setOf("pending","retrying"))parserPending=true
            if(parser in setOf("parsed","duplicate")){
                parsedHead=newest(parsedHead,Head(row.received,row.id,key))
            }else {uncertain=true;pending++}
        }
        if(try{auditAuthority(localStop)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
        val page=progress.copy(last=rows.lastOrNull()?.id?:progress.last,unconfirmed=uncertain,sourceIds=sourceIds,
            awaiting=null,parserPending=parserPending,candidates=candidates,missing=missing,pending=pending,hasGateway=progress.hasGateway||requests.any{it.gatewayEnvelopeId!=null},phoneHead=phoneHead,parsedHead=parsedHead,queuedRepair=queuedRepair)
        savePosition(scope,if(rows.size<AUDIT_PAGE)0 else page.last,progress.repairTail && rows.size==AUDIT_PAGE)
        if(progress.repairTail && rows.size<AUDIT_PAGE){
            if(stopped())return@synchronized interrupted()
            repo.reportInboxCheck(page.check("incomplete"))
            auditProgress=null
            return@synchronized Audit.RETRY
        }
        if(rows.size<AUDIT_PAGE && uncertain){
            if(stopped())return@synchronized interrupted()
            repo.reportInboxCheck(page.check("incomplete"))
            auditProgress=null
            return@synchronized when{queuedRepair->Audit.REPAIRED;parserPending->Audit.AWAITING_PARSER;else->Audit.UNCONFIRMED}
        }
        auditProgress=page.copy(phoneComplete=rows.size<AUDIT_PAGE,cloudComplete=rows.size<AUDIT_PAGE&&page.hasGateway)
        Audit.MORE
    }
}
