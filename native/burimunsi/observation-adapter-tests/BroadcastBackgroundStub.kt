package app.cool.mobile.receiver_sms
import android.content.Context
object ObservationBackground {
    @Volatile var signals=0
    fun watchInbox(context:Context){}
    fun signalLocal(context:Context,delay:Long=0){check(delay==0L);signals++}
    fun hasPending(context:Context)=try{rw.ikanisa.burimunsi.data.NativeRepository.withObservationOwner(context){group,account->
        rw.ikanisa.burimunsi.core.ObservationJournal(ObservationStateStore(context)).pending(rw.ikanisa.burimunsi.core.ObservationOwner(group,account)).isNotEmpty()
    }==true}catch(_:Exception){false}
}
