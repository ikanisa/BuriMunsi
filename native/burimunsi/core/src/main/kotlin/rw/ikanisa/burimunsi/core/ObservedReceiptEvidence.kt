package rw.ikanisa.burimunsi.core

/** A bounded intake candidate, not proof of a transaction. Keep unmatched texts local. */
object ObservedReceiptEvidence {
    private val starts = listOf(
        "you have sent", "you have paid", "withdrawal", "withdrawn",
        "reversal", "reversed", "extournée", "yarasubijwe", "transfer fee",
    )
    private val atom = Regex("""[\p{L}\p{N} .:_-]{1,80}""")
    private val boundary = """(?![\p{L}\p{N}_])"""
    private val gap = Regex("""^\s*(?:(?:accepted|processed)\b[ \t.:;-]*)?[ \t.:;-]*$""", RegexOption.IGNORE_CASE)
    private fun valid(values: Set<String>) = values.size in 1..30 && values.all { it == it.trim() && atom.matches(it) }
    private fun labels(xs: Iterable<String>) = xs.joinToString("|", transform = Regex::escape)
    fun matches(body: String, profile: ReceiptProfile): Boolean {
        if (body.length !in 1..3000 || !valid(profile.incomingPrefixes) ||
            !valid(profile.currencyAliases) || !valid(profile.transactionIdPrefixes)) return false
        val ref = Regex("""(?<![\p{L}\p{N}_])(?:${labels(profile.transactionIdPrefixes)})[ \t:#-]*[A-Z0-9][A-Z0-9_-]{3,63}$boundary""",
            RegexOption.IGNORE_CASE).find(body) ?: return false
        // Already supported by the parser. Keep generic, unfinished notices unconfirmed.
        val outgoing = Regex("""^\s*your payment of[ \t]+(?:${labels(profile.currencyAliases)})[ \t]+(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?![\p{L}\p{N}.,_])[ \t]+to[ \t]+[^.!?\r\n]{1,120}[ \t]+has been completed(?=[.!? \t])""",
            RegexOption.IGNORE_CASE).find(body)
        if (outgoing != null && outgoing.range.last < ref.range.first) return true
        val reversal = Regex("""^\s*transaction reversed for[ \t]+(?:${labels(profile.currencyAliases)})[ \t]+(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?=[.!?](?:[ \t\r\n]|$))""",
            RegexOption.IGNORE_CASE).find(body)
        if (reversal != null && reversal.range.last < ref.range.first) return true
        val first = Regex("""^\s*(?:${labels(profile.incomingPrefixes + starts)})$boundary""", RegexOption.IGNORE_CASE).find(body) ?: return false
        val money = Regex("""(?<![\p{L}\p{N}.,_])(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)[ \t]+(?:${labels(profile.currencyAliases)})$boundary""",
            RegexOption.IGNORE_CASE).find(body) ?: return false
        if (first.range.last >= money.range.first || money.range.last >= ref.range.first) return false
        return gap.matches(body.substring(first.range.last + 1, money.range.first))
    }

    fun isNewCandidate(sender: String, body: String, profile: ReceiptProfile): Boolean =
        ObservationCandidate.accepts(sender, body, profile) && matches(body, profile)
}
