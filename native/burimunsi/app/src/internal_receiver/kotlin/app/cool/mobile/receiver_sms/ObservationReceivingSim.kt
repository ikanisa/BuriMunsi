package app.cool.mobile.receiver_sms

import android.content.Context
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.core.Values

internal object ObservationReceivingSim {
    /** The standalone internal receiver may enroll a single active SIM under confirmed consent.
     * Persist its subscription across restarts. A replacement or ambiguous subscription needs
     * renewed authority. Paired gateways always use their explicit server binding. */
    fun classify(context:Context,owner:ObservationOwner,subscription:Int?):ObservationLegacyOwnership.Decision {
        val active=BuriCapturePolicy.activeSubscriptions(context) ?: return ObservationLegacyOwnership.Decision.HOLD
        val config=ObservationConfigStore(context)
        val consent=config.consent(owner) ?: return ObservationLegacyOwnership.Decision.HOLD
        if(!consent.canCapture(observationInboxPermitted(context)) || config.paused(owner) ||
            config.profile(owner,System.currentTimeMillis())==null) return ObservationLegacyOwnership.Decision.HOLD
        val scope=Values.sha256(listOf(owner.collectionId,owner.accountId).joinToString(""){"${it.length}:$it"})
        val store=rw.ikanisa.burimunsi.storage.SecureStore(context,"observation-receiving-sim-$scope")
        val previous=store.read()?.let(::JSONObject)
        val generation=consent.revision.generation
        val bound=if(previous!=null && previous.getLong("consentGeneration")==generation) previous.getInt("subscriptionId")
        else {
            val single=active.singleOrNull() ?: return ObservationLegacyOwnership.Decision.HOLD
            val encoded=JSONObject().put("subscriptionId",single).put("consentGeneration",generation).toString()
            store.write(encoded)
            if(store.read()!=encoded)return ObservationLegacyOwnership.Decision.HOLD
            single
        }
        return when {
            bound !in active || subscription==null -> ObservationLegacyOwnership.Decision.HOLD
            subscription!=bound -> ObservationLegacyOwnership.Decision.OTHER_SIM
            else -> ObservationLegacyOwnership.Decision.UNOWNED
        }
    }
}
