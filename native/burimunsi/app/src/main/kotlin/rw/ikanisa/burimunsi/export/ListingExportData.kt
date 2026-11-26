package rw.ikanisa.burimunsi.export

import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.export.*
import rw.ikanisa.burimunsi.data.NativeRepository
import rw.ikanisa.burimunsi.data.RecordReadScope
import rw.ikanisa.burimunsi.gateway.GatewayPort
import java.time.Instant
import java.time.ZoneId

/** Fetches complete, authorized online pages without reading message bodies. */
internal class ListingExportData(private val repository:NativeRepository,private val gateway:GatewayPort) {
    data class Snapshot(val table:ExportTable,val validateLocal:()->Unit={})

    companion object {
        private fun text(value:String?)=value?.let{ExportCell.Text(it)}?:ExportCell.Blank
        private fun money(value:Long?)=value?.let{ExportCell.Money(it,"RWF")}?:ExportCell.Blank
        private fun date(value:String):ExportCell=runCatching{ExportCell.DateTime(Instant.parse(value))}.getOrElse{ExportCell.Text(value)}
        private fun columns(vararg names:String)=names.mapIndexed{index,name->ExportColumn("c$index",name,if(name.contains("name",true))3 else 2)}

        fun memberStatementTable(member:Member,values:List<Payment>,generatedAt:Instant,zone:ZoneId,details:List<ExportDetail>):ExportTable {
            checkContract(values.all{it.memberId==member.id&&it.state!="unallocated"},"invalid_member_payment_scope")
            val identity=listOf(ExportDetail("Member",member.name),ExportDetail("Member ID",member.id))
            val rows=values.map{payment->listOf(
                date(payment.atRaw),text(payment.payerNameRaw),text(payment.ftId),text(PaymentPresentation.directionLabel(payment.direction)),
                money(payment.amountRwf),money(payment.feeRwf),text(payment.id),
            )}
            return ExportTable("BuriMunsi · Member statement",generatedAt,zone,identity+details,
                columns("Date","Counterparty name","FT ID","Direction","Amount (RWF)","Fee (RWF)","Payment ID"),rows)
        }
    }

