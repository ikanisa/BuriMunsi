package app.cool.mobile.receiver_sms

import android.content.Context
import rw.ikanisa.burimunsi.core.ObservationOwner

internal object ObservationReceivingSim {
    /** The SMS provider identifies the actual receiving SIM on this Admin's phone.
     * Existing paired gateway envelopes retain their original route in ObservationLegacyOwnership. */
    fun classify(context: Context, owner: ObservationOwner, subscription: Int?): ObservationLegacyOwnership.Decision {
        val config = ObservationConfigStore(context)
        val consent = config.consent(owner)
        if (consent?.canCapture(observationInboxPermitted(context)) != true || config.paused(owner) ||
            config.profile(owner, System.currentTimeMillis()) == null) return ObservationLegacyOwnership.Decision.HOLD
        val active = BuriCapturePolicy.activeSubscriptions(context)
        if (active.isNullOrEmpty() || subscription == null) return ObservationLegacyOwnership.Decision.HOLD
        return if (subscription in active) ObservationLegacyOwnership.Decision.UNOWNED else ObservationLegacyOwnership.Decision.OTHER_SIM
    }
}
