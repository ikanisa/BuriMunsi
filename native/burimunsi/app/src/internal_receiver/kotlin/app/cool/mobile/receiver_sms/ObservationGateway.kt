package app.cool.mobile.receiver_sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import app.cool.mobile.BuildConfig
import rw.ikanisa.burimunsi.core.GatewayStatus
import rw.ikanisa.burimunsi.core.ObservationJournal
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.core.ObservedReceiptEvidence
import rw.ikanisa.burimunsi.core.QueuedObservationRow
import rw.ikanisa.burimunsi.core.QueuedObservationSnapshot
import rw.ikanisa.burimunsi.core.QueuedObservationPreview
import rw.ikanisa.burimunsi.core.SmsListContent
import rw.ikanisa.burimunsi.core.SmsListSearch
import rw.ikanisa.burimunsi.data.NativeRepository
import java.time.Instant

/** Local status and scheduling only; no SIM, wallet or payment is asserted. */
internal object ObservationGateway {
    fun <T> withCaptureAdmin(context: Context, collection: String?, action: () -> T): T? =
        NativeRepository.withObservationOwner(context) { group, account ->
            if (group == collection && !ObservationConfigStore(context).paused(ObservationOwner(group, account))) action() else null
        }

    fun canOfferPermissions(context: Context): Boolean = NativeRepository.withObservationOwner(context) { group, account ->
        !ObservationConfigStore(context).paused(ObservationOwner(group, account))
    } == true

    private fun permitted(context:Context)=listOf(Manifest.permission.RECEIVE_SMS,Manifest.permission.READ_SMS).all{
        context.checkSelfPermission(it)==PackageManager.PERMISSION_GRANTED
    }
    /** The bounded preview is local only. Retained pre-filter entries stay in
     * custody but are neither searched nor copied into a view. Pausing
     * capture does not end a current Admin’s scoped review of past receipts. */
    fun queued(context:Context,query:String):QueuedObservationSnapshot? {
        if(BuildConfig.IS_QUALIFICATION||query.length>80||query.any{it.isISOControl()})return null
        val session=NativeRepository.observationOwner(context)?:return null
        return NativeRepository.withObservationOwner(context,session){group,account->
            if(!permitted(context))return@withObservationOwner null
            val owner=ObservationOwner(group,account)
            val policyRevision=ObservationInboxPolicyRevision.stable()?:return@withObservationOwner null
            val profile=ObservationConfigStore(context).profile(owner,System.currentTimeMillis())
                ?:return@withObservationOwner null
            val pending=ObservationJournal(ObservationStateStore(context)).pendingSnapshot(owner)
            val rows=pending.entries.asSequence().map{it.observation}.filter{value->
                ObservedReceiptEvidence.isNewCandidate(value.rawSender,value.rawBody,profile.receipt)&&
                    SmsListSearch.matches(value.requestId,SmsListContent(value.rawSender,value.rawBody),query)
            }.map{value->
                QueuedObservationRow(value.requestId,value.rawSender,value.inboxReceivedAt?:value.capturedAt,QueuedObservationPreview.from(value.rawBody))
            }.sortedWith(compareByDescending<QueuedObservationRow>{Instant.parse(it.at)}.thenBy{it.id}).toList()
            if(!permitted(context)||!profile.current(System.currentTimeMillis())||
                ObservationInboxPolicyRevision.stable()!=policyRevision)null
            else QueuedObservationSnapshot(session,pending.revision,rows,policyRevision)
        }
    }
    /** Owner -> policy -> journal fence, as for a scoped inbox reveal. */
    fun publishQueued(context:Context,snapshot:QueuedObservationSnapshot,publish:()->Unit):Boolean =
        NativeRepository.withObservationOwner(context,snapshot.session){group,account->
            val revision=snapshot.policyRevision?:return@withObservationOwner false
            if(!permitted(context))return@withObservationOwner false
            val profile=ObservationConfigStore(context).profile(ObservationOwner(group,account),System.currentTimeMillis())
                ?:return@withObservationOwner false
            ObservationInboxPolicyRevision.whileCurrent(revision){
                ObservationJournal(ObservationStateStore(context)).ifRevision(snapshot.revision){
                    if(!permitted(context)||!profile.current(System.currentTimeMillis()))false else{publish();true}
                }?:false
            }?:false
        }?:false
    fun start(context:Context) {
        if(!BuildConfig.IS_QUALIFICATION&&NativeRepository.observationOwner(context)!=null)
            ObservationBackground.ensure(context.applicationContext)
    }
    fun sync(context:Context) {
        check(!BuildConfig.IS_QUALIFICATION&&NativeRepository.observationOwner(context)!=null){"Current administrator session required"}
        ObservationBackground.ensure(context.applicationContext)
        ObservationBackground.signal(context.applicationContext)
    }
    fun setPaused(context:Context,paused:Boolean) {
        withControl(context){owner,config->config.setPaused(owner,paused)}
    }
    /** Caller may hold the legacy receiver lock; the session lock is acquired second. */
    fun <T> withControl(context:Context,action:(ObservationOwner,ObservationConfigStore)->T):T {
        check(!BuildConfig.IS_QUALIFICATION){"Offline qualification only"}
        return try{
            NativeRepository.withObservationOwner(context){group,account->
                action(ObservationOwner(group,account),ObservationConfigStore(context))
            }?:error("Current administrator session required")
        }finally{
            // A partial protected write still requires consent reconciliation.
            // Persisted periodic recovery remains the fallback after process death.
            if(NativeRepository.observationOwner(context)!=null)
                try{ObservationBackground.ensure(context.applicationContext)}catch(_:Exception){}
        }
    }
    fun status(context:Context):GatewayStatus {
        if(BuildConfig.IS_QUALIFICATION)return GatewayStatus(false,false,null,0,null,null,null,"qualification_offline",observationMode=true)
        return NativeRepository.withObservationOwner(context){group,account->
            val owner=ObservationOwner(group,account);val config=ObservationConfigStore(context)
            val paused=config.paused(owner)
            val permitted=listOf(Manifest.permission.RECEIVE_SMS,Manifest.permission.READ_SMS,Manifest.permission.READ_PHONE_STATE).all{
                context.checkSelfPermission(it)==PackageManager.PERMISSION_GRANTED
            }
            val consent=config.consent(owner)
            val profile=config.profile(owner,System.currentTimeMillis())
            val pending=ObservationJournal(ObservationStateStore(context)).pending(owner).size
            val problem=when {
                !permitted->"permission_required"
                paused->"observation_paused"
                consent?.canCapture(true)!=true||profile==null->"observation_waiting"
                else->null
            }
            GatewayStatus(true,!paused,null,pending,null,null,null,problem,
                approvedSenders=profile?.receipt?.senders?.sorted(),observationMode=true)
        }?:GatewayStatus(false,false,null,0,null,null,null,"authorization_required",observationMode=true)
    }
}
