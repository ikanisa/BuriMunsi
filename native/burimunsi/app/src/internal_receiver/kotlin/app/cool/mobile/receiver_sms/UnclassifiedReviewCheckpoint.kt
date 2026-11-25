package app.cool.mobile.receiver_sms

// This interface only handles ciphertext-backed, local storage. The caller must
// bind the blob name to the current account, consent generation and Android identity.
interface PrivateBlob {
    fun read(): String?
    fun write(value: String)
}

internal class UnclassifiedReviewCheckpoint(
    private val blob: PrivateBlob,
    private val processLock: Any, // shared by all wrappers for the same blob
    private val capacity: Int,
) : LocalOnlyReviewStore {
    init { require(capacity in 1..4096) }

    override fun read() = synchronized(processLock) { decode(blob.read()) }

    override fun compareAndReplace(expected: PendingReview, next: PendingReview): Boolean =
        synchronized(processLock) {
            try {
                if (decode(blob.read()) != expected || next.locators.size > capacity ||
                    (expected.uncertainCoverage && !next.uncertainCoverage)) return@synchronized false
                val encoded = encode(next)
                blob.write(encoded)
                blob.read() == encoded
            } catch (_: Exception) {
                false
            }
        }

    private fun encode(state: PendingReview): String = buildString {
        append(if (state.uncertainCoverage) "1|1" else "1|0")
        state.locators.sortedWith(compareBy({ it.row }, { it.receivedMs })).forEach {
            append('\n').append(it.row).append(':').append(it.receivedMs)
        }
    }

    private fun decode(value: String?): PendingReview {
        if (value == null) return PendingReview()
        require(value.length in 3..(3 + capacity * 40)) { "invalid_sms_review_checkpoint" }
        val lines = value.split('\n')
        require(lines[0] in setOf("1|0", "1|1") && lines.size in 1..(capacity + 1)) {
            "invalid_sms_review_checkpoint"
        }
        val pairs = lines.drop(1).map { line ->
            require(line.matches(Regex("[1-9][0-9]{0,18}:[1-9][0-9]{0,18}"))) { "invalid_sms_review_checkpoint" }
            val row = line.substringBefore(':').toLongOrNull()
                ?: error("invalid_sms_review_checkpoint")
            val at = line.substringAfter(':').toLongOrNull()
                ?: error("invalid_sms_review_checkpoint")
            InboxLocator(row, at)
        }
        val state = PendingReview(pairs.toSet(), lines[0] == "1|1")
        require(encode(state) == value) { "invalid_sms_review_checkpoint" }
        return state
    }
}
