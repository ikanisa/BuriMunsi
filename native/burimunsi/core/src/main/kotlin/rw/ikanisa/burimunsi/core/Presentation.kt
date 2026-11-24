package rw.ikanisa.burimunsi.core

data class ReceiptPresentation(val label: String, val icon: String, val tone: String)

object Presentation {
    fun receipt(value: String?): ReceiptPresentation = when (value) {
        "synced" -> ReceiptPresentation("Synced", "sync", "info")
        "queued" -> ReceiptPresentation("Queued", "clock", "warn")
        "duplicate" -> ReceiptPresentation("Duplicate", "history", "info")
        "rejected" -> ReceiptPresentation("Rejected", "alert", "bad")
        else -> ReceiptPresentation("Status unavailable", "alert", "warn")
    }

    const val MONEY_MIN_SP = 16
    const val NAME_MIN = 2
    const val NAME_MAX = 100

    fun validName(value: String) = value.trim().length in NAME_MIN..NAME_MAX &&
        value.none { it.code < 32 || it.code == 127 }
}
