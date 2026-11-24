package app.cool.mobile.receiver_sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import app.cool.mobile.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ObservationConsentState
import rw.ikanisa.burimunsi.core.ObservationCursor
import rw.ikanisa.burimunsi.core.ObservationJournal
import rw.ikanisa.burimunsi.core.ObservationCandidate
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.core.ObservationProfile
import rw.ikanisa.burimunsi.core.ObservationSessionOwner
import rw.ikanisa.burimunsi.core.ObservationSourceIdentity
import rw.ikanisa.burimunsi.core.Values
import rw.ikanisa.burimunsi.core.ObservationReconcileRequest
import rw.ikanisa.burimunsi.core.SmsObservation
import java.util.UUID
import rw.ikanisa.burimunsi.core.checkContract
import rw.ikanisa.burimunsi.data.NativeRepository
import rw.ikanisa.burimunsi.storage.SecureStore
import java.time.Instant

internal fun observationInboxPermitted(app: Context): Boolean =
    app.checkSelfPermission(Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED &&
        app.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

internal fun heldInboxSourceKey(device: String, collection: String, rowId: Long, received: Long): String =
    ObservationSourceIdentity.reinstallStable(device, collection, rowId, Instant.ofEpochMilli(received).toString())

/** Encrypted legacy hold and original cursor compatibility. */
internal class ObservationHeldInbox(
    private val app: Context,
    private val config: ObservationConfigStore,
) {
    private companion object {
        const val MAX_HELD = 100_000
        // The v57/v58 count ceiling was 100,000, but their SecureStore writer
        // cannot persist plaintext above 2,000,000 UTF-8 bytes. Each genuine
        // nonfirst digest consumes 67 bytes (comma + quotes + 64 hex digits).
        const val PREDECESSOR_MAX_BYTES = 2_000_000
        const val MAX_EXISTING_HELD = PREDECESSOR_MAX_BYTES / 67
        val heldKey = Regex("[a-f0-9]{64}")
    }

    private val cursorStore = SecureStore(app, "observation-cursors")

    data class PreviousCursor(val profileLastId: Long?, val scanStart: Long)

    private fun legacyStore(collection:String)=SecureStore(app,"observation-legacy-held-"+Values.sha256(collection))
    private fun priorCursorStore(owner:ObservationOwner)=SecureStore(app,"observation-prior-cursor-held-"+
        Values.sha256(listOf(owner.collectionId,owner.accountId).joinToString(""){"${it.length}:$it"}))
    fun legacyExists(collection:String)=legacyStore(collection).read()!=null
    fun deviceId():String?=Settings.Secure.getString(app.contentResolver,Settings.Secure.ANDROID_ID)

    fun holdsExisting(profile: ObservationProfile, collection: String): Boolean =
        BuildConfig.CLOUD_HOLD_EXISTING_INBOX || profile.legacyHold == true || legacyExists(collection)

    fun previousCursor(owner: ObservationOwner, profileFingerprint: String): PreviousCursor {
        checkContract(Regex("[a-f0-9]{64}").matches(profileFingerprint),"observation_cursor_unavailable")
        val root=cursorStore.read()?.let(::JSONObject)?:JSONObject().put("items",JSONArray())
        checkContract(root.keys().asSequence().toSet()==setOf("items"),"observation_cursor_unavailable")
        val rows=root.getJSONArray("items");checkContract(rows.length()<=50,"observation_cursor_unavailable")
        var last:Long?=null;var latest=0L;val seen=mutableSetOf<Pair<ObservationOwner,String>>()
        for(index in 0 until rows.length()){
            val row=rows.getJSONObject(index)
            checkContract(row.keys().asSequence().toSet()==setOf("collectionId","accountId","profileFingerprint","lastId"),"observation_cursor_unavailable")
            val scope=ObservationOwner(row.getString("collectionId"),row.getString("accountId"));val id=row.getLong("lastId");val fingerprint=row.getString("profileFingerprint")
            checkContract(scope.valid()&&Regex("[a-f0-9]{64}").matches(fingerprint)&&seen.add(scope to fingerprint)&&id>=0,"observation_cursor_unavailable")
            if(scope==owner){latest=maxOf(latest,id);if(fingerprint==profileFingerprint)last=id}
        }
        // Include a journal write that survived before its cursor update, even if an
        // older profile has a cursor. Unreadable protected state throws and holds.
        latest=maxOf(latest,ObservationJournal(ObservationStateStore(app)).latestSeenRow(owner)?:0L)
        // Every approved profile reconsiders at most the retained recent overlap.
        return PreviousCursor(last, ObservationCursor.start(last, latest))
    }

    /** Freeze the original inbox's opaque row identities and enrollment in encrypted storage.
     * The online audit separately admits eligible historical evidence under held custody. */
    fun snapshot(session:ObservationSessionOwner,profile:ObservationProfile,consent:ObservationConsentState,
        control:ObservationConfigStore.Control,stopped:()->Boolean):Pair<String,Set<String>>? {
        val owner=session.owner;val device=deviceId()?:return null
        val deviceScope=Values.sha256(listOf("burimunsi-held-device-v1",owner.collectionId,device.lowercase()).joinToString(""){"${it.length}:$it"})
        // Validate even for an empty inbox: a broken ID must not establish a false baseline.
        heldInboxSourceKey(device,owner.collectionId,1,1)
        // The Cloud application is a separate installation, but the phone inbox
        // can still contain receipts handled by the old installation. Hold the
        // exact existing rows at the first authorized scan even if Cloud has no
        // legacy records. Later insertions remain eligible for normal capture.
        val legacy=holdsExisting(profile, owner.collectionId)
        val store=if(legacy)legacyStore(owner.collectionId)else priorCursorStore(owner)
        val existing=store.read()
        if(existing!=null){
            checkContract(existing.length<=PREDECESSOR_MAX_BYTES&&
                (existing.all{it.code<128}||existing.toByteArray(Charsets.UTF_8).size<=PREDECESSOR_MAX_BYTES),
                "observation_cursor_unavailable")
            val value=JSONObject(existing);checkContract(value.keys().asSequence().toSet()==setOf("collectionId","deviceScope","keys")&&
                value.get("collectionId")==owner.collectionId&&value.get("deviceScope")==deviceScope,"observation_cursor_unavailable")
            val list=value.getJSONArray("keys");checkContract(list.length()<=MAX_EXISTING_HELD,"observation_cursor_unavailable")
            val keys=linkedSetOf<String>()
            for(index in 0 until list.length()){
                val key=list.get(index) as? String
                checkContract(key!=null&&heldKey.matches(key)&&keys.add(key),"observation_cursor_unavailable")
            }
            return device to keys
        }
        if(profile.legacyHold==null)return null
        val prior=if(legacy)null else previousCursor(owner, profile.fingerprint()).scanStart
        val ambiguous=if(legacy)emptySet() else ObservationStateStore(app).read().seen
            .filter{it.owner.collectionId==owner.collectionId&&it.inboxReceivedAt==null}.map{it.inboxRowId}.toSet()
        val cursor=queryObservationInbox(app,0,profile.receipt)?:return null
        val keys=linkedSetOf<String>()
        cursor.use{
            val idCol=it.getColumnIndexOrThrow("_id");val dateCol=it.getColumnIndexOrThrow("date")
            val senderCol=it.getColumnIndexOrThrow("address")
            while(it.moveToNext()){
                if(it.isNull(senderCol)||!ObservationCandidate.senderAllowed(it.getString(senderCol),profile.receipt))continue
                if(stopped()||!observationInboxPermitted(app)||it.isNull(idCol))return null
                val id=it.getLong(idCol)
                if(prior!=null&&id>prior&&id !in ambiguous)continue
                if(it.isNull(dateCol))return null
                val date=it.getLong(dateCol)
                checkContract(id>0&&date>0&&keys.size<MAX_HELD,"observation_cursor_unavailable")
                checkContract(keys.add(heldInboxSourceKey(device,owner.collectionId,id,date)),"observation_cursor_unavailable")
            }
        }
        val enrollment=enrollmentStore(owner,device)
        val encoded=JSONObject().put("collectionId",owner.collectionId).put("deviceScope",deviceScope)
            .put("keys",JSONArray().also{array->keys.forEach{array.put(it)}}).toString()
        val saved=ObservationLegacyOwnership.withoutControlTransition(app){
            NativeRepository.withObservationOwner(app,session){group,account->
                if(stopped()||!observationInboxPermitted(app)||owner!=ObservationOwner(group,account)||config.controlState(owner)!=control||
                    config.consent(owner)!=consent||!consent.canCapture(observationInboxPermitted(app))||config.profile(owner,System.currentTimeMillis())!=profile||
                    deviceId()!=device||store.read()!=null||(!legacy&&(
                        previousCursor(owner, profile.fingerprint()).scanStart!=prior||ObservationStateStore(app).read().seen
                            .filter{it.owner.collectionId==owner.collectionId&&it.inboxReceivedAt==null}.map{it.inboxRowId}.toSet()!=ambiguous)))false
                else {
                    val enrollmentData=enrollmentRecord(owner,device,consent,profile,keys)
                    // Write scope first. A crash before the immutable inbox snapshot leaves no eligible row.
                    enrollment.write(enrollmentData)
                    if(enrollment.read()!=enrollmentData)false else {store.write(encoded);store.read()==encoded}
                }
            }?:false
        }?:false
        return if(saved)device to keys else null
    }
    private fun enrollmentStore(owner:ObservationOwner,device:String)=SecureStore(app,"observation-held-enrollment-"+
        Values.sha256(listOf(owner.collectionId,owner.accountId,device).joinToString(""){"${it.length}:$it"}))

    private fun enrollmentRecord(owner:ObservationOwner,device:String,consent:ObservationConsentState,profile:ObservationProfile,keys:Set<String>):String =
        JSONObject().put("account",owner.accountId).put("collection",owner.collectionId).put("device",Values.sha256(device))
            .put("installation",MomoGatewayStore(app).existingInstallationId()).put("generation",consent.revision.generation)
            .put("profile",profile.fingerprint()).put("keys",Values.sha256(keys.sorted().joinToString(""))).toString()

    /** Retain a confirmed missing baseline row through the historical route under its recorded consent.
     * The secure marker binds the exact envelope before either a first send or a retry. */
    fun recoverMissing(repo:NativeRepository,session:ObservationSessionOwner,consent:ObservationConsentState,profile:ObservationProfile,
        device:String,key:String,request:ObservationReconcileRequest,body:String):Boolean {
        val owner=session.owner
        val installation=MomoGatewayStore(app).existingInstallationId() ?: return false
        if(HeldRecoveryJournal.protects(app,owner,installation,Values.sha256(device),key))return false
        val control=config.controlState(owner)
        fun authorized():Boolean {
            if(control.paused || config.controlState(owner)!=control || config.consent(owner)!=consent ||
                !consent.canCapture(observationInboxPermitted(app)) || config.profile(owner,System.currentTimeMillis())!=profile ||
                NativeRepository.observationOwner(app)!=session || deviceId()!=device)return false
            val held=snapshot(session,profile,consent,control){false}?.second ?: return false
            if(key !in held)return false
            val original=enrollmentStore(owner,device).read()
            // Old baseline files bind collection, device and row key but carry no original grant.
            // A new current-consent review is distinct from replaying an uncertain legacy command.
            return original==null || original==enrollmentRecord(owner,device,consent,profile,held)
        }
        if(!authorized())return false
        val digest=Values.sha256(listOf(key,request.rawSender,request.bodySha256,request.inboxReceivedAt,
            request.serviceCentreAt.orEmpty(),request.subscriptionId.toString()).joinToString(""){"${it.length}:$it"})
        val marker=SecureStore(app,"observation-held-admission-"+Values.sha256(listOf(owner.accountId,installation,key)
            .joinToString(""){"${it.length}:$it"}))
        val prior=marker.read()
        val data=prior?.let(::JSONObject) ?: JSONObject().put("requestId",UUID.randomUUID().toString())
            .put("generation",consent.revision.generation).put("digest",digest).put("capturedAt",Instant.now().toString())
            .put("basis",if(enrollmentStore(owner,device).read()==null)"current_consent_review" else "original_enrollment")
        if(data.getLong("generation")!=consent.revision.generation || data.getString("digest")!=digest)return false
        val item=SmsObservation(data.getString("requestId"),request.rawSender,body,"catch_up",false,data.getString("capturedAt"),
            request.serviceCentreAt,request.inboxReceivedAt,request.subscriptionId,key)
        if(prior==null){val encoded=data.toString();marker.write(encoded);if(marker.read()!=encoded)return false}
        if(!authorized())return false
        return repo.recoverHeldObservation(item,consent.revision.generation)
    }

}
