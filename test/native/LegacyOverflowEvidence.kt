package app.cool.mobile.receiver_sms

/** Two synthetic histories that cannot be distinguished from the bytes v71 retained. */
fun main() {
    class Blob : PrivateBlob {
        var raw: String? = null
        override fun read() = raw
        override fun write(value: String) { raw = value }
    }
    fun overflow(unrecorded: InboxLocator): Blob {
        val file = Blob()
        val checkpoint = UnclassifiedReviewCheckpoint(file, Any(), 512)
        val writer = LocalOnlyReview(checkpoint, 512)
        for (row in 1L..512L) {
            check(writer.holdBeforeAdvance(InboxLocator(row, 10_000L + row), { true }) == CursorPermission.MAY_ADVANCE)
        }
        check(writer.holdBeforeAdvance(unrecorded, { true }) == CursorPermission.BLOCKED)
        return file
    }
    val original = overflow(InboxLocator(514,20_000))
    val different = overflow(InboxLocator(518,40_000))
    check(original.raw == different.raw && original.raw!!.startsWith("1|1\n"))
    val store = UnclassifiedReviewCheckpoint(original, Any(), 512)
    val current = LocalOnlyReview(store,512)
    for (row in store.read().locators) {
        check(current.review(row,{true}){ ReviewDecision.ACCEPTED_BY_DURABLE_JOURNAL } == ReviewResult.RESOLVED)
    }
    check(original.raw == "1|1" && !current.canClaimComplete(true))
    println("Two distinct overflow identities produced identical v71 bytes; all 512 recorded locators resolved; historic coverage still held.")
}
