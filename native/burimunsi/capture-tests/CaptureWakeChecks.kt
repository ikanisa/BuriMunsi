package app.cool.mobile.receiver_sms

import android.content.Context
import android.content.Intent
import android.provider.Telephony

fun main(){
    val context=Context();val receiver=CollectSmsReceiver()
    val sms=Intent(Telephony.Sms.Intents.SMS_RECEIVED_ACTION,mapOf("subscription" to 7,"format" to "3gpp"))
    var checks=0
    fun ck(name:String,condition:Boolean){check(condition){name};println("PASS $name");checks++}
    CaptureFixture.reset();receiver.onReceive(context,sms)
    ck("new retained broadcast requests one wake after queue append",CaptureFixture.queue.size==1&&CaptureFixture.signalCalls==1&&CaptureFixture.pendingJobs.size==1&&CaptureFixture.finished==1)
    CaptureFixture.result=SmsQueueStore.AppendResult.DUPLICATE;receiver.onReceive(context,sms)
    ck("duplicate broadcast does not schedule another wake",CaptureFixture.queue.size==1&&CaptureFixture.signalCalls==1&&CaptureFixture.finished==2)
    CaptureFixture.result=SmsQueueStore.AppendResult.FULL;receiver.onReceive(context,sms)
    ck("full queue does not falsely schedule a new capture",CaptureFixture.queue.size==1&&CaptureFixture.signalCalls==1)
    CaptureFixture.reset();CaptureFixture.retain=false;receiver.onReceive(context,sms)
    ck("unapproved source is neither retained nor scheduled",CaptureFixture.queue.isEmpty()&&CaptureFixture.signalCalls==0)
    CaptureFixture.reset();CaptureFixture.evidence=BuriCapturePolicy.CaptureEvidence.EXCLUDED;receiver.onReceive(context,sms)
    ck("excluded live text creates no queue entry, job or unresolved flag",CaptureFixture.queue.isEmpty()&&CaptureFixture.signalCalls==0&&!CaptureFixture.formatFlag)
    CaptureFixture.reset();CaptureFixture.evidence=BuriCapturePolicy.CaptureEvidence.UNCONFIRMED;receiver.onReceive(context,sms)
    ck("unfamiliar live text retains only an unresolved boolean",CaptureFixture.queue.isEmpty()&&CaptureFixture.signalCalls==0&&CaptureFixture.formatFlag)
    CaptureFixture.reset();CaptureFixture.complete=false;receiver.onReceive(context,sms)
    ck("incomplete live assembly cannot reach the raw queue",CaptureFixture.queue.isEmpty()&&CaptureFixture.signalCalls==0&&CaptureFixture.formatFlag)
    CaptureFixture.reset();CaptureFixture.admin=false;receiver.onReceive(context,sms)
    ck("a Staff session cannot acquire a new receipt through an older active gateway",CaptureFixture.queue.isEmpty()&&CaptureFixture.signalCalls==0&&CaptureFixture.finished==1)
    CaptureFixture.reset();CaptureFixture.scheduleFailure=true;receiver.onReceive(context,sms)
    ck("scheduler failure preserves the already retained capture",CaptureFixture.queue.size==1&&CaptureFixture.signalCalls==1&&CaptureFixture.finished==1)
    CaptureFixture.reset();CaptureFixture.metadataFailure=true;receiver.onReceive(context,sms)
    ck("metadata failure does not suppress wake for retained capture",CaptureFixture.queue.size==1&&CaptureFixture.signalCalls==1)
    CaptureFixture.reset();check(CaptureFixture.gate.begin());receiver.onReceive(context,sms)
    ck("active worker coalesces the concurrent wake",CaptureFixture.queue.size==1&&CaptureFixture.scheduleCalls==0)
    CaptureFixture.gate.finish({}, {if(CaptureFixture.queue.isNotEmpty())MomoGatewayJobs.signal(context)})
    ck("worker completion rechecks and schedules retained work",CaptureFixture.scheduleCalls==1&&CaptureFixture.pendingJobs.size==1)
    CaptureFixture.reset();receiver.onReceive(context,sms);receiver.onReceive(context,sms)
    ck("repeated schedules retain the same one-shot job identity",CaptureFixture.signalCalls==2&&CaptureFixture.pendingJobs.size==1)
    CaptureFixture.reset()
    fun inboxRow(id:Long,body:String)=mapOf("_id" to id,"address" to "TEST MOMO","body" to body,
        "date" to java.time.Instant.parse("2026-11-02T00:00:00Z").toEpochMilli(),"sub_id" to 7)
    CaptureFixture.inbox=listOf(inboxRow(11,"synthetic code"),inboxRow(12,"synthetic unknown"),inboxRow(13,"known financial receipt"))
    val recovery=MomoGatewayRecovery(context)
    ck("generated inbox scan skips an excluded code but checkpoints only before an unfamiliar row",
        !recovery.catchUp()&&CaptureFixture.state.getLong("inbox_checkpoint")==11L&&
        CaptureFixture.state.optBoolean("catch_up_format_unconfirmed")&&CaptureFixture.queue.isEmpty())
    ck("a second recovery pass holds the same row without persisting its content",
        !recovery.catchUp()&&CaptureFixture.state.getLong("inbox_checkpoint")==11L&&
        !CaptureFixture.state.optBoolean("catch_up_pending")&&CaptureFixture.queue.isEmpty()&&
        !CaptureFixture.state.toString().contains("synthetic unknown"))
    // This simulates an updated classifier for the same row; no message is modified on a device.
    CaptureFixture.inbox=listOf(inboxRow(11,"synthetic code"),inboxRow(12,"confirmed receipt"),inboxRow(13,"known financial receipt"))
    ck("recognized rows resume capture in original order and clear the scan hold",
        !recovery.catchUp()&&CaptureFixture.state.getLong("inbox_checkpoint")==13L&&
        !CaptureFixture.state.optBoolean("catch_up_format_unconfirmed")&&
        CaptureFixture.queue.map{it.getLong("inbox_row_id")}==listOf(12L,13L))
    ck("idle process startup skips the observation network job",
        !ObservationWakeup.recoverOnProcessStart({false},{false},{false}))
    ck("a retained receipt immediately wakes the original worker",
        ObservationWakeup.recoverOnProcessStart({true},{error("unneeded")},{error("unneeded")}))
    ck("a held receipt or pending consent wakes the original worker",
        ObservationWakeup.recoverOnProcessStart({false},{true},{false}) &&
            ObservationWakeup.recoverOnProcessStart({false},{false},{true}))
    ck("unreadable protected work still gets an immediate authorized recovery attempt",
        ObservationWakeup.recoverOnProcessStart({throw IllegalStateException("unreadable")},{false},{false}))
    val observation=ObservationWakeup();var network=0;var local=0;var urgent=false
    check(observation.begin())
    observation.signalNetwork{network++};observation.signalLocal{local++}
    ck("observation signals are held while a worker is active",network==0&&local==0)
    observation.finish(true,{}, {local++}, {requested->urgent=requested;network++})
    ck("pause/reconcile signal schedules immediately after the active worker",network==1&&local==1&&urgent)
    var fail=true
    runCatching{observation.signalNetwork{if(fail)error("synthetic scheduler failure")}}
    fail=false;check(observation.begin());observation.finish(false,{}, {}, {network++})
    ck("failed network scheduling retains a retry signal",network==2)
    println("RESULT: $checks generated receiver wake checks passed with Android, queue and scheduler doubles; not device or network proof.")
}
