package app.cool.mobile.receiver_sms
import android.content.Context
import rw.ikanisa.burimunsi.core.*
internal class ObservationStateStore(context:Context):ObservationJournalStore {
 companion object { var value=ObservationJournalState(emptyList(),emptyList());var fail=false }
 override fun read():ObservationJournalState {check(!fail);return value}
 override fun write(value:ObservationJournalState){check(!fail);Companion.value=value}
}
internal class ObservationConfigStore(context:Context){
 data class Control(val paused:Boolean,val revision:Long)
 fun controlState(owner:ObservationOwner)=Control(isPaused,if(isPaused)1 else 0)
 fun paused(owner:ObservationOwner)=isPaused
 fun consent(owner:ObservationOwner):ObservationConsentState?=if(isPaused) ObservationConsentState(ObservationConsentRevision(false,2),true) else null
 companion object {
  var currentProfile:ObservationProfile?=null
  var isPaused=false
  fun changeProfile(profile:ObservationProfile?)=ObservationInboxPolicyRevision.changing{currentProfile=profile}
 }
 fun profile(owner:ObservationOwner,now:Long):ObservationProfile?=currentProfile?.takeIf{it.current(now)}
 fun setPaused(owner:ObservationOwner,paused:Boolean)=ObservationInboxPolicyRevision.changing{isPaused=paused}
}
internal class ObservationRecovery(context:Context){
 fun receivingSimProblem(owner:ObservationOwner,profile:ObservationProfile,consent:ObservationConsentState,
     control:ObservationConfigStore.Control,retainedSubscriptions:Sequence<Int?>):String? =
     error("Receiving SIM state is exercised by the observation adapter suite")
}
internal object ObservationBackground { fun ensure(context:Context){};fun signal(context:Context){} }
