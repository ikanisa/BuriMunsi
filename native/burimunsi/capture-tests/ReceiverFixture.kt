package app.cool.mobile.receiver_sms

import android.content.Context
import org.json.JSONObject

object CaptureFixture {
    var result=SmsQueueStore.AppendResult.STORED
    var active=true;var admin=true;var retain=true;var metadataFailure=false;var scheduleFailure=false
    var evidence=BuriCapturePolicy.CaptureEvidence.ELIGIBLE;var complete=true;var formatFlag=false
    var finished=0;var signalCalls=0;var scheduleCalls=0
    var state=initial();var inbox=emptyList<Map<String,Any?>>()
    val queue=mutableListOf<JSONObject>();val pendingJobs=mutableSetOf<Int>()
    var gate=MomoGatewayWakeupGate()
    fun initial()=JSONObject().put("binding",JSONObject().put("owner_user_id","synthetic-owner").put("id","synthetic-binding")
        .put("version",1).put("subscription_id",7).put("created_at","2026-11-01T00:00:00Z"))
    fun reset(){state=initial();inbox=emptyList();result=SmsQueueStore.AppendResult.STORED;active=true;admin=true;retain=true;metadataFailure=false;scheduleFailure=false;
        evidence=BuriCapturePolicy.CaptureEvidence.ELIGIBLE;complete=true;formatFlag=false;finished=0;signalCalls=0;scheduleCalls=0;queue.clear();pendingJobs.clear();gate=MomoGatewayWakeupGate()}
}
class MomoGatewayStore(context:Context){
    fun active()=CaptureFixture.active
    fun read()=CaptureFixture.state
    fun installationId()="synthetic-installation"
    fun update(action:(JSONObject)->Unit){if(CaptureFixture.metadataFailure)error("synthetic metadata failure");CaptureFixture.state.let{state->action(state);if(state.optBoolean("live_format_unconfirmed"))CaptureFixture.formatFlag=true}}
    fun <T> withCurrentBinding(binding:JSONObject,action:()->T):T?=if(active())action()else null
    fun <T> withCurrentCapture(binding:JSONObject,action:()->T):T?=if(CaptureFixture.admin)withCurrentBinding(binding,action) else null
    fun park(reason:String){}
}
class SmsQueueStore(context:Context){
    enum class AppendResult { STORED,DUPLICATE,FULL,RESERVED,DISABLED,FAILED }
    fun activeCaptureOwner():String?=null
    fun appendIfCapacity(value:JSONObject,max:Int,reserve:Int=0):AppendResult {
        if(CaptureFixture.result==AppendResult.STORED)CaptureFixture.queue.add(value)
        return CaptureFixture.result
    }
}
object SmsQueueWorker { fun executeCapture(action:()->Unit)=action() }
object SmsQueueEventBus { fun notifyQueueChanged(){} }
object MomoGatewayJobs {
    fun signal(context:Context){
        CaptureFixture.signalCalls++
        CaptureFixture.gate.signal {
            if(CaptureFixture.scheduleFailure)error("synthetic scheduling failure")
            CaptureFixture.scheduleCalls++
            CaptureFixture.pendingJobs.add(904_601) // Fake the real stable JobScheduler ID.
        }
    }
}
object MomoGatewayPolicy {
    const val MAX_PENDING=1000
    const val MAX_SCAN_ROWS=100
    const val LIVE_CAPTURE_RESERVE=10
    fun memberCaptureSupported(flavor:String)=false
    fun captureId(installation:String,binding:String,sender:String,body:String,received:Long,subscription:Int?)="synthetic-id"
    fun sourceResolved(selected:Int?,actual:Int?,multiple:Boolean)=selected==actual
}
object MomoMultipartPolicy {
    data class Assembly(val body:String,val complete:Boolean)
    fun assemble(senders:List<String>,times:List<Long>,parts:List<String>,pdus:List<ByteArray?>,format:String?)=Assembly(parts.joinToString(""),CaptureFixture.complete)
    fun memberCaptureEligible(sender:String,assembly:Assembly)=false
}
object BuriReceiverReliability {
    enum class Route { ACCEPT,OTHER_SIM,UNCERTAIN }
    fun inboxAfterBinding(id:Long,baseline:Long?,received:Long,created:Long?)=
        id>0&&created!=null&&received>=created&&(baseline==null||id>baseline)
    fun bindingMatches(a:(String)->Any?,b:(String)->Any?)=a("id")==b("id")&&a("version")==b("version")
}
object BuriCapturePolicy {
    fun senderAllowed(binding:JSONObject?,sender:String)=CaptureFixture.retain
    fun route(context:Context,binding:JSONObject?,subscription:Int?)=BuriReceiverReliability.Route.ACCEPT
    enum class CaptureEvidence { ELIGIBLE, EXCLUDED, UNCONFIRMED }
    fun captureEvidence(binding:JSONObject?,sender:String,body:String,complete:Boolean=true)=
        when { body=="synthetic code" -> CaptureEvidence.EXCLUDED
            !complete||body.isEmpty()||body=="synthetic unknown" -> CaptureEvidence.UNCONFIRMED
            else -> CaptureFixture.evidence }
}

// Host JSON adapter lacks the Android overloads used by the generated scanner.
internal fun JSONObject.optLong(name:String,fallback:Long=0L)=(opt(name) as? Number)?.toLong()?:fallback
