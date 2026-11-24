package rw.ikanisa.burimunsi.core

import java.time.Instant

enum class ListingTarget { PAYMENTS, MEMBERS, SMS, OBSERVATIONS, STAFF, AUDIT }
enum class ListingSort(val wire:String) {
    NEWEST("newest"), OLDEST("oldest"), AMOUNT_ASC("amount_asc"), AMOUNT_DESC("amount_desc"),
    NAME_ASC("name_asc"), NAME_DESC("name_desc"), PHONE_ASC("phone_asc"), PHONE_DESC("phone_desc"),
    ACTION_ASC("action_asc"), ACTION_DESC("action_desc")
}

/** Server query over the full authorized matching dataset. Dates are UTC
 * instants with an inclusive lower and exclusive upper bound.
 * SMS queries operate only on already-authorized metadata, never raw bodies. */
data class ListingQuery(
    val q:String="", val filter:String="all", val sort:ListingSort=ListingSort.NEWEST,
    val fromAt:String?=null, val untilAt:String?=null, val minRwf:Long?=null, val maxRwf:Long?=null,
    val active:String="all", val direction:String="all"
) {
    companion object {
        fun defaultsFor(target:ListingTarget)=ListingQuery(sort=if(target==ListingTarget.STAFF)ListingSort.NAME_ASC else ListingSort.NEWEST)
        fun allowedSorts(target:ListingTarget):List<ListingSort> = listOf(ListingSort.NEWEST,ListingSort.OLDEST)+when(target) {
            ListingTarget.PAYMENTS -> listOf(ListingSort.AMOUNT_ASC,ListingSort.AMOUNT_DESC)
            ListingTarget.MEMBERS,ListingTarget.STAFF -> listOf(ListingSort.NAME_ASC,ListingSort.NAME_DESC,ListingSort.PHONE_ASC,ListingSort.PHONE_DESC)
            ListingTarget.AUDIT -> listOf(ListingSort.ACTION_ASC,ListingSort.ACTION_DESC)
            else -> emptyList()
        }
        fun supportsDates(target:ListingTarget)=target!=ListingTarget.MEMBERS&&target!=ListingTarget.STAFF
        fun supportsAmount(target:ListingTarget)=target==ListingTarget.PAYMENTS
        fun supportsActive(target:ListingTarget)=target in setOf(ListingTarget.MEMBERS,ListingTarget.STAFF)
        fun supportsDirection(target:ListingTarget)=target==ListingTarget.PAYMENTS
        fun filters(target:ListingTarget):List<String> = when(target) {
            ListingTarget.PAYMENTS -> listOf("all","allocated","unallocated")
            ListingTarget.SMS -> listOf("all","queued","duplicate","synced","rejected")
            else -> listOf("all")
        }
    }
    fun validated(target:ListingTarget):ListingQuery {
        checkContract(q.length<=80&&!q.any{it.code<32||it.code in 127..159},"invalid_query")
        checkContract(sort in allowedSorts(target)&&filter in filters(target),"invalid_filter")
        checkContract(active in setOf("all","active","inactive")&&(active=="all"||supportsActive(target)),"invalid_filter")
        checkContract(direction in setOf("all","incoming","outgoing")&&(direction=="all"||supportsDirection(target)),"invalid_filter")
        checkContract((minRwf==null&&maxRwf==null)||supportsAmount(target),"invalid_filter")
        for(v in listOfNotNull(minRwf,maxRwf))checkContract(v in 0..Values.MAX_RWF,"invalid_amount")
        checkContract(minRwf==null||maxRwf==null||minRwf<=maxRwf,"invalid_amount")
        checkContract((fromAt==null&&untilAt==null)||supportsDates(target),"invalid_filter")
        fun instant(value:String?):Instant?=value?.let{
            checkContract(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z").matches(it),"invalid_timestamp")
            val parsed=try{Instant.parse(it)}catch(_:Exception){throw ContractFailure("invalid_timestamp")}
            checkContract(parsed.toString().take(19)==it.take(19),"invalid_timestamp");parsed
        }
        val start=instant(fromAt);val end=instant(untilAt)
        checkContract(start==null||end==null||start<end,"invalid_timestamp")
        return this
    }
    fun queryValues(target:ListingTarget):Map<String,String> {
        validated(target)
        return linkedMapOf("q" to q,"filter" to filter,"sort" to sort.wire).apply {
            fromAt?.let{put("fromAt",it)};untilAt?.let{put("untilAt",it)}
            minRwf?.let{put("minRwf",it.toString())};maxRwf?.let{put("maxRwf",it.toString())}
            if(active!="all")put("active",active);if(direction!="all")put("direction",direction)
        }
    }
}
