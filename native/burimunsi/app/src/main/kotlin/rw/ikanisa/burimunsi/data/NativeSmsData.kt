package rw.ikanisa.burimunsi.data

import org.json.JSONArray
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.*

/** Observation upload, recovery reads and audited SMS disclosure. */
internal class NativeSmsData(
    session: NativeSessionRequests,
    private val installationProfile: () -> String?,
    private val recordReadOwner: Any,
) : NativeSessionRequests by session {
    private fun observationSession(protectedListing:Boolean=false):SessionWitness {
        val witness=ownedSession()
        return authority.withCurrent(witness){
            val who=operator?:throw ApiFailure("session_unavailable",401)
            checkContract(installationProfile()=="internal_receiver"&&who.role==Role.ADMIN&&
                who.expiresAt>System.currentTimeMillis()&&(!protectedListing||Capability.SMS.key in who.capabilities),"access_denied")
            witness
        }
    }
    fun observationProfile():JSONObject = JSONObject(requestOwned(observationSession(),"GET","/sms/observation-profile"))
    fun observationConsent():ObservationConsentRevision {
        val value=JSONObject(requestOwned(observationSession(),"GET","/sms/observation-consent"))
        return ObservationConsentRevision(value.getBoolean("enabled"),value.getLong("generation"))
    }
    fun setObservationConsent(revision:ObservationConsentRevision):ObservationConsentRevision {
        checkContract(revision.generation in 1..ObservationConsent.MAX_GENERATION,"invalid_consent_generation")
        val body=JSONObject().put("enabled",revision.enabled).put("generation",revision.generation)
        val value=JSONObject(requestOwned(observationSession(),"POST","/sms/observation-consent",body))
        val result=ObservationConsentRevision(value.getBoolean("enabled"),value.getLong("generation"))
        checkContract(result==revision,"invalid_consent_response")
        return result
    }
    fun recoverHeldObservation(observation:SmsObservation,generation:Long):Boolean {
        val body=observationBody(observation).put("expectedConsentGeneration",generation)
        val value=JSONObject(requestOwned(observationSession(),"POST","/sms/observations/recover-held",body))
        val ack=ObservationAck(value.getString("requestId"),value.getString("sourceId"),value.getString("bodySha256"),
            value.getString("status"),value.getInt("financialEffects"))
        checkContract(value.getString("autoProcessing")=="held"&&ObservationAcknowledgement.matches(observation,ack),"invalid_observation_ack")
        return true
    }
    fun submitObservation(observation:SmsObservation):ObservationAck {
        val value=JSONObject(requestOwned(observationSession(),"POST","/sms/observations",observationBody(observation)))
        val ack=ObservationAck(value.getString("requestId"),value.getString("sourceId"),value.getString("bodySha256"),
            value.getString("status"),value.getInt("financialEffects"))
        checkContract(ObservationAcknowledgement.matches(observation,ack),"invalid_observation_ack")
        return ack
    }
    private fun reconcileReply(key:String,row:JSONObject,latest:String?=null,includeProcessing:Boolean=false):ObservationReconcileReply {
        val state=row.getString("state")
        val source=row.nullString("sourceId")
        checkContract(row.getString("sourceKey")==key&&state in setOf("matched","missing")&&(state=="matched")==(source!=null)&&
            (source==null||runCatching{Values.requestId(source)==source}.getOrDefault(false))&&
            (latest==null||runCatching{Values.requestId(latest)==latest}.getOrDefault(false)),"invalid_observation_reconciliation")
        val needsStatus = includeProcessing && source != null
        checkContract(row.has("processingStatus") == needsStatus, "invalid_observation_reconciliation")
        val status = if (needsStatus) row.getString("processingStatus") else null
        checkContract(status == null || status in ObservationProcessing.statuses, "invalid_observation_reconciliation")
        return ObservationReconcileReply(key,state,source,latest,status)
    }
    /** Compare scoped receipt identities; these requests carry no message bodies and cannot acknowledge or post a receipt. */
    private fun <T> readObservationProof(method:String,path:String,body:JSONObject?=null,decode:(JSONObject)->T):T {
        val witness=observationSession()
        val value=JSONObject(requestOwned(witness,method,"/sms/observations/$path",body))
        return authority.withCurrent(witness){
            checkContract(value.getString("groupId")==groupId,"invalid_observation_reconciliation")
            decode(value)
        }
    }
    fun reconcileObservation(request:ObservationReconcileRequest):ObservationReconcileReply =
        readObservationProof("POST","reconcile",reconciliationItem(request)){value->
            reconcileReply(request.sourceKey,value,value.nullString("latestRecordedSourceId"))
        }
    @Volatile private var combinedReconciliationAvailable = true

    fun reconcileObservations(requests:List<ObservationReconcileRequest>,runId:String?=null,includeProcessing:Boolean=false):List<ObservationReconcileReply> {
        checkContract(requests.size in 1..OBSERVATION_RECONCILE_MAX_ITEMS && requests.map { it.sourceKey }.distinct().size == requests.size,
            "invalid_observation_reconciliation")
        fun read(combined: Boolean): List<ObservationReconcileReply> {
            val body = reconciliationBatchBody(requests, runId, combined)
            checkContract(body.toString().toByteArray(Charsets.UTF_8).size <= OBSERVATION_RECONCILE_MAX_BYTES,
                "invalid_observation_reconciliation")
            return readObservationProof("POST", "reconcile-batch", body) { value ->
                val rows = value.getJSONArray("items")
                checkContract(rows.length() == requests.size, "invalid_observation_reconciliation")
                requests.mapIndexed { index, request -> reconcileReply(request.sourceKey, rows.getJSONObject(index), includeProcessing = combined) }
            }
        }
        if (!includeProcessing || !combinedReconciliationAvailable) return read(false)
        return try {
            read(true)
        } catch (error: ApiFailure) {
            if (error.status != 400 || error.code !in setOf("contract_unknown_field", "invalid_request")) throw error
            // Old servers reject the option before running the page. The fallback still
            // binds every source and requires a separate authenticated parser-status read.
            read(false).also { combinedReconciliationAvailable = false }
        }
    }
    fun observationReconcileStatus():ObservationReconcileStatus = readObservationProof("GET","reconcile-status"){value->
        val count=value.getInt("recordedCount");val recorded=value.getBoolean("hasRecorded");val revision=value.getString("revision")
        checkContract(count in 0..100_000&&recorded==(count>0)&&Regex("[a-f0-9]{64}").matches(revision),"invalid_observation_reconciliation")
        ObservationReconcileStatus(value.getBoolean("hasPending"),recorded,count,revision,value.getBoolean("hasUnmatchedCanonical"))
    }
    fun verifiedObservationStatus(): ObservationReconcileStatus = readObservationProof("GET", "reconcile-verified-status?scope=installation") { value ->
        val count = value.getInt("recordedCount")
        val recorded = value.getBoolean("hasRecorded")
        val revision = value.getString("revision")
        checkContract(value.getString("scope") == "verified_installation" && count in 0..100_000 &&
            recorded == (count > 0) && Regex("[a-f0-9]{64}").matches(revision), "invalid_observation_reconciliation")
        ObservationReconcileStatus(value.getBoolean("hasPending"), recorded, count, revision, value.getBoolean("hasUnmatchedCanonical"))
    }
    fun reportInboxCheck(check: ObservationInboxCheck) {
        val body = JSONObject().put("runId", check.runId).put("expectedConsentGeneration", check.expectedConsentGeneration)
            .put("state", check.state).put("candidateCount", check.candidateCount).put("missingCount", check.missingCount)
            .put("pendingCount", check.pendingCount).put("phoneLatestKey", check.phoneLatestKey ?: JSONObject.NULL)
            .put("parsedLatestKey", check.parsedLatestKey ?: JSONObject.NULL)
            .put("collectionRevision", check.collectionRevision ?: JSONObject.NULL)
        readObservationProof("POST", "inbox-check", body) { value ->
            checkContract(value.getString("runId") == check.runId && value.getString("state") == check.state,
                "invalid_observation_reconciliation")
        }
    }
    /** A quarantine page is a distinct source stream, never a canonical SMS/payment page. */
    fun observationPage(q:String="",cursor:String?=null,limit:Int?=null):Page<ObservationListRow> {
        val witness = observationSession(protectedListing=true)
        val path = "/sms/observations" + query(
            mapOf("q" to q, "cursor" to cursor, "limit" to limit?.coerceIn(1, 100)?.toString()),
        )
        val data = requestOwned(witness, "GET", path)
        return authority.withCurrent(witness) { decodeObservationPage(data) }
    }
    fun observationPage(
        listing: ListingQuery,
        cursor: String?,
        scope: RecordReadScope?,
        limit: Int,
    ): Page<ObservationListRow> {
        val path = listingPath("/sms/observations", ListingTarget.OBSERVATIONS, listing, cursor, limit = limit)
        val witness = observationSession(protectedListing=true)
        val data = scope?.read(recordReadOwner, path) ?: requestOwned(witness, "GET", path)
        return authority.withCurrent(witness) { decodeObservationPage(data) }
    }
    private fun decodeObservationPage(data:String):Page<ObservationListRow> =
        page(data){row->
            checkedDto("observationPageItem",row)
            checkContract(row.getString("sourceKind")=="observation"&&row.getString("id")==row.getString("sourceId")&&
                row.getString("groupId")==groupId&&row.getString("status")=="source_unresolved"&&row.counter("financialEffects")==0L,"invalid_observation_source")
            ObservationListRow(SmsSourceRef.Observation(Values.id(row.getString("sourceId"))),groupId,row.getString("at"))
        }
    fun observationProcessing(sources:List<SmsSourceRef.Observation>):Map<SmsSourceRef.Observation,ObservationProcessing>{
        checkContract(sources.isNotEmpty()&&sources.size<=100&&sources.distinct().size==sources.size,"invalid_observation_source")
        val ids=JSONArray();sources.forEach{ids.put(Values.id(it.id))}
        val value=JSONObject(requestOwned(observationSession(),"POST","/sms/observations/processing-status",JSONObject().put("sourceIds",ids)))
        val rows=value.getJSONArray("statuses")
        checkContract(value.getString("groupId")==groupId&&rows.length()==sources.size,"invalid_observation_source")
        return sources.mapIndexed{index,source->
            val row=rows.getJSONObject(index);val status=row.getString("status");val retry=row.getBoolean("canRetry")
            checkContract(row.getString("sourceId")==source.id&&status in ObservationProcessing.statuses&&
                (!retry||status in setOf("retrying","needs_review")),"invalid_observation_source")
            source to ObservationProcessing(status,retry)
        }.toMap()
    }
    fun retryObservation(source:SmsSourceRef.Observation,requestId:String):String{
        val id=Values.id(source.id)
        val value=JSONObject(requestOwned(observationSession(protectedListing=true),"POST","/sms/observations/$id/retry",JSONObject().put("requestId",requestId)))
        checkContract(value.getString("groupId")==groupId&&value.getString("sourceId")==id&&value.getString("requestId")==requestId&&
            value.getString("result") in setOf("scheduled","not_eligible"),"invalid_observation_source")
        return value.getString("result")
    }
    /** Only an explicitly typed observation can use this audited disclosure path. */
    fun revealObservation(source:SmsSourceRef.Observation,reason:String):ObservationDisclosure {
        val normalized=RawDisclosureInput.reason(reason)?:throw ApiFailure("reason_required",400)
        val id=Values.id(source.id)
        val row=JSONObject(requestOwned(observationSession(protectedListing=true),"POST","/sms/observations/$id/reveal",JSONObject().put("reason",normalized).put("displayHintsVersion",1)))
        checkedDto("observationReveal.data",row)
        checkContract(row.getString("sourceKind")=="observation"&&row.getString("sourceId")==id&&row.getString("groupId")==groupId&&
            row.getString("status")=="source_unresolved"&&row.counter("financialEffects")==0L,"invalid_observation_source")
        checkContract(row.has("displayHints"),"invalid_observation_source")
        val body=row.getString("rawBody")
        val hints=if(row.isNull("displayHints"))null else row.getJSONObject("displayHints").let{h->
            val values=h.getJSONArray("hints")
            ObservationHintSet(h.getInt("schemaVersion"),h.getString("kind"),h.getString("profileVersion"),h.getString("profileSha256"),h.getString("bodySha256"),
                (0 until values.length()).map{index->val v=values.getJSONObject(index);ObservationHint(v.getString("kind"),v.getString("text"),v.getInt("start"),v.getInt("end"))})
        }
        checkContract(hints==null||ObservationHintValidation.valid(body,hints),"invalid_observation_source")
        return ObservationDisclosure(source,row.getString("at"),row.getString("sender"),body,hints)
    }
    /** Audited, explicit disclosure only. Never cache/journal the reason or body. */
    fun raw(id:String,reason:String):RawSms{
        val normalized=RawDisclosureInput.reason(reason)?:throw ApiFailure("reason_required",400)
        val witness=ownedSession()
        val j=JSONObject(requestOwned(witness,"POST","/sms/"+Values.id(id)+"/reveal",JSONObject().put("reason",normalized)))
        return RawSms(j.getString("id"),j.getString("sender"),j.getString("at"),j.getString("rawBody"),j.nullString("transactionId"),j.optionalNullString("simLabel"))
    }
}