    fun collect(target:ListingTarget,query:ListingQuery,memberId:String?,scope:RecordReadScope,
        generatedAt:Instant,zone:ZoneId,check:()->Unit,progress:(Int,Int)->Unit):Snapshot {
        query.validated(target)
        var firstAsOf:String?=null
        fun <T> pages(id:(T)->String,read:(String?)->Page<T>):List<T> {
            check();repository.validateRecordReadScope(scope)
            val page=read(null)
            if(firstAsOf==null)firstAsOf=page.asOf
            checkContract(page.totalCount in 0..20_000,"export_limit")
            checkContract(page.items.map(id).toSet().size==page.items.size&&page.items.size<=page.totalCount,"invalid_page")
            checkContract((page.nextCursor==null)==(page.items.size==page.totalCount),"invalid_page")
            val seen=mutableSetOf<String>()
            val records=PageIntegrity.Accumulator(page,id)
            if(target !in setOf(ListingTarget.SMS,ListingTarget.OBSERVATIONS))progress(page.items.size,page.totalCount)
            while(records.nextCursor!=null){
                check();repository.validateRecordReadScope(scope)
                val cursor=checkNotNull(records.nextCursor);checkContract(seen.add(cursor),"invalid_page")
                val next=read(cursor)
                checkContract(next.nextCursor==null||next.nextCursor !in seen,"invalid_page")
                records.append(next)
                if(target !in setOf(ListingTarget.SMS,ListingTarget.OBSERVATIONS))progress(records.size,page.totalCount)
            }
            check();repository.validateRecordReadScope(scope)
            return records.snapshot().items
        }
        fun details(rowCount:Int):List<ExportDetail> {
            val details=mutableListOf(ExportDetail("Collection",repository.boundCollectionId?:throw ContractFailure("session_changed")),
                ExportDetail("Scope",if(target in setOf(ListingTarget.SMS,ListingTarget.OBSERVATIONS))"Authorized source metadata; message text and previews omitted" else "All matching authorized records"),
                ExportDetail("Snapshot read",firstAsOf?:generatedAt.toString()),ExportDetail("Rows",rowCount.toString()),
                ExportDetail("Sort",query.sort.wire))
            query.queryValues(target).filterKeys{it!="sort"}.filterValues{it.isNotBlank()&&it!="all"}.forEach{(key,value)->details+=ExportDetail(key,value)}
            return details
        }
        fun finish(table:ExportTable,localCheck:()->Unit={}):Snapshot {
            check();repository.validateRecordReadScope(scope);localCheck()
            table.validate(cancelled={try{check();false}catch(_:Exception){true}})
            return Snapshot(table,localCheck)
        }
        if(memberId!=null){
            checkContract(target==ListingTarget.PAYMENTS,"invalid_member_payment_scope")
            check()
            val member=repository.member(memberId,scope)
            val values=pages<Payment>(Payment::id){cursor->repository.payments(query,cursor,memberId,scope)}
            return finish(memberStatementTable(member,values,generatedAt,zone,details(values.size)))
        }
        var localCheck:()->Unit={}
        val (title,cols,rows)=when(target){
            ListingTarget.PAYMENTS->{
                val values=pages<Payment>({it.id}){repository.payments(query,it,scope=scope)}
                Triple("Payments",
                    columns("Date","Counterparty name","MoMo number","Amount (RWF)","Fee (RWF)","Direction","Allocation","FT ID","Member MoMo"),
                    values.map{p->listOf(date(p.atRaw),text(p.payerNameRaw),text(p.payerPhoneRaw),money(p.amountRwf),money(p.feeRwf),text(p.direction),text(PaymentPresentation.payment(p).label),text(p.ftId),text(p.memberPhone))})
            }
            ListingTarget.MEMBERS->{
                val values=pages<Member>({it.id}){repository.members(query,it,scope)}
                Triple("Members",columns("Name","MoMo number","Active","Member ID"),
                    values.map{m->listOf(text(m.name),text(m.phone),ExportCell.Boolean(m.active),text(m.id))})
            }
            ListingTarget.STAFF->{
                val values=pages<StaffAccount>({it.id}){repository.staff(query,it,scope)}
                Triple("Staff",columns("Name","Login phone","Active","Permissions","Account ID"),
                    values.map{v->listOf(text(v.name),text(v.phone),ExportCell.Boolean(v.active),text(v.capabilities.sorted().joinToString(", ")),text(v.id))})
            }
            ListingTarget.AUDIT->{
                val values=pages<AuditRow>({it.id}){repository.audit(query,it,scope)}
                Triple("Activity log",columns("Date","Action","Event ID"),values.map{v->listOf(date(v.at),text(v.action),text(v.id))})
            }
            ListingTarget.SMS,ListingTarget.OBSERVATIONS->{
                // This is an index of retained sources, not a bulk raw-message disclosure.
                data class Metadata(val at:String,val kind:String,val id:String,val sender:String?,val status:String?,val transaction:String?)
                val metadata=mutableListOf<Metadata>()
                if(target==ListingTarget.SMS&&query.filter!="queued"&&gateway.bound()){
                    pages<SmsRow>({it.id}){repository.sms(query,it,scope)}.forEach{metadata+=Metadata(it.at,"Canonical",it.id,it.sender,it.state,it.transactionId)}
                }
                if(target==ListingTarget.OBSERVATIONS||query.filter=="all"){
                    val oq=query.copy(filter="all")
                    pages<ObservationListRow>({it.source.id}){repository.observationPage(oq,it,scope)}.forEach{metadata+=Metadata(it.retainedAt,"Observation",it.source.id,null,null,null)}
                }
                if(target==ListingTarget.SMS&&query.filter in setOf("all","queued")){
                    val queued=gateway.queuedObservations("")?.let{it.copy(items=it.items.map{row->row.copy(preview="")})}?:throw ContractFailure("queue_unavailable")
                    fun matches(v:QueuedObservationRow):Boolean {
                        val at=runCatching{Instant.parse(v.at)}.getOrNull()?:return false
                        return (query.fromAt==null||at>=Instant.parse(query.fromAt))&&(query.untilAt==null||at<Instant.parse(query.untilAt))&&
                            (query.q.isBlank()||listOf(v.id,v.sender).any{it.contains(query.q,true)})
                    }
                    queued.items.filter(::matches).forEach{metadata+=Metadata(it.at,"Queued on this phone",it.id,it.sender,"queued",null)}
                    localCheck={checkContract(gateway.publishQueued(queued){},"cursor_stale")}
                    localCheck()
                }
                checkContract(metadata.size<=20_000,"export_limit")
                val sorted=metadata.sortedWith(compareBy<Metadata>{Instant.parse(it.at)}.thenBy{it.kind}.thenBy{it.id}).let{if(query.sort==ListingSort.NEWEST)it.reversed()else it}
                Triple("SMS source metadata",columns("Date","Source kind","Source ID","Sender","Status","Payment ID"),
                    sorted.map{v->listOf(date(v.at),text(v.kind),text(v.id),text(v.sender),text(v.status),text(v.transaction))})
            }
        }
        return finish(ExportTable("BuriMunsi · $title",generatedAt,zone,details(rows.size),cols,rows),localCheck)
    }
}
