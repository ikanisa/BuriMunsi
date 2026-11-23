package app.cool.mobile.receiver_sms

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.Manifest
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.provider.Telephony
import android.os.Handler
import android.os.Looper
import app.cool.mobile.BuildConfig
import rw.ikanisa.burimunsi.core.ObservationJournal
import rw.ikanisa.burimunsi.core.ObservationOwner
import rw.ikanisa.burimunsi.data.NativeRepository
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Observation scheduling remains independent from the retained gateway queue. */
internal object ObservationBackground {
    private const val IMMEDIATE=904_711
    private const val RECOVERY=904_712
    private const val LOCAL=904_713
    private const val INBOX_CHANGED=904_714
    private val wakeup=ObservationWakeup()
    val jobRetry=ContinuousSyncRetry()
    private val observerLock=Any()
    private val observerMain by lazy{Handler(Looper.getMainLooper())}
    private var fallbackObserver:ContentObserver?=null
    private var fallbackLease:Any?=null
    private var observerExpiry:Runnable?=null
    /** Preserve real provider monitoring across bounded job continuations. The OS trigger
     * continues independently after the app process or this short monitoring lease ends. */
    fun monitorJob(app:Context) = synchronized(observerLock){
        if(!observationInboxPermitted(app))return@synchronized
        if(fallbackObserver==null && !ObservationInboxRevision.observerActive()){
            val observer=object:ContentObserver(observerMain){
                override fun onChange(selfChange:Boolean){
                    ObservationInboxRevision.changed()
                    runCatching{signalLocal(app)}
                }
            }
            try{app.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI,true,observer)}
            catch(_:Exception){return@synchronized}
            fallbackObserver=observer
        }
        val watched=fallbackObserver?:return@synchronized
        if(!ObservationInboxRevision.observerActive())fallbackLease=ObservationInboxRevision.temporaryObserverRegistered()
        observerExpiry?.let(observerMain::removeCallbacks)
        val expiry=Runnable{synchronized(observerLock){
            if(fallbackObserver===watched){
                fallbackLease?.let(ObservationInboxRevision::observerDetached)
                fallbackLease=null;fallbackObserver=null;observerExpiry=null
                runCatching{app.contentResolver.unregisterContentObserver(watched)}
            }
        }}
        observerExpiry=expiry
        observerMain.postDelayed(expiry,120_000)
    }
    private var lastCloudRevision: String? = null

    @Synchronized fun recordsChanged(context: Context, revision: String? = null) {
        if (revision != null && lastCloudRevision == revision) return
        // A UI notification failure never affects receipt custody, retry or parse evidence.
        if (runCatching { rw.ikanisa.burimunsi.BuriRecordChanges.publishFromReceiver(context) }.isSuccess && revision != null)
            lastCloudRevision = revision
    }

    fun begin()=wakeup.begin()
    fun signal(context:Context,delay:Long=0){
        if(!BuriContinuousSupervisor.wake(delay))wakeup.signalNetwork{dispatchNetwork(context,delay)}
    }
    fun signalLocal(context:Context,delay:Long=0){
        if(!BuriContinuousSupervisor.wake(delay))wakeup.signalLocal{dispatchLocal(context,delay)}
    }
    private fun dispatchNetwork(context:Context,delay:Long){if(!BuriContinuousSupervisor.wake(delay))schedule(context,delay)}
    private fun dispatchLocal(context:Context,delay:Long){if(!BuriContinuousSupervisor.wake(delay))scheduleLocal(context,delay)}
    fun contend(context:Context,jobId:Int){
        when(jobId){
            IMMEDIATE->signal(context)
            RECOVERY->{try{signalLocal(context)}finally{signal(context)}}
            else->signalLocal(context)
        }
    }
    private fun scheduleLocal(context:Context,delay:Long){
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY)return
        val scheduler=context.getSystemService(JobScheduler::class.java)?:return
        val job=JobInfo.Builder(LOCAL,ComponentName(context,ObservationJobService::class.java))
            .setMinimumLatency(delay).setBackoffCriteria(30_000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build()
        check(scheduler.schedule(job)==JobScheduler.RESULT_SUCCESS){"Observation recovery unavailable"}
    }
    private fun schedule(context:Context,delay:Long){
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY)return
        val scheduler=context.getSystemService(JobScheduler::class.java)?:return
        val job=JobInfo.Builder(IMMEDIATE,ComponentName(context,ObservationJobService::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(delay)
            .setBackoffCriteria(30_000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build()
        check(scheduler.schedule(job)==JobScheduler.RESULT_SUCCESS){"Observation scheduling unavailable"}
    }
    /** Provider insertion may follow SMS_RECEIVED. The OS can wake a stopped process even
     * when the foreground observer is unavailable; no periodic timer is involved. */
    fun watchInbox(context:Context,replace:Boolean=false) {
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY||
            context.checkSelfPermission(Manifest.permission.READ_SMS)!=PackageManager.PERMISSION_GRANTED)return
        val scheduler=context.getSystemService(JobScheduler::class.java)?:return
        if(!replace&&scheduler.getPendingJob(INBOX_CHANGED)!=null)return
        val trigger=JobInfo.TriggerContentUri(Telephony.Sms.CONTENT_URI,JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS)
        val job=JobInfo.Builder(INBOX_CHANGED,ComponentName(context,ObservationJobService::class.java))
            .addTriggerContentUri(trigger).setTriggerContentUpdateDelay(0).setTriggerContentMaxDelay(0).build()
        check(scheduler.schedule(job)==JobScheduler.RESULT_SUCCESS){"Inbox change scheduling unavailable"}
    }
    fun onContentJob(context:Context,id:Int):Boolean {
        if(id!=INBOX_CHANGED)return false
        // Re-arm the one-shot content job before returning from onStartJob.
        runCatching{watchInbox(context,replace=true)}
        ObservationInboxRevision.changed()
        runCatching{signalLocal(context)}
        return true
    }
    fun ensure(context:Context){
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY)return
        ensurePeriodic(context)
        signal(context)
    }
    private fun ensurePeriodic(context:Context){
        val scheduler=context.getSystemService(JobScheduler::class.java)?:return
        runCatching{watchInbox(context)}
        if(scheduler.getPendingJob(RECOVERY)==null){
            val job=JobInfo.Builder(RECOVERY,ComponentName(context,ObservationJobService::class.java))
                .setPersisted(true).setPeriodic(15*60*1000L).build()
            check(scheduler.schedule(job)==JobScheduler.RESULT_SUCCESS){"Observation recovery unavailable"}
        }
    }

    /** Process creation alone is not evidence of receipt work. Real Android receipt,
     * boot, explicit Sync and periodic job events continue to wake their own workers. */
    fun onProcessStart(context:Context) {
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY)return
        val app=context.applicationContext
        runCatching { ensurePeriodic(app) }
        Thread({
            val needed=ObservationWakeup.recoverOnProcessStart(
                pendingReceipt={ObservationJournal(ObservationStateStore(app)).hasPendingWork()},
                heldReceipt={HeldRecoveryJournal.hasRecords(app)},
                pendingControl={
                    if(!ObservationLegacyOwnership.controlTransitionClear(app)) true
                    else {
                        val owner=NativeRepository.restorableObservationOwner(app)
                        val config=ObservationConfigStore(app)
                        val consent=owner?.let(config::consent)
                        if(owner==null || consent==null) false else {
                            val permitted=app.checkSelfPermission(Manifest.permission.READ_SMS)==PackageManager.PERMISSION_GRANTED &&
                                app.checkSelfPermission(Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED
                            !consent.confirmed || consent.revision.enabled!=(permitted && !config.paused(owner))
                        }
                    }
                },
            )
            if(needed) runCatching { BuriContinuousSupervisor.recover(app) }
        },"burimunsi-observation-process-recovery").start()
    }
    fun finish(context:Context,again:Boolean,nextDelay:Long=60_000,finish:()->Unit)=wakeup.finish(again,finish,
        {dispatchLocal(context,0)},{signalled->dispatchNetwork(context,if(signalled)0 else nextDelay)})
    fun hasPending(context:Context):Boolean=try{
        NativeRepository.withObservationOwner(context){group,account->
            val owner=ObservationOwner(group,account);val config=ObservationConfigStore(context)
            val permission=context.checkSelfPermission(Manifest.permission.READ_SMS)==PackageManager.PERMISSION_GRANTED&&
                context.checkSelfPermission(Manifest.permission.RECEIVE_SMS)==PackageManager.PERMISSION_GRANTED
            !config.paused(owner)&&config.consent(owner)?.canCapture(permission)==true&&config.profile(owner,System.currentTimeMillis())!=null&&
                ObservationJournal(ObservationStateStore(context)).pending(owner).isNotEmpty()
        }==true
    }catch(_:Exception){false}
}

