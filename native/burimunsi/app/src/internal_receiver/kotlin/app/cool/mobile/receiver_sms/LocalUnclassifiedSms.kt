package app.cool.mobile.receiver_sms

data class InboxLocator(val row: Long, val receivedMs: Long) {
    init { require(row > 0 && receivedMs > 0) }
    override fun toString() = "InboxLocator(redacted)"
}

data class PendingReview(val locators: Set<InboxLocator> = emptySet(), val uncertainCoverage: Boolean = false) {
    override fun toString() = "PendingReview(count=${locators.size},uncertainCoverage=$uncertainCoverage)"
}

/** Store must be encrypted, local only and scoped to the current verified owner,
 * receiving source and consent revision. A false CAS or failed readback may never
 * be treated as permission to advance a separate inbox cursor. */
interface LocalOnlyReviewStore {
    fun read(): PendingReview
    fun compareAndReplace(expected: PendingReview, next: PendingReview): Boolean
}

enum class ReviewDecision { STILL_UNCLASSIFIED, PROVEN_NOT_FINANCIAL, ACCEPTED_BY_DURABLE_JOURNAL, MISSING_OR_CHANGED }
enum class CursorPermission { MAY_ADVANCE, BLOCKED }
enum class ReviewResult { RESOLVED, UNCONFIRMED, BLOCKED }

class LocalOnlyReview(private val store: LocalOnlyReviewStore, private val capacity: Int) {
    private var blockedThisPass = false
    init { require(capacity in 1..4096) }
    private fun blockCursor(): CursorPermission { blockedThisPass = true; return CursorPermission.BLOCKED }
    fun holdBeforeAdvance(locator: InboxLocator, ownerCurrent: () -> Boolean): CursorPermission {
        if (!ownerCurrent()) return blockCursor()
        val before = store.read()
        if (locator in before.locators) return if (ownerCurrent()) CursorPermission.MAY_ADVANCE else blockCursor()
        val full = before.locators.size >= capacity
        val after = if (full) before.copy(uncertainCoverage = true) else before.copy(locators = before.locators + locator)
        if (!ownerCurrent() || !store.compareAndReplace(before, after) || store.read() != after || !ownerCurrent())
            return blockCursor()
        return if (full) blockCursor() else CursorPermission.MAY_ADVANCE
    }

    fun review(locator: InboxLocator, ownerCurrent: () -> Boolean,
               exactReadback: (InboxLocator) -> ReviewDecision): ReviewResult {
        if (!ownerCurrent()) return ReviewResult.BLOCKED
        val before = store.read()
        if (locator !in before.locators) return ReviewResult.BLOCKED
        val result = exactReadback(locator)
        if (!ownerCurrent()) return ReviewResult.BLOCKED
        val after = when (result) {
            ReviewDecision.STILL_UNCLASSIFIED -> return ReviewResult.UNCONFIRMED
            ReviewDecision.MISSING_OR_CHANGED -> before.copy(uncertainCoverage = true)
            ReviewDecision.PROVEN_NOT_FINANCIAL, ReviewDecision.ACCEPTED_BY_DURABLE_JOURNAL ->
                before.copy(locators = before.locators - locator)
        }
        if (!store.compareAndReplace(before, after) || store.read() != after || !ownerCurrent()) {
            blockedThisPass = true
            return ReviewResult.BLOCKED
        }
        return if (result == ReviewDecision.MISSING_OR_CHANGED) ReviewResult.UNCONFIRMED else ReviewResult.RESOLVED
    }
    /** A fresh fenced exact census is mandatory after process restart; an absent pointer is not proof. */
    fun canClaimComplete(freshCensus: Boolean) = freshCensus && !blockedThisPass &&
        store.read().let { !it.uncertainCoverage && it.locators.isEmpty() }
}
