package app.cool.mobile.receiver_sms

/** All writers of the protected SMS policy invalidate in-progress body leases.
 * Metadata scans never need this lock. Exact body reads and local queue views
 * hold it briefly while disclosing already-scoped content. */
internal object ObservationInboxPolicyRevision {
    private val lock = Any()
    private var revision = 0L
    private var writes = 0
    fun stable(): Long? = synchronized(lock) { revision.takeIf { writes == 0 } }
    fun <T> whileCurrent(expected: Long, action: () -> T): T? = synchronized(lock) {
        if (writes == 0 && revision == expected) action() else null
    }
    fun <T> changing(action: () -> T): T {
        synchronized(lock) { writes++; revision++ }
        return try { action() } finally { synchronized(lock) { writes--; revision++ } }
    }
}