class ObservationJobService:JobService(){
    private val worker=Executors.newSingleThreadExecutor()
    private val main=Handler(Looper.getMainLooper())
    private fun runObserved(stopped:AtomicBoolean):ObservationCycleResult {
        val app=applicationContext
        ObservationBackground.monitorJob(app)
        return ObservationSyncCycle.run(app,BuriContinuousSupervisor.online(app)){stopped.get()}
    }
    private var current:Pair<JobParameters,AtomicBoolean>?=null
    override fun onStartJob(params:JobParameters):Boolean {
        if(BuildConfig.IS_QUALIFICATION||!BuildConfig.IS_GATEWAY)return false
        if(ObservationBackground.onContentJob(applicationContext,params.jobId))return false
        if(!ObservationBackground.begin()){
            try{ObservationBackground.contend(applicationContext,params.jobId)}catch(_:Exception){}
            return false
        }
        val stopped=AtomicBoolean(false);current=params to stopped
        try{worker.execute{
            var again=false
            var nextDelay=60_000L
            try{
                val result=runObserved(stopped)
                again=result.more||result.busy
                nextDelay=if(result.busy)500 else ObservationBackground.jobRetry.next(result.completed,result.more,result.progress,result.awaitingParser)
            }catch(_:Exception){/* Protected state remains for retry after network/authority recovery. */}
            finally{
                if(!stopped.get())again=ObservationBackground.hasPending(applicationContext)||again
                val retry=again
                main.post{if(current?.second===stopped){current=null
                    try{ObservationBackground.finish(applicationContext,retry,nextDelay){jobFinished(params,false)}}catch(_:Exception){}}
                    // Revalidated expired saved sessions may now be eligible to
                    // recover the supervisor under an existing OS exemption.
                    if(!stopped.get())runCatching{BuriContinuousSupervisor.start(applicationContext)}
                }
            }
        }}catch(_:RuntimeException){current=null;ObservationBackground.finish(applicationContext,false){};return false}
        return true
    }
    override fun onStopJob(params:JobParameters):Boolean {
        val work=current?:return false
        if(work.first.jobId!=params.jobId)return false
        work.second.set(true);current=null
        try{ObservationBackground.finish(applicationContext,false){}}catch(_:Exception){}
        return true
    }
    override fun onDestroy(){
        val unfinished=current;unfinished?.second?.set(true);current=null
        if(unfinished!=null)try{ObservationBackground.finish(applicationContext,false){}}catch(_:Exception){}
        worker.shutdown();super.onDestroy()
    }
}

class ObservationBootReceiver:BroadcastReceiver(){
    override fun onReceive(context:Context,intent:Intent){
        if(intent.action in setOf(Intent.ACTION_BOOT_COMPLETED,Intent.ACTION_USER_UNLOCKED,Intent.ACTION_MY_PACKAGE_REPLACED)){
            try{ObservationBackground.ensure(context.applicationContext)}catch(_:Exception){}
            runCatching{BuriContinuousSupervisor.recover(context.applicationContext,
                intent.action in setOf(Intent.ACTION_BOOT_COMPLETED,Intent.ACTION_MY_PACKAGE_REPLACED))}
        }
    }
}
