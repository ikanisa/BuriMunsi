package app.cool.mobile.receiver_sms

import android.content.Context
import app.cool.mobile.receiver_sms.ObservationRecovery.Audit
import rw.ikanisa.burimunsi.core.ObservationCandidate
import rw.ikanisa.burimunsi.core.ObservedReceiptEvidence
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
import rw.ikanisa.burimunsi.data.OBSERVATION_RECONCILE_MAX_BYTES
import rw.ikanisa.burimunsi.data.OBSERVATION_RECONCILE_MAX_ITEMS
import rw.ikanisa.burimunsi.data.reconciliationBatchBody
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
        private var opening:Opening?=null
        private var auditProgress:AuditProgress?=null
        private var completedAuditStart:Long?=null
        private var completedAuditRevision:String?=null
        private var completedCheck:ObservationInboxCheck?=null
    }

    private data class AuditScope(val session:ObservationSessionOwner,val fingerprint:String,val legacyHold:Boolean?,
        val consent:ObservationConsentState,val control:ObservationConfigStore.Control,val deviceScope:String,val heldScope:String,val revision:Long,val uncertainLegacy:Boolean,val uncertainLocal:Boolean)
    private data class Opening(val scope:AuditScope,val startedAt:Long,val runId:String,val acknowledged:Boolean=false)
    private data class AuditProgress(val scope:AuditScope,val last:Long,val unconfirmed:Boolean,val startedAt:Long,
        val collectionRevision:String,val recordedCount:Int,
        val sourceIds:Set<String> = emptySet(),val phoneComplete:Boolean=false,
        val runId:String,val incompleteResult:Audit?=null,val handledRepairs:Set<String> = emptySet(),val pageSize:Int=OBSERVATION_RECONCILE_MAX_ITEMS,val repairTail:Boolean=false,val candidates:Int=0,val missing:Int=0,val pending:Int=0,
        val phoneHead:Head?=null,val parsedHead:Head?=null,val queuedRepair:Boolean=false,val parserPending:Boolean=false,
        val awaiting:Pair<List<ObservationReconcileRequest>,List<ObservationReconcileReply?>>?=null)
    private data class Head(val received:Long,val rowId:Long,val key:String) {
        override fun toString()="Head(redacted)"
    }
    private fun newest(previous:Head?,next:Head):Head =
        if(previous==null || next.received>previous.received || next.received==previous.received&&next.rowId>previous.rowId)next else previous
    private fun AuditProgress.check(state:String)=ObservationInboxCheck(runId,scope.consent.revision.generation,state,
        candidates,missing,pending,phoneHead?.key,parsedHead?.key,collectionRevision)

    private data class AuditAuthority(val scope:AuditScope,val profile:ObservationProfile,val device:String,val held:Set<String>,val review:AndroidUnclassifiedSmsStore)
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
        val installation=MomoGatewayStore(app).existingInstallationId()?:return null
        val deviceScope=Values.sha256(device)
        val uncertainLegacy=HeldRecoveryJournal.hasRecords(app)&&
            HeldRecoveryJournal.hasUncertain(app,session.owner,installation,deviceScope)
        val inboxRevision=ObservationInboxRevision.snapshot()
        val review=AndroidUnclassifiedSmsStore(app,session.owner.collectionId,session.owner.accountId,
            installation,deviceScope,{
                !stopped()&&ObservationInboxRevision.snapshot()==inboxRevision&&observationInboxPermitted(app)&&NativeRepository.observationOwner(app)==session&&
                    config.controlState(session.owner)==control&&config.consent(session.owner)==consent&&
                    config.profile(session.owner,System.currentTimeMillis())==profile&&heldInbox.deviceId()==device
            })
        val uncertainLocal=review.hasUnresolved()
        val heldScope=Values.sha256(keys.sorted().joinToString(""){"${it.length}:$it"})
        val scope=AuditScope(session,profile.fingerprint(),profile.legacyHold,consent,control,Values.sha256(device),heldScope,
            inboxRevision,uncertainLegacy,uncertainLocal)
        if(stopped()||!ObservationInboxRevision.observerActive()||!observationInboxPermitted(app)||NativeRepository.observationOwner(app)!=session)return null
        return AuditAuthority(scope,profile,device,keys,review)
    }
    /** A completed local sweep is reusable only for this exact authority and inbox revision. */
    fun sweepScope(stopped:()->Boolean={false}):String? = synchronized(lock){
        try{auditAuthority(stopped)?.scope?.let{scope->
            Values.sha256(listOf(scope.session.owner.collectionId,scope.session.owner.accountId,scope.session.generation.toString(),
                scope.fingerprint,scope.legacyHold.toString(),scope.consent.revision.enabled.toString(),
                scope.consent.revision.generation.toString(),scope.consent.confirmed.toString(),scope.control.paused.toString(),
                scope.control.revision.toString(),scope.deviceScope,scope.heldScope,scope.revision.toString(),scope.uncertainLegacy.toString(),scope.uncertainLocal.toString())
                .joinToString(""){"${it.length}:$it"})
        }}catch(_:Exception){null}
    }
    fun resetAudit()=synchronized(lock){opening=null;auditProgress=null;completedAuditStart=null;completedAuditRevision=null;completedCheck=null}
    fun auditStartedAt():Long?=synchronized(lock){completedAuditStart}
    fun completedCheck():ObservationInboxCheck?=synchronized(lock){completedCheck}
    fun auditRevision():String?=synchronized(lock){completedAuditRevision}

    /** Verify a bounded page, enqueue positively identified gaps, and certify only a full
     * stable sweep. The encrypted repair cursor is independent of any successful proof. */
    fun auditPage(repo:NativeRepository,stopped:()->Boolean={false},budgetExpired:()->Boolean={false}):Audit = synchronized(lock){
        // Budget expiry carries acknowledged steps into the next cycle, which
        // revalidates the complete scope before it resumes. Cancellation clears them.
        fun interrupted():Audit {
            if(stopped()&&budgetExpired())return Audit.YIELD
            resetAudit();return Audit.BLOCKED
        }
        // A reply received after the deadline may be checkpointed after the
        // local authority and inbox are rechecked. It cannot start another I/O.
        val localStop={stopped()&&!budgetExpired()}
        val authority=try{auditAuthority(stopped)}catch(_:Exception){null}?:return@synchronized interrupted()
        val scope=authority.scope;val owner=scope.session.owner
        val clock=android.os.SystemClock.elapsedRealtime()
        fun current(previousScope:AuditScope,startedAt:Long)=
            previousScope==scope && clock>=startedAt && clock-startedAt<24*60*60_000L
        fun sameAuthority()=try{auditAuthority(localStop)?.scope==scope}catch(_:Exception){false}
        fun report(check:ObservationInboxCheck){
            try{repo.reportInboxCheck(check)}catch(error:ApiFailure){
                // A terminal rejection invalidates this run. A lost response can replay its identical report.
                if(error.status in 400..499 && error.status !in setOf(408,429))resetAudit()
                throw error
            }
        }
        fun reportIncomplete(page:AuditProgress,result:Audit):Audit {
            auditProgress=page.copy(incompleteResult=result)
            if(stopped())return if(budgetExpired())Audit.MORE else interrupted()
            report(page.check("incomplete"))
            if(!sameAuthority()){resetAudit();return Audit.BLOCKED}
            auditProgress=null
            return result
        }
        val previous=auditProgress?.takeIf{current(it.scope,it.startedAt)}
        val progress:AuditProgress=previous?:run{
            auditProgress=null;completedAuditStart=null;completedAuditRevision=null;completedCheck=null
            if(stopped())return@synchronized interrupted()
            val start=opening?.takeIf{current(it.scope,it.startedAt)}
                ?:Opening(scope,clock,UUID.randomUUID().toString()).also{opening=it}
            if(!start.acknowledged){
                report(ObservationInboxCheck(start.runId,scope.consent.revision.generation,"checking"))
                if(!sameAuthority()){resetAudit();return@synchronized Audit.BLOCKED}
                opening=start.copy(acknowledged=true)
            }
            if(stopped())return@synchronized if(budgetExpired())Audit.MORE else interrupted()
            val status=repo.verifiedObservationStatus()
            if(!sameAuthority()){resetAudit();return@synchronized Audit.BLOCKED}
            ObservationBackground.recordsChanged(app,status.revision)
            if(status.recordedCount !in 0..100_000||status.hasRecorded!=(status.recordedCount>0)){
                resetAudit();return@synchronized Audit.UNCONFIRMED
            }
            val resume=restartPosition(scope)
            auditProgress=AuditProgress(scope,resume,scope.uncertainLegacy || scope.uncertainLocal || status.hasPending || status.hasUnmatchedCanonical,
                start.startedAt,status.revision,status.recordedCount,runId=start.runId,repairTail=resume>0)
            opening=null
            return@synchronized Audit.MORE
        }
        progress.incompleteResult?.let{return@synchronized reportIncomplete(progress,it)}
        if(progress.phoneComplete){
            if(stopped())return@synchronized interrupted()
            val status=repo.verifiedObservationStatus()
            if(try{auditAuthority(localStop)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
            ObservationBackground.recordsChanged(app,status.revision)
            if(status.hasPending||status.hasUnmatchedCanonical||status.revision!=progress.collectionRevision||status.recordedCount!=progress.recordedCount){
                return@synchronized reportIncomplete(progress,Audit.RETRY)
            }
            if(status.hasRecorded!=(status.recordedCount>0)||progress.sourceIds.size!=status.recordedCount||
                progress.candidates!=progress.sourceIds.size||progress.phoneHead!=progress.parsedHead){
                return@synchronized reportIncomplete(progress,Audit.UNCONFIRMED)
            }
            auditProgress=null
            completedCheck=progress.check("verified")
            completedAuditStart=progress.startedAt
            completedAuditRevision=progress.collectionRevision
            return@synchronized Audit.COMPLETE
        }
        fun takePage(checkStop:()->Boolean=stopped):List<AuditRow>? {
            // Late-response verification can finish local rechecks after the transport deadline,
            // but never after scope cancellation. Body reads must use the same fence.
            val cursor=queryObservationInbox(app, progress.last, authority.profile.receipt, bodyOwner = scope.session, stopped = checkStop)
                ?:return null
            val rows=mutableListOf<AuditRow>();var previous=progress.last
            cursor.use{
                val id=it.getColumnIndexOrThrow("_id");val date=it.getColumnIndexOrThrow("date")
                val sender=it.getColumnIndexOrThrow("address");val body=it.getColumnIndexOrThrow("body")
                val sent=it.getColumnIndex("date_sent");val sub=it.getColumnIndex("sub_id")
                while(rows.size<progress.pageSize&&it.moveToNext()){
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
            if(!ObservationCandidate.senderAllowed(row.sender,authority.profile.receipt))continue
            if(ObservationCandidate.excludeFromFinancialCensus(row.sender,row.body,authority.profile.receipt))continue
            // Leave a local uncertainty result, not a reconciliation fingerprint,
            // even when other verified receipt rows share this transport page.
            if(!ObservedReceiptEvidence.isNewCandidate(row.sender,row.body,authority.profile.receipt)){
                uncertain=true;pending++;candidates++;continue
            }
            val decision=ObservationLegacyOwnership.classify(app,owner,row.id,row.received,row.sender,row.body,row.sub)
            if(decision==ObservationLegacyOwnership.Decision.OTHER_SIM)continue
            val key=heldInboxSourceKey(authority.device,owner.collectionId,row.id,row.received)
            candidates++
            phoneHead=newest(phoneHead,Head(row.received,row.id,key))
            decisions[row.id]=decision
            if(decision==ObservationLegacyOwnership.Decision.HOLD){
                uncertain=true;pending++;continue
            }
            val gateway=if(decision==ObservationLegacyOwnership.Decision.OWNED)
                ObservationLegacyOwnership.gatewayEnvelopeId(app,owner,row.id,row.received,row.sender,row.body,row.sent,row.sub) else null
            if(decision==ObservationLegacyOwnership.Decision.OWNED&&gateway==null){uncertain=true;pending++;continue}
            candidatesByKey[key]=row
            requests.add(ObservationReconcileRequest(key,Values.sha256(row.body),row.sender,
                row.sent?.let{Instant.ofEpochMilli(it).toString()},Instant.ofEpochMilli(row.received).toString(),row.sub,gateway))
        }
        val serverRun = progress.runId.takeUnless { progress.repairTail }
        // Use the same JSON and UTF-8 limit as the wire request. Narrowing the phone page
        // keeps its durable cursor, server traversal order and parser checkpoint together.
        if (reconciliationBatchBody(requests, serverRun, includeProcessing = true).toString().toByteArray(Charsets.UTF_8).size > OBSERVATION_RECONCILE_MAX_BYTES) {
            checkContract(rows.size > 1, "invalid_observation_reconciliation")
            auditProgress = progress.copy(pageSize = rows.size / 2, awaiting = null)
            return@synchronized Audit.MORE
        }
        fun verify(items:List<ObservationReconcileRequest>):List<ObservationReconcileReply?> {
            if(items.isEmpty())return emptyList()
            if(stopped())throw InterruptedException()
            if(try{auditAuthority(stopped)?.scope!=scope}catch(_:Exception){true})throw AuditAuthorityChanged()
            return try{
                val replies=repo.reconcileObservations(items,serverRun,includeProcessing = true)
                checkContract(replies.size==items.size&&replies.indices.all{i->replies[i].sourceKey==items[i].sourceKey&&
                    replies[i].state in setOf("matched","missing")&&(replies[i].state=="matched")==(replies[i].sourceId!=null)},
                    "invalid_observation_reconciliation")
                replies
            }catch(error:ApiFailure){
                if(error.code !in setOf("observation_item_conflict","observation_item_unavailable"))throw error
                if (items.size == 1) listOf(null) else {
                    val middle = items.size / 2
                    verify(items.subList(0, middle)) + verify(items.subList(middle, items.size))
                }
            }
        }
        val savedPage=progress.awaiting?.takeIf{it.first==requests}
        val states=try{savedPage?.second ?: verify(requests)}catch(error:Exception){
            // The managed endpoint can exceed the transport deadline when historical custody
            // checks are slow. Resume from exactly the same row with a smaller bounded page.
            if (error is ApiFailure && (error.status == 0 || error.status in 500..599) && rows.size > 1)
                auditProgress = progress.copy(pageSize = maxOf(1, rows.size / 2), awaiting = null)
            if(stopped()||error is AuditAuthorityChanged)return@synchronized interrupted()
            throw error
        }
        val sourceIds=progress.sourceIds.toMutableSet()
        // Current servers bind parser status to the same snapshot as the source identity.
        // A page from an older server still needs the independent parser read for every matched ID.
        val ids=states.mapNotNull{ it?.takeIf { reply -> reply.processingStatus == null }?.sourceId }.distinct().map{SmsSourceRef.Observation(it)}
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
        // Both local reads covered the same row ID, receive time, sender and body. The
        // server match additionally binds the exact source key and body digest. Nothing
        // derived from an excluded or still-unclassified body is sent to reconciliation.
        if(scope.uncertainLocal){
            val confirmed=requests.indices.filter { states[it]?.state=="matched" }.mapTo(mutableSetOf()){requests[it].sourceKey}
            NativeRepository.withObservationOwner(app,scope.session){_,_->
                for(row in rows){
                    if(localStop()||ObservationInboxRevision.snapshot()!=scope.revision)break
                    if(!ObservationCandidate.senderAllowed(row.sender,authority.profile.receipt))continue
                    val decision=when{
                        ObservationCandidate.excludeFromFinancialCensus(row.sender,row.body,authority.profile.receipt) ->
                            ReviewDecision.PROVEN_NOT_FINANCIAL
                        heldInboxSourceKey(authority.device,owner.collectionId,row.id,row.received) in confirmed ->
                            ReviewDecision.ACCEPTED_BY_DURABLE_JOURNAL
                        else -> continue
                    }
                    after.review.resolve(row.id,row.received){decision}
                }
            }
            if(!after.review.hasUnresolved()){
                // The uncertainty bit is part of the audit scope. Establish a fresh
                // traversal from the beginning before claiming completeness.
                resetAudit();return@synchronized Audit.MORE
            }
        }
        val handledRepairs=if(savedPage==null)mutableSetOf() else progress.handledRepairs.toMutableSet()
        fun rememberRepairs(){
            auditProgress=progress.copy(awaiting=requests to states,handledRepairs=handledRepairs.toSet(),queuedRepair=queuedRepair)
        }
        for((index,reply) in states.withIndex()){
            val key=requests[index].sourceKey
            val row=candidatesByKey.getValue(key)
            if(reply==null){uncertain=true;pending++;continue}
            if(reply.state=="missing"){
                uncertain=true;missing++
                if(key in handledRepairs)continue
                // Reuse the acknowledged page after rechecking its exact rows and consent. Each
                // repair still goes through its original source key and durable request journal.
                rememberRepairs()
                if(stopped())return@synchronized if(budgetExpired())Audit.MORE else interrupted()
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
                handledRepairs.add(key)
                rememberRepairs()
                continue
            }
            val source=reply.sourceId
            if(source==null||!sourceIds.add(source)){uncertain=true;pending++;continue}
            if(sourceIds.size>100_000){auditProgress=null;return@synchronized Audit.UNCONFIRMED}
            val parser=reply.processingStatus ?: outcomes[SmsSourceRef.Observation(source)]?.status
            if(parser in setOf("pending","retrying"))parserPending=true
            if(parser in setOf("parsed","duplicate")){
                parsedHead=newest(parsedHead,Head(row.received,row.id,key))
            }else {uncertain=true;pending++}
        }
        if(try{auditAuthority(localStop)?.scope!=scope}catch(_:Exception){true})return@synchronized interrupted()
        val page=progress.copy(last=rows.lastOrNull()?.id?:progress.last,unconfirmed=uncertain,sourceIds=sourceIds,
            awaiting=null,handledRepairs=emptySet(),parserPending=parserPending,candidates=candidates,missing=missing,pending=pending,phoneHead=phoneHead,parsedHead=parsedHead,queuedRepair=queuedRepair)
        savePosition(scope,if(rows.size<progress.pageSize)0 else page.last,progress.repairTail && rows.size==progress.pageSize)
        if(rows.size<progress.pageSize && (progress.repairTail || uncertain)){
            val outcome=when {
                progress.repairTail -> Audit.RETRY
                queuedRepair -> Audit.REPAIRED
                parserPending -> Audit.AWAITING_PARSER
                else -> Audit.UNCONFIRMED
            }
            return@synchronized reportIncomplete(page,outcome)
        }
        auditProgress=page.copy(phoneComplete=rows.size<progress.pageSize)
        Audit.MORE
    }
}
