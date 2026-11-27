package app.cool.mobile.receiver_sms

import android.content.Context
import rw.ikanisa.burimunsi.storage.SecureStore
import java.security.MessageDigest
import java.util.Locale

/** Backed by noBackupFilesDir, AtomicFile, and the existing Keystore store in
 * Android. Local metadata is not evidence of a receipt. Only exact current
 * authority may use the held references; new profiles must not orphan them. */
internal class AndroidUnclassifiedSmsStore(
    context: Context,
    collection: String,
    account: String,
    installation: String,
    androidScope: String,
    private val authorityCurrent: () -> Boolean,
    capacity: Int = 512,
) {
    private companion object { val locks = Array(64) { Any() } }
    init {
        require(listOf(collection, account, installation, androidScope).all { it.isNotBlank() && it.length <= 160 })
    }
    private val namespace = listOf(collection, account, installation, androidScope).joinToString("|") { "${it.length}:$it" }
    private val key = MessageDigest.getInstance("SHA-256").digest(namespace.toByteArray(Charsets.UTF_8))
    private val baseName = "unclassified-sms-"+key.joinToString("") { "%02x".format(Locale.ROOT,it.toInt() and 0xff) }
    private val app=context.applicationContext
    private val lock = locks[(key[0].toInt() and 0xff) % locks.size]
    private val pageCapacity=capacity
    private fun checkpoint(name:String,required:Boolean=false):UnclassifiedReviewCheckpoint {
        val file=SecureStore(app,name)
        return UnclassifiedReviewCheckpoint(object:PrivateBlob {
            override fun read()=file.read().also { check(!required || it!=null) }
            override fun write(value:String)=file.write(value)
        },lock,pageCapacity)
    }
    private val store=checkpoint(baseName)
    private val index=SecureStore(app,"sms-review-page-count-"+baseName.removePrefix("unclassified-sms-"))
    private fun page(number:Int,required:Boolean=false)=checkpoint("sms-review-page-$number-"+baseName.removePrefix("unclassified-sms-"),required)
    private fun pageCount():Int {
        val raw=index.read()?:return 0
        return raw.toInt().also { require(it in 1..100_000&&it.toString()==raw) }
    }
    // Persist the first exact locator before exposing a page in the index. If
    // interrupted, every reader also checks the single possible unpublished page.
    private fun pages(count:Int)=sequence {
        yield(store)
        for(n in 1..count)yield(page(n,true))
        val unpublished=page(count+1)
        if(unpublished.read()!=PendingReview())yield(unpublished)
    }
    private var stalledThisPass=false

    fun hold(row:Long,receivedMs:Long?):CursorPermission=synchronized(lock){
        val result=try {
            if(receivedMs==null||!authorityCurrent())CursorPermission.BLOCKED else {
                val locator=InboxLocator(row,receivedMs)
                val primary=store.read()
                if(locator in primary.locators)CursorPermission.MAY_ADVANCE else {
                    val count=pageCount()
                    var destination:UnclassifiedReviewCheckpoint?=if(primary.locators.size<pageCapacity)store else null
                    var alreadyHeld=false
                    var indexed=count
                    for(n in 1..count+1){
                        val file=page(n,n<=count);val held=file.read()
                        if(n>count&&held!=PendingReview()){
                            if(!authorityCurrent())return@synchronized CursorPermission.BLOCKED
                            index.write(n.toString());check(pageCount()==n);indexed=n
                        }
                        if(locator in held.locators){alreadyHeld=true;break}
                        if(n<=indexed&&destination==null&&held.locators.size<pageCapacity)destination=file
                    }
                    if(alreadyHeld)CursorPermission.MAY_ADVANCE else {
                        val target=destination?:page(indexed+1)
                        val accepted=LocalOnlyReview(target,pageCapacity).holdBeforeAdvance(locator,authorityCurrent)
                        if(accepted==CursorPermission.MAY_ADVANCE&&destination==null){
                            check(authorityCurrent());index.write((indexed+1).toString());check(pageCount()==indexed+1)
                        }
                        accepted
                    }
                }
            }
        }catch(_:Exception){CursorPermission.BLOCKED}
        if(result==CursorPermission.BLOCKED||!authorityCurrent()){
            stalledThisPass=true;CursorPermission.BLOCKED
        }else result
    }
    fun resolve(row:Long,receivedMs:Long,readExact:(InboxLocator)->ReviewDecision):ReviewResult=synchronized(lock){
        try{
            if(!authorityCurrent())return@synchronized ReviewResult.BLOCKED
            val locator=InboxLocator(row,receivedMs)
            val file=pages(pageCount()).firstOrNull{locator in it.read().locators}?:return@synchronized ReviewResult.BLOCKED
            LocalOnlyReview(file,pageCapacity).review(locator,authorityCurrent,readExact)
        }catch(_:Exception){ReviewResult.BLOCKED}
    }
    /** Missing or corrupt metadata is not silently treated as a clean census.
     * An absent store on a fresh scope is empty; an unreadable store blocks. */
    fun hasUnresolved(): Boolean = try {
        // Do not acquire the session lock while holding this storage lock.
        !authorityCurrent() || synchronized(lock) {
            stalledThisPass || pages(pageCount()).any { page -> page.read().let { it.uncertainCoverage || it.locators.isNotEmpty() } }
        } || !authorityCurrent()
    } catch (_: Exception) { true }
    fun complete(freshExactCensus: Boolean): Boolean =
        synchronized(lock) {
            try { freshExactCensus && !stalledThisPass && authorityCurrent() && pages(pageCount()).all { it.read()==PendingReview() } && authorityCurrent() }
            catch (_: Exception) { false }
        }
}
