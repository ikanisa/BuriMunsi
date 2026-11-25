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
    private val file = SecureStore(context.applicationContext, "unclassified-sms-" +
        key.joinToString("") { "%02x".format(Locale.ROOT,it.toInt() and 0xff) })
    private val lock = locks[(key[0].toInt() and 0xff) % locks.size]
    private val store = UnclassifiedReviewCheckpoint(object : PrivateBlob {
        override fun read() = file.read()
        override fun write(value: String) = file.write(value)
    }, lock, capacity)
    private val engine = LocalOnlyReview(store, capacity)

    private var stalledThisPass = false

    fun hold(row: Long, receivedMs: Long?): CursorPermission = synchronized(lock) {
        val decision = try {
            if (receivedMs == null) CursorPermission.BLOCKED
            else engine.holdBeforeAdvance(InboxLocator(row, receivedMs), authorityCurrent)
        } catch (_: Exception) {
            CursorPermission.BLOCKED
        }
        if (decision == CursorPermission.BLOCKED) stalledThisPass = true
        decision
    }
    fun resolve(row: Long, receivedMs: Long, readExact: (InboxLocator) -> ReviewDecision): ReviewResult =
        synchronized(lock) {
            try { engine.review(InboxLocator(row, receivedMs), authorityCurrent, readExact) }
            catch (_: Exception) { ReviewResult.BLOCKED }
        }
    /** Missing or corrupt metadata is not silently treated as a clean census.
     * An absent store on a fresh scope is empty; an unreadable store blocks. */
    fun hasUnresolved(): Boolean = try {
        // Do not acquire the session lock while holding this storage lock.
        !authorityCurrent() || synchronized(lock) {
            stalledThisPass || store.read().let { it.uncertainCoverage || it.locators.isNotEmpty() }
        } || !authorityCurrent()
    } catch (_: Exception) { true }
    fun complete(freshExactCensus: Boolean): Boolean =
        synchronized(lock) {
            try { !stalledThisPass && authorityCurrent() && engine.canClaimComplete(freshExactCensus) && authorityCurrent() }
            catch (_: Exception) { false }
        }
}
