package rw.ikanisa.burimunsi.core

data class PaymentStatus(val label: String, val icon: String, val tone: String)

object PaymentPresentation {
    private fun isAllocated(value:Payment) = value.state == "allocated" || value.state == "posted"
    fun linkedMemberId(value:Payment):String? = value.memberId?.takeIf { it.isNotBlank() && isAllocated(value) }
    fun payment(value:Payment):PaymentStatus = if (isAllocated(value))
        PaymentStatus("Allocated", "link", "good") else PaymentStatus("Unallocated", "unlinked", "warn")

    fun canAllocate(value:Payment) = value.state == "unallocated" &&
        (value.direction == "incoming" || value.direction == "outgoing") && value.outcome == "successful" &&
        (value.amountRwf ?: 0L) > 0L
    fun directionLabel(value:String)=when(value){
        "incoming"->"Incoming"
        "outgoing"->"Outgoing"
        "reversal"->"Reversal"
        else->"Other"
    }
}
