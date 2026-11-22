package app.cool.mobile.receiver_sms

import java.util.concurrent.atomic.AtomicBoolean

/** Preserve signals arriving while another observation job owns the shared gate. */
internal class ObservationWakeup {
    companion object {
        fun recoverOnProcessStart(pendingReceipt:()->Boolean, heldReceipt:()->Boolean, pendingControl:()->Boolean):Boolean =
            try { pendingReceipt() || heldReceipt() || pendingControl() }
            catch (_: Exception) { true } // Retry uncertain protected state through the normal authorized worker.
    }

    private val gate=MomoGatewayWakeupGate()
    private val localRetry=AtomicBoolean(false)
    private val networkRetry=AtomicBoolean(false)
    fun begin()=gate.begin()
    fun signalNetwork(schedule:()->Unit){
        networkRetry.set(true)
        gate.signal{if(networkRetry.getAndSet(false))try{schedule()}catch(e:Exception){networkRetry.set(true);throw e}}
    }
    fun signalLocal(schedule:()->Unit){localRetry.set(true);gate.signal(schedule)}
    fun finish(again:Boolean,finish:()->Unit,local:()->Unit,network:(Boolean)->Unit)=gate.finish(finish){
        if(localRetry.getAndSet(false))try{local()}catch(_:Exception){localRetry.set(true)}
        val signalled=networkRetry.getAndSet(false)
        if(signalled||again)try{network(signalled)}catch(_:Exception){networkRetry.set(true)}
    }
}
