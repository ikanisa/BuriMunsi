package rw.ikanisa.burimunsi.core

/** Never silently de-duplicate incompatible snapshots or loop a provider cursor. */
object PageIntegrity {
    const val MAX_RETAINED = 100_000
    fun <T> append(current:Page<T>,next:Page<T>,id:(T)->String):Page<T> {
        val collector=Accumulator(current,id)
        collector.append(next)
        return collector.snapshot()
    }

    class Accumulator<T>(initial:Page<T>,private val id:(T)->String) {
        private var tail=initial
        private val items=initial.items.toMutableList()
        private val keys=initial.items.map(id).toMutableSet()
        val size:Int get()=items.size
        val nextCursor:String? get()=tail.nextCursor

        fun append(next:Page<T>, maximum:Int=MAX_RETAINED):Boolean {
            checkContract(tail.nextCursor!=null,"pagination_complete")
            checkContract(tail.revision==next.revision&&tail.totalCount==next.totalCount,"cursor_stale")
            checkContract(next.nextCursor==null||next.nextCursor!=tail.nextCursor,"invalid_page")
            val count=items.size+next.items.size
            checkContract(count<=MAX_RETAINED&&count<=tail.totalCount,"invalid_page")
            val incoming=next.items.map(id).toSet()
            checkContract(keys.size==items.size&&incoming.size==next.items.size&&incoming.none{it in keys},"invalid_page")
            checkContract(next.items.isNotEmpty(),"invalid_page")
            checkContract((next.nextCursor==null)==(count==tail.totalCount),"invalid_page")
            if(count>maximum)return false
            keys.addAll(incoming)
            items.addAll(next.items)
            tail=next
            return true
        }

        fun snapshot():Page<T> = tail.copy(items=items.toList())
    }
}
