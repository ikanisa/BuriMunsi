package rw.ikanisa.burimunsi.core

data class PaymentStatus(val label: String, val icon: String, val tone: String)

object PaymentPresentation {
    fun payment(value:Payment):PaymentStatus = if (value.state == "allocated" || value.state == "posted")
        PaymentStatus("Allocated", "check", "good") else PaymentStatus("Unallocated", "link", "warn")

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
