package app.cool.mobile.receiver_sms

import android.content.Context
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.core.ReceiptCandidate
import rw.ikanisa.burimunsi.core.Values
import java.time.Instant

/** Unknown or paused legacy ownership never becomes authority for a new source. */
internal object ObservationLegacyOwnership {
    enum class Decision { OWNED, UNOWNED, OTHER_SIM, HOLD }

    private fun classifyLocked(context:Context,store:MomoGatewayStore,state:JSONObject?,owner:ObservationOwner,id:Long,
        receivedAt:Long?,sender:String,body:String,subscription:Int?):Decision {
        if(state?.has("control_transition")==true)return Decision.HOLD
        if(state==null)return ObservationReceivingSim.classify(context,owner,subscription)
        if(!state.has("binding"))return if(state.opt("receiver_retired")==true||state.opt("retirement_pending")==true)Decision.HOLD else ObservationReceivingSim.classify(context,owner,subscription)
        val binding=state.optJSONObject("binding")?:return Decision.HOLD
        if(binding.opt("collection_id")!=owner.collectionId)return Decision.HOLD
        return store.withCurrentBinding(binding){
            val current=store.read()?:return@withCurrentBinding Decision.HOLD
            val verified=current.optJSONObject("binding")?:return@withCurrentBinding Decision.HOLD
            val profile=BuriReceiverProfile.current(verified)?:return@withCurrentBinding Decision.HOLD
            when(BuriCapturePolicy.route(context,verified,subscription)){
                BuriReceiverReliability.Route.OTHER_SIM->Decision.OTHER_SIM
                BuriReceiverReliability.Route.HOLD_SIM,BuriReceiverReliability.Route.HOLD_PROFILE->Decision.HOLD
                BuriReceiverReliability.Route.ACCEPT->{
                    if(!ReceiptCandidate.accepts(sender,body,profile))return@withCurrentBinding Decision.UNOWNED
                    val created=runCatching{Instant.parse(verified.getString("created_at")).toEpochMilli()}.getOrNull()
                    val baseline=if(current.has("inbox_binding_baseline"))current.getLong("inbox_binding_baseline")else null
                    if(receivedAt==null||created==null)Decision.HOLD
                    else if(BuriReceiverReliability.inboxAfterBinding(id,baseline,receivedAt,created))Decision.OWNED else Decision.UNOWNED
                }
            }
        }?:Decision.HOLD
    }
    /** The callback includes any queue write and cursor advance; do not perform network I/O here. */
    fun <T> withDecision(context:Context,owner:ObservationOwner,id:Long,receivedAt:Long?,sender:String,body:String,
        subscription:Int?,action:(Decision)->T):T? = try {
        val app=context.applicationContext;val store=MomoGatewayStore(app)
        store.withObservationState{state->action(classifyLocked(app,store,state,owner,id,receivedAt,sender,body,subscription))}
    }catch(_:Exception){null}
    fun classify(context:Context,owner:ObservationOwner,id:Long,receivedAt:Long?,sender:String,body:String,subscription:Int?):Decision =
        withDecision(context,owner,id,receivedAt,sender,body,subscription){it}?:Decision.HOLD

    /** Lock order is legacy receiver, then observation/session; no network under this lock. */
    fun <T> withoutControlTransition(context:Context,action:()->T):T? = try {
        MomoGatewayStore(context.applicationContext).withObservationState{state->
            if(state?.has("control_transition")==true)null else action()
        }
    }catch(_:Exception){null}
    fun controlTransitionClear(context:Context):Boolean = withoutControlTransition(context){true}==true

    /** Use the paired gateway's idempotency identity and transport for receipts it already owns. */
    fun gatewayEnvelopeId(context:Context,owner:ObservationOwner,row:Long,received:Long,sender:String,body:String,
        sent:Long?,subscription:Int?):String? {
        val store=MomoGatewayStore(context)
        return store.withObservationState{state->
            if(classifyLocked(context,store,state,owner,row,received,sender,body,subscription)!=Decision.OWNED)return@withObservationState null
            val binding=state?.optJSONObject("binding")?:return@withObservationState null
            val installation=store.existingInstallationId()?:return@withObservationState null
            MomoGatewayPolicy.captureId(installation,binding.getString("id"),sender,body,sent?:received,subscription)
        }
    }
    fun repairGateway(context:Context,owner:ObservationOwner,row:Long,received:Long,sender:String,body:String,
        sent:Long?,subscription:Int?,expectedId:String):Boolean {
        val store=MomoGatewayStore(context)
        return store.withObservationState{state->
            if(classifyLocked(context,store,state,owner,row,received,sender,body,subscription)!=Decision.OWNED)return@withObservationState false
            val binding=state?.optJSONObject("binding") ?: return@withObservationState false
            val installation=store.existingInstallationId() ?: return@withObservationState false
            val carrierTime=sent?:received
            val id=MomoGatewayPolicy.captureId(installation,binding.getString("id"),sender,body,carrierTime,subscription)
            if(id!=expectedId)return@withObservationState false
            val at=Instant.ofEpochMilli(carrierTime).toString()
            val envelope=JSONObject().put("id",id).put("owner_user_id",binding.getString("owner_user_id"))
                .put("raw_sender",sender).put("raw_body",body).put("gateway_binding_id",binding.getString("id"))
                .put("gateway_binding_version",binding.getInt("version")).put("service_centre_at",at).put("received_at_device",at)
                .put("captured_at",Instant.now().toString()).put("inbox_received_at",Instant.ofEpochMilli(received).toString())
                .put("subscription_id",subscription ?: JSONObject.NULL).put("source_mode","catch_up")
                .put("source_unresolved",false).put("inbox_row_id",row).put("complete",false)
            store.withCurrentBinding(binding){
                val added=SmsQueueStore(context).appendIfCapacity(envelope,MomoGatewayPolicy.MAX_PENDING,
                    MomoGatewayPolicy.LIVE_CAPTURE_RESERVE,confirmedMissingId=id)
                added==SmsQueueStore.AppendResult.STORED || added==SmsQueueStore.AppendResult.DUPLICATE
            }==true
        }.also{if(it)MomoGatewayJobs.signal(context)}
    }

    /** A routing match alone is not proof that the canonical receiver retained this row. */
    fun retained(context:Context,sender:String,body:String,serviceCentreAt:Long?,receivedAt:Long?,subscription:Int?):Boolean = try {
        val app=context.applicationContext;val store=MomoGatewayStore(app)
        store.withObservationState{state->
            val binding=state?.optJSONObject("binding")?:return@withObservationState false
            val installation=store.existingInstallationId()?:return@withObservationState false
            val at=serviceCentreAt?.takeIf{it>0}?:receivedAt?.takeIf{it>0}?:return@withObservationState false
            val bindingId=binding.getString("id");val version=binding.getInt("version")
            val captureId=MomoGatewayPolicy.captureId(installation,bindingId,sender,body,at,subscription)
            SmsQueueStore(app).hasGatewaySource(binding.getString("owner_user_id"),captureId,bindingId,version,Values.sha256(body))
        }
    }catch(_:Exception){false}
}
