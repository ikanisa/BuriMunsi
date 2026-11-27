package rw.ikanisa.burimunsi.listingdownloadtests

import android.app.Application
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import rw.ikanisa.burimunsi.ui.*
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.export.*
import rw.ikanisa.burimunsi.data.*
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real controller/collector/encoders with synthetic repository and document-provider boundaries. */
fun main()=runBlocking {
    var checks=0
    fun ck(label:String,value:Boolean){check(value){label};println("PASS $label");checks++}
    val root=Files.createTempDirectory("burimunsi-download-checks").toFile()
    val directory=java.io.File(root,"burimunsi-exports")
    val m=BuriViewModel(Application())
    var picker:DownloadRequest?=null
    fun take()=m.takeDownloadRequest().also{if(it!=null)picker=it}
    fun destination(write:((java.io.File,()->Unit)->Unit)?,abort:()->Unit={}){
        val request=picker?:error("No test picker")
        m.downloadDestination(request.id,request.format,write,abort);picker=null
    }
    suspend fun idle(){withTimeout(10_000){while(m.state.busy)delay(2)};delay(25);withTimeout(10_000){while(m.state.busy)delay(2)}}
    suspend fun prepared(){withTimeout(10_000){while(m.exportFeedback?.phase==UiExportPhase.PREPARING||m.state.busy)delay(2)}}
    try{
        idle();m.onForeground();idle()
        var rendered:ExportTable?=null
        m.configureDownloads(directory){format,table,file,cancelled->
            rendered=table
            file.outputStream().use{when(format){ExportFormat.XLSX->XlsxEncoder.write(table,it,cancelled);ExportFormat.CSV->CsvEncoder.write(table,it,cancelled);ExportFormat.PDF->it.write("synthetic-pdf-boundary".toByteArray())}}
        }
        m.navigate(Route.MEMBERS);idle()
        val memberFilter=ListingQuery(q="first name",active="active",sort=ListingSort.NAME_ASC)
        m.applyListingQuery(memberFilter);idle()
        m.search("current member");m.searchSubmit();idle();m.openSheet(Sheet.FILTERS)
        ck("member filters inherit the current directory search alongside its saved selectors",
            m.listingQuery==memberFilter.copy(q="current member"))
        m.closeSheet();idle()
        Fixture.paged={target,cursor,_,_->
            val count=if(target=="PAYMENTS")151 else 1
            val ids=if(cursor==null)(1..minOf(count,100)).map{"row-$it"}else(101..count).map{"row-$it"}
            Page(ids,if(count>100&&cursor==null)"page-2"else null,count,"revision-stable","2026-11-14T14:00:00Z")
        }
        m.navigate(Route.PAYMENTS);idle()
        val selected=ListingQuery(q="payer",filter="allocated",sort=ListingSort.AMOUNT_DESC,
            minRwf=100,maxRwf=50_000,fromAt="2026-11-01T00:00:00Z",untilAt="2026-12-01T00:00:00Z",direction="incoming")
        m.openSheet(Sheet.FILTERS);idle();m.applyListingQuery(selected);idle()
        ck("filter apply restores origin and sends every selected selector",m.state.sheet==null&&m.listingQuery==selected&&Fixture.listingQueries.last().query==selected)
        m.openSheet(Sheet.FILTERS);idle();m.resetListingQuery()
        ck("reset is a filter draft until Apply",m.listingQuery==ListingQuery.defaultsFor(ListingTarget.PAYMENTS))
        m.closeSheet();idle()
        ck("cancelling filter reset preserves active selectors and existing rows",m.listingQuery==selected&&m.state.payments?.totalCount==151)
        m.prepareDownload(ExportFormat.XLSX);prepared()
        ck("Excel preparation fetches all matching pages, not only the visible hundred",rendered?.rowCount==151&&m.state.payments?.items?.size==100&&m.exportFeedback?.phase==UiExportPhase.CHOOSING_DESTINATION)
        val request=take()
        ck("document picker is consumed exactly once with a genuine XLSX MIME",request?.format==ExportFormat.XLSX&&request.fileName.endsWith(".xlsx")&&take()==null)
        val output=java.io.File(root,"saved.xlsx");var aborted=0
        m.onBackground()
        destination({file,check->check();file.copyTo(output);check()},{aborted++})
        ck("destination result waits behind foreground session validation",!output.exists()&&m.screenGate==ScreenGate.BACKGROUND)
        m.onForeground();idle()
        ck("provider close confirms success and removes only the private temporary file",m.exportFeedback?.phase==UiExportPhase.COMPLETE&&output.readBytes().take(2)==listOf(80.toByte(),75.toByte())&&directory.listFiles().isNullOrEmpty()&&aborted==0)
        ck("all export pages use the same selected filters and sort",Fixture.listingQueries.filter{it.target==ListingTarget.PAYMENTS}.all{it.query==selected||it.query==ListingQuery()})
        m.dismissExportFeedback();m.prepareDownload(ExportFormat.XLSX);prepared();take()
        destination({_,_->throw java.io.IOException("synthetic provider failure")},{aborted++});idle()
        ck("write failure is never reported as saved and removes the new partial destination",m.exportFeedback?.phase==UiExportPhase.FAILED&&aborted==1&&directory.listFiles().isNullOrEmpty())
        m.dismissExportFeedback();m.prepareDownload(ExportFormat.PDF);prepared();take();destination(null)
        ck("picker cancellation has no success or retained private file",m.exportFeedback?.phase==UiExportPhase.CANCELLED&&directory.listFiles().isNullOrEmpty())
        m.prepareDownload(ExportFormat.XLSX);prepared();val oldPicker=take()!!;m.cancelExport()
        m.prepareDownload(ExportFormat.PDF);prepared()
        ck("cancelled outstanding picker prevents a replacement download",m.downloadRequest==null&&!m.canExportListing)
        var staleWrites=0;var staleAborts=0
        m.downloadDestination(oldPicker.id,oldPicker.format,{_,_->staleWrites++},{staleAborts++});delay(50)
        ck("late retired picker result is discarded without writing",staleWrites==0&&staleAborts==1&&m.canExportListing)
        m.prepareDownload(ExportFormat.PDF);prepared();val newPicker=take()!!
        m.downloadDestination(oldPicker.id,oldPicker.format,{_,_->staleWrites++},{staleAborts++});delay(50)
        ck("stale request ID cannot consume or save a newer format picker",staleWrites==0&&staleAborts==2&&!m.canExportListing)
        m.downloadDestination(newPicker.id,newPicker.format,null)
        picker=null
        Fixture.paged={_,cursor,_,_->Page(listOf(if(cursor==null)"row-1"else"row-2"),if(cursor==null)"page-2"else null,2,if(cursor==null)"before"else"changed","2026-11-14T14:00:00Z")}
        m.prepareDownload(ExportFormat.XLSX);prepared()
        ck("a changed dataset rejects the entire download rather than publishing partial rows",m.exportFeedback?.phase==UiExportPhase.FAILED&&m.downloadRequest==null&&directory.listFiles().isNullOrEmpty())
        Fixture.paged={_,_,_,_->Page(listOf("member-1"),null,1,"one","2026-11-14T14:00:00Z")}
        m.openSheet(Sheet.STAFF);idle();m.openSheet(Sheet.FILTERS);idle()
        ck("staff filter overlay keeps its own listing origin",m.listingTarget==ListingTarget.STAFF)
        val staffQuery=ListingQuery.defaultsFor(ListingTarget.STAFF).copy(q="staff",active="active",sort=ListingSort.PHONE_ASC)
        m.applyListingQuery(staffQuery);idle()
        ck("staff Apply returns to Staff without replacing the parent payment query",m.state.sheet==Sheet.STAFF&&m.listingQuery==staffQuery&&Fixture.listingQueries.last().target==ListingTarget.STAFF)
        m.closeSheet();idle();ck("closing Staff restores the selected transaction context",m.listingQuery==selected)
        m.search("new reference");m.searchSubmit();idle();m.setFilter("unallocated");idle()
        m.openSheet(Sheet.FILTERS)
        val quickFilters=selected.copy(q="new reference",filter="unallocated")
        ck("global filters inherit the payment search and allocation chip alongside advanced selectors",
            m.listingQuery==quickFilters)
        m.applyListingQuery(m.listingQuery.copy(sort=ListingSort.OLDEST));idle()
        ck("changing the sort through filters keeps the visible search and allocation scope",
            m.listingQuery==quickFilters.copy(sort=ListingSort.OLDEST)&&Fixture.listingQueries.last().query==m.listingQuery)
        m.applyListingQuery(selected);idle()
        m.prepareDownload(ExportFormat.XLSX);prepared();take()
        Fixture.refreshedRole=Role.STAFF;Fixture.refreshedCaps=setOf(Capability.READ.key)
        var writes=0
        destination({_,_->writes++},{aborted++});idle()
        ck("role changes during the final live check prevent any provider write",writes==0&&m.exportFeedback?.phase!=UiExportPhase.COMPLETE&&aborted==2&&directory.listFiles().isNullOrEmpty())
        Fixture.refreshedRole=null;Fixture.refreshedCaps=null
        m.refreshSession();idle()
        Fixture.paged={target,cursor,id,_->
            if(target=="MEMBER"){
                val range=if(cursor==null)1..100 else 101..103
                Page(range.map{"$id-tx-$it"},if(cursor==null)"page-two" else null,103,"member-revision","2026-11-14T14:00:00Z")
            }else Page(listOf("global-only-payment"),null,1,"global-revision","2026-11-14T14:00:00Z")
        }
        m.navigate(Route.PAYMENTS);idle();m.applyListingQuery(selected);idle()
        m.navigate(Route.PAYMENTS,"member-1");idle()
        ck("a statement opens without global filters and binds its verified directory member",
            m.listingQuery==ListingQuery()&&m.state.member==Fixture.member&&m.state.payments?.items?.all{it.memberId=="member-1"}==true)
        val statementQuery=ListingQuery(sort=ListingSort.OLDEST,q="member reference",minRwf=500,direction="incoming")
        m.search(statementQuery.q);m.searchSubmit();idle();m.openSheet(Sheet.FILTERS)
        ck("statement filters inherit the search currently applied to its transactions",m.listingQuery.q==statementQuery.q)
        m.applyListingQuery(statementQuery);idle()
        m.listPosition(Route.PAYMENTS,"member-1",7,12)
        m.navigate(Route.PAYMENT,"member-1-tx-1");idle();m.back();idle()
        ck("returning from a transaction restores the member, filtered statement and position",
            m.state.routeId=="member-1"&&m.state.member==Fixture.member&&m.listingQuery==statementQuery&&m.state.listIndex==7)
        m.prepareDownload(ExportFormat.CSV);prepared()
        ck("legacy ledger export cannot dispatch from any list",m.downloadRequest==null)
        Fixture.listingQueries.clear()
        m.prepareDownload(ExportFormat.XLSX);prepared()
        val statementRequest=take()
        ck("the statement reads every page under the same member, filters and sort",
            rendered?.let{it.title=="BuriMunsi · Member statement"&&it.rowCount==103}==true&&m.state.payments?.items?.size==100&&
            statementRequest?.fileName?.contains("member-statement")==true&&Fixture.listingQueries.map{it.cursor}==listOf(null,"page-two")&&
            Fixture.listingQueries.all{it.target==ListingTarget.PAYMENTS&&it.query==statementQuery&&it.memberId=="member-1"})
        val statementFile=java.io.File(root,"member-statement.xlsx")
        destination({file,revalidate->revalidate();file.copyTo(statementFile);revalidate()});idle()
        val sheet=java.util.zip.ZipFile(statementFile).use{zip->zip.getInputStream(zip.getEntry("xl/worksheets/sheet1.xml")).bufferedReader().use{it.readText()}}
        ck("the saved statement contains the directory identity and second-page transaction in order",
            m.exportFeedback?.phase==UiExportPhase.COMPLETE&&sheet.contains(Fixture.member.name)&&
            sheet.indexOf("member-1-tx-103")>sheet.indexOf("member-1-tx-100")&&sheet.contains("member-1-tx-100")&&
            !sheet.contains("global-only-payment")&&!sheet.contains("member-2-tx-"))
        Fixture.memberPaymentScopeFailureOnCursor=true
        try{
            m.prepareDownload(ExportFormat.PDF);prepared()
            ck("a foreign later page cannot reach the document picker",m.exportFeedback?.phase==UiExportPhase.FAILED&&m.downloadRequest==null)
        }finally{Fixture.memberPaymentScopeFailureOnCursor=false}
        m.back();idle()
        ck("back restores the global payment query",m.state.route==Route.PAYMENTS&&m.state.routeId==null&&m.listingQuery==selected)
        m.navigate(Route.PAYMENTS,"member-1");idle()
        ck("reopening a statement restores all transactions from the first page",m.listingQuery==ListingQuery()&&m.state.listIndex==0)
        val readingMember=CountDownLatch(1);val allowMember=CountDownLatch(1)
        Fixture.paymentsEntered=readingMember;Fixture.paymentsBarrier=allowMember
        try{
            m.navigate(Route.PAYMENTS,"member-2")
            withContext(Dispatchers.IO){check(readingMember.await(5,TimeUnit.SECONDS))}
            ck("changing members clears the previous identity and transactions while reading",
                m.state.routeId=="member-2"&&m.state.member==null&&m.state.payments==null&&!m.canExportListing)
        }finally{allowMember.countDown();Fixture.paymentsEntered=null;Fixture.paymentsBarrier=null}
        idle()
        ck("the new statement publishes only its exact member and transactions",
            m.state.member?.id=="member-2"&&m.state.payments?.items?.all{it.memberId=="member-2"}==true)
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        m.configureDownloads(directory){_,_,_,cancelled->entered.countDown();check(release.await(5,TimeUnit.SECONDS));if(cancelled())throw ExportCancelledException()}
        m.prepareDownload(ExportFormat.XLSX)
        withContext(Dispatchers.IO){check(entered.await(5,TimeUnit.SECONDS))}
        m.onBackground();release.countDown();idle()
        ck("unexpected background cancels preparation and clears its private file",m.downloadRequest==null&&m.exportFeedback?.phase==UiExportPhase.CANCELLED&&directory.listFiles().isNullOrEmpty())

        m.onForeground();idle()
        val finalValidation = CountDownLatch(1)
        val finishValidation = CountDownLatch(1)
        m.configureDownloads(directory) { _, _, _, _ ->
            Fixture.recordScopeValidated = {
                finalValidation.countDown()
                check(finishValidation.await(5, TimeUnit.SECONDS))
            }
        }
        try {
            m.prepareDownload(ExportFormat.XLSX)
            withContext(Dispatchers.IO) { check(finalValidation.await(5, TimeUnit.SECONDS)) }
            m.onBackground()
        } finally {
            Fixture.recordScopeValidated = null
            finishValidation.countDown()
        }
        idle()
        ck("background during the final authority check cannot publish a picker",m.downloadRequest==null&&m.exportFeedback?.phase==UiExportPhase.CANCELLED&&directory.listFiles().isNullOrEmpty())

        val recreated=BuriViewModel(Application())
        try{
            withTimeout(10_000){while(recreated.state.busy)delay(2)}
            recreated.restoreDownloadPicker(900,ExportFormat.XLSX)
            recreated.onForeground();delay(50);withTimeout(10_000){while(recreated.state.busy)delay(2)}
            recreated.navigate(Route.PAYMENTS);delay(50);withTimeout(10_000){while(recreated.state.busy)delay(2)}
            recreated.prepareDownload(ExportFormat.XLSX)
            ck("fresh process restores a retired picker lease before allowing replacement",!recreated.canExportListing&&recreated.downloadRequest==null)
            var orphanWrites=0;var orphanAborts=0
            recreated.downloadDestination(900,ExportFormat.XLSX,{_,_->orphanWrites++},{orphanAborts++})
            delay(50)
            ck("restored orphan picker is discarded without any exported bytes",orphanWrites==0&&orphanAborts==1&&recreated.canExportListing)
        }finally{recreated.viewModelScope.cancel()}
        ck("filtering and downloads never submit or reconcile financial commands",Fixture.mutations==0&&Fixture.reconciles==0)
    }finally{m.viewModelScope.cancel();root.deleteRecursively()}
    println("RESULT: $checks listing/download controller checks passed; Android rendering and live provider behavior require their separate device gates.")
}
