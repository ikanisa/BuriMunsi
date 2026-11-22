package app.cool.mobile.receiver_sms

import java.util.concurrent.Semaphore
import java.util.concurrent.Future
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID

/** A local change token only; it contains no SMS data or persistent identity. */
internal object ObservationInboxRevision {
    private val current=AtomicLong()
    private val process=UUID.randomUUID().toString()
    private val observerLock=Any()
    private var observer:Any?=null
    fun epoch():String=process
    fun snapshot():Long=current.get()
    fun changed(){current.incrementAndGet()}
    /** Called only after Android has accepted the content-observer registration. */
    fun observerRegistered():Any=synchronized(observerLock){
        Any().also{observer=it;current.incrementAndGet()}
    }
    /** Invalidate all process-local sweep witnesses before unregistering. */
    fun temporaryObserverRegistered():Any?=synchronized(observerLock){
        if(observer!=null)null else Any().also{observer=it;current.incrementAndGet()}
    }
    fun observerDetached(lease:Any)=synchronized(observerLock){
        if(observer===lease){observer=null;current.incrementAndGet()}
    }
    fun observerActive():Boolean=synchronized(observerLock){observer!=null}
}

/** Shared by jobs and the supervisor. An interrupted caller cannot release another cycle's lease. */
internal class ContinuousSyncWorkGate {
    private val permit=Semaphore(1)
    fun <T> runIfIdle(action:()->T):T? {
        if(!permit.tryAcquire())return null
        return try{action()}finally{permit.release()}
    }
}

/** Owns pending foreground startup checks without blocking the lifecycle callback. */
internal class ContinuousForegroundStartup {
    private val worker = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "burimunsi-foreground-start").apply { isDaemon = true }
    }.apply {
        removeOnCancelPolicy = true
        setKeepAliveTime(15, TimeUnit.SECONDS)
        allowCoreThreadTimeOut(true)
    }
    private val revision = AtomicLong()
    private var pending: Future<*>? = null

    @Synchronized
    fun changed(resumed: Boolean, awaitingInitialAccess: Boolean = false, serviceRunning: Boolean = false, start: (() -> Boolean) -> Unit) {
        val expected = revision.incrementAndGet()
        pending?.cancel(false)
        pending = if (!resumed || (awaitingInitialAccess && !serviceRunning)) null else worker.submit {
            val current = { revision.get() == expected }
            if (current()) start(current)
        }
    }
}

/** Stops between bounded I/O operations; a lost final acknowledgement keeps its original identity. */
internal class ContinuousSyncBudget(
    private val now:()->Long,
    private val cancelled:()->Boolean,
    private val maximumMs:Long=60_000,
){
    private val started=now()
    init{require(started>=0&&maximumMs in 1_000..120_000)}
    fun stopped():Boolean {
        val current=now()
        return cancelled()||current<started||current-started>=maximumMs
    }
}

/** Event wakeups bypass this idle/error delay; failures never create an unbounded busy loop. */
internal class ContinuousSyncRetry {
    private var failures=0
    private var parserWaits=0
    fun next(completed:Boolean,more:Boolean,progress:Boolean=false,awaitingParser:Boolean=false):Long {
        if(awaitingParser){
            failures=0
            val delay=500L shl parserWaits.coerceAtMost(5)
            parserWaits=(parserWaits+1).coerceAtMost(5)
            return delay
        }
        parserWaits=0
        if(completed||!more){failures=0;return if(more)0 else 60_000}
        if(progress){failures=0;return 0}
        val delay=(1_000L shl failures).coerceAtMost(60_000L)
        failures=(failures+1).coerceAtMost(6)
        return delay
    }
}
