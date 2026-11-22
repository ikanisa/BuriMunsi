package app.cool.mobile.receiver_sms
import android.content.Context
object ObservationBackground {
    @Volatile var signals=0
    var recordChanges=0
    private var cloudRevision:String?=null
    fun recordsChanged(context:Context,revision:String?=null){
        if(revision==null||revision!=cloudRevision){recordChanges++;if(revision!=null)cloudRevision=revision}
    }
    fun watchInbox(context:Context){}
    fun signalLocal(context:Context,delay:Long=0){check(delay==0L);signals++}
    fun hasPending(context:Context)=try{rw.ikanisa.burimunsi.data.NativeRepository.withObservationOwner(context){group,account->
        rw.ikanisa.burimunsi.core.ObservationJournal(ObservationStateStore(context)).pending(rw.ikanisa.burimunsi.core.ObservationOwner(group,account)).isNotEmpty()
    }==true}catch(_:Exception){false}
}
