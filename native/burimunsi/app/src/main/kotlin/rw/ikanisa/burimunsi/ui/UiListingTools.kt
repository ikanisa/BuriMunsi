package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.export.ExportFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

private val ListingZone=ZoneId.of("Africa/Kigali")
internal fun listingSortLabel(value:ListingSort)=when(value){
    ListingSort.NEWEST->"Newest first";ListingSort.OLDEST->"Oldest first"
    ListingSort.AMOUNT_ASC->"Amount · low to high";ListingSort.AMOUNT_DESC->"Amount · high to low"
    ListingSort.NAME_ASC->"Name · A–Z";ListingSort.NAME_DESC->"Name · Z–A"
    ListingSort.PHONE_ASC->"Phone · ascending";ListingSort.PHONE_DESC->"Phone · descending"
    ListingSort.ACTION_ASC->"Action · A–Z";ListingSort.ACTION_DESC->"Action · Z–A"
}
internal fun listingValueLabel(value:String)=when(value){
    "all"->"All";"allocated"->"Allocated";"unallocated"->"Unallocated"
    "queued"->"Queued";"duplicate"->"Duplicates";"synced"->"Synced";"rejected"->"Rejected"
    "active"->"Active";"inactive"->"Inactive";"incoming"->"Incoming";"outgoing"->"Outgoing"
    else->"Other"
}
private fun dateText(value:String?,exclusive:Boolean=false):String=value?.let{runCatching{
    (if(exclusive)Instant.parse(it).minusNanos(1)else Instant.parse(it)).atZone(ListingZone).toLocalDate().toString()
}.getOrNull()}.orEmpty()
private fun selectedBound(value:String,end:Boolean):String?=value.takeIf{it.isNotBlank()}?.let{
    val day=LocalDate.parse(it);(if(end)day.plusDays(1)else day).atStartOfDay(ListingZone).toInstant().toString()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ListingToolbar(model:BuriController,onExport:()->Unit,showFilter:Boolean=true,showExport:Boolean=true){
    val target=model.listingTarget?:return
    val t=LocalUiText.current;val query=model.listingQuery
    val enabled=!model.state.busy
    val currentSort=t(listingSortLabel(query.sort))
    var sortOpen by remember(target,model.state.routeId){mutableStateOf(false)}
    val chips=buildList<Pair<String,()->Unit>>{
        if(query.q.isNotBlank())add(t("Search: %1\$s",query.q) to {model.applyListingQuery(query.copy(q=""))})
        if(query.filter!="all")add(t("Status: %1\$s",t(listingValueLabel(query.filter))) to {model.applyListingQuery(query.copy(filter="all"))})
        if(query.fromAt!=null||query.untilAt!=null)add(t("Date range") to {model.applyListingQuery(query.copy(fromAt=null,untilAt=null))})
        if(query.minRwf!=null||query.maxRwf!=null)add(t("Amount range") to {model.applyListingQuery(query.copy(minRwf=null,maxRwf=null))})
        if(query.active!="all")add(t(listingValueLabel(query.active)) to {model.applyListingQuery(query.copy(active="all"))})
        if(query.direction!="all")add(t(listingValueLabel(query.direction)) to {model.applyListingQuery(query.copy(direction="all"))})
    }
    Column(Modifier.fillMaxWidth().padding(top=10.dp,bottom=10.dp).testTag("listing-tools:${target.name}")){
        val filterControl:@Composable (Modifier)->Unit={modifier->
            val label=if(chips.isEmpty())t("Filters") else t("Filters (%1\$d)",chips.size)
            ListingAction(R.drawable.ic_filter,label,modifier,enabled){model.openSheet(Sheet.FILTERS)}
        }
        val sortControl:@Composable (Modifier)->Unit={modifier->
            ListingAction(R.drawable.ic_sort,currentSort,modifier.testTag("listing-sort-menu")
                .semantics{contentDescription=t("Sort by");stateDescription=currentSort},enabled){sortOpen=true}
        }
        val exportControl:@Composable ()->Unit={
            if(showExport&&model.canExportListing)IconButton(onExport,enabled=enabled&&!model.state.offline,modifier=Modifier.size(48.dp).background(BuriTheme.Tone,RoundedCornerShape(24.dp))){
                Icon(painterResource(R.drawable.ic_download),t("Export results"),Modifier.size(24.dp))
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth()){
            if(showFilter&&(maxWidth<340.dp||LocalDensity.current.fontScale>=1.4f)){
                Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)){
                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically){filterControl(Modifier.weight(1f));exportControl()}
                    sortControl(Modifier.fillMaxWidth())
                }
            }else Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp),verticalAlignment=Alignment.CenterVertically){
                if(showFilter)filterControl(Modifier.weight(1f))
                sortControl(Modifier.weight(if(showFilter)1.3f else 1f))
                exportControl()
            }
        }
        if(chips.isNotEmpty()){
            ScrollingChips{chip ->
                chips.forEach{(label,clear)->FilterChip(selected=true,onClick=clear,enabled=enabled,label={CompactLabel(label)},trailingIcon={Icon(painterResource(R.drawable.ic_close),t("Remove filter"),Modifier.size(16.dp))},modifier=chip.heightIn(min=48.dp),shape=RoundedCornerShape(24.dp),colors=FilterChipDefaults.filterChipColors(selectedContainerColor=BuriTheme.Text,selectedLabelColor=Color(0xFF151517),selectedTrailingIconColor=Color(0xFF151517)))}
                TextButton(model::resetListingQuery,modifier=chip,enabled=enabled){CompactLabel(t("Reset all"))}
            }
        }
    }
    if(sortOpen && enabled){
        val title=t("Sort by")
        ModalBottomSheet(onDismissRequest={sortOpen=false},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true),
            containerColor=BuriTheme.Surface,contentColor=BuriTheme.Text,shape=RoundedCornerShape(topStart=32.dp,topEnd=32.dp)){
            Column(Modifier.fillMaxWidth().heightIn(max=LocalConfiguration.current.screenHeightDp.dp*.8f)
                .verticalScroll(rememberScrollState()).padding(horizontal=20.dp).navigationBarsPadding().padding(bottom=16.dp)
                .testTag("listing-sort-choices").semantics{paneTitle=title}){
                Row(Modifier.fillMaxWidth().padding(bottom=10.dp),verticalAlignment=Alignment.CenterVertically){
                    CompactLabel(title,Modifier.weight(1f).semantics{heading()},style=MaterialTheme.typography.headlineMedium)
                    IconButton({sortOpen=false}){Glyph(R.drawable.ic_close,t("Close"))}
                }
                val sorts=ListingQuery.allowedSorts(target)
                ChoiceRows(query.sort.wire,sorts.map{it.wire to listingSortLabel(it)}){wire->
                    sortOpen=false
                    if(wire!=query.sort.wire)model.applyListingQuery(query.copy(sort=sorts.first{it.wire==wire}))
                }
            }
        }
    }
}

@Composable private fun ListingAction(icon:Int,label:String,modifier:Modifier,enabled:Boolean,open:()->Unit){
    FilledTonalButton(open,modifier.heightIn(min=48.dp),enabled=enabled,shape=RoundedCornerShape(24.dp),
        contentPadding=PaddingValues(horizontal=12.dp,vertical=8.dp),
        colors=ButtonDefaults.filledTonalButtonColors(containerColor=BuriTheme.Tone,contentColor=BuriTheme.Text)){
        Glyph(icon,null,BuriTheme.Text,20)
        Spacer(Modifier.width(7.dp))
        CompactLabel(label,Modifier.weight(1f,fill=false),style=MaterialTheme.typography.labelLarge)
    }
}

@Composable private fun ChoiceRows(value:String,choices:List<Pair<String,String>>,onSelect:(String)->Unit){
    val t=LocalUiText.current
    Column(Modifier.fillMaxWidth().selectableGroup().background(BuriTheme.Raised,RoundedCornerShape(20.dp))){
        choices.forEachIndexed{index,(key,label)->
            Row(Modifier.fillMaxWidth().heightIn(min=56.dp).selectable(selected=value==key,
                role=androidx.compose.ui.semantics.Role.RadioButton,onClick={onSelect(key)})
                .padding(horizontal=16.dp,vertical=10.dp),verticalAlignment=Alignment.CenterVertically){
                CompactLabel(t(label),Modifier.weight(1f),style=MaterialTheme.typography.bodyLarge)
                RadioButton(value==key,onClick=null,modifier=Modifier.padding(start=12.dp),
                    colors=RadioButtonDefaults.colors(selectedColor=BuriTheme.Text,unselectedColor=BuriTheme.NavigationMuted))
            }
            if(index<choices.lastIndex)HorizontalDivider(Modifier.padding(horizontal=16.dp),color=Color.White.copy(alpha=.08f))
        }
    }
}

@Composable internal fun ListingChoice(label:String,value:String,choices:List<Pair<String,String>>,enabled:Boolean,tag:String,onChange:(String)->Unit){
    val t=LocalUiText.current
    val title=t(label)
    val current=t(choices.firstOrNull{it.first==value}?.second?:"All")
    var open by remember(tag){mutableStateOf(false)}
    FilledTonalButton({open=true},Modifier.fillMaxWidth().heightIn(min=62.dp).testTag(tag)
        .semantics{contentDescription=title;stateDescription=current},enabled=enabled,shape=RoundedCornerShape(17.dp),
        colors=ButtonDefaults.filledTonalButtonColors(containerColor=BuriTheme.Raised,contentColor=BuriTheme.Text)){
        Column(Modifier.weight(1f)){
            CompactLabel(title,style=MaterialTheme.typography.labelMedium,color=BuriTheme.Muted)
            CompactLabel(current,style=MaterialTheme.typography.titleSmall)
        }
        Glyph(R.drawable.ic_arrow,null,BuriTheme.Muted,18)
    }
    if(open&&enabled)ListingChoiceDialog(title,value,choices,tag,onDismiss={open=false}){choice->
        open=false
        onChange(choice)
    }
}

@Composable private fun ListingChoiceDialog(title:String,value:String,choices:List<Pair<String,String>>,tag:String,
    onDismiss:()->Unit,onChoose:(String)->Unit){
    val t=LocalUiText.current
    AlertDialog(onDismissRequest=onDismiss,modifier=Modifier.testTag("listing-choice-dialog"),containerColor=BuriTheme.Surface,
        titleContentColor=BuriTheme.Text,textContentColor=BuriTheme.Text,
        title={CompactLabel(title,Modifier.semantics{heading()})},
        text={Column(Modifier.heightIn(max=LocalConfiguration.current.screenHeightDp.dp*.52f)
            .verticalScroll(rememberScrollState()).testTag("${tag}-choices").semantics{paneTitle=title}){
            ChoiceRows(value,choices,onChoose)
        }},
        confirmButton={TextButton(onDismiss){CompactLabel(t("Cancel"))}})
}

@Composable private fun QueryNumber(label:String,value:String,enabled:Boolean,onChange:(String)->Unit){
    val t=LocalUiText.current
    OutlinedTextField(value,onChange,Modifier.fillMaxWidth().semantics{contentDescription=t(label)},enabled=enabled,singleLine=true,
        label={CompactLabel(t(label))},keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Ascii),
        shape=RoundedCornerShape(17.dp),colors=OutlinedTextFieldDefaults.colors(focusedBorderColor=BuriTheme.Blue,unfocusedBorderColor=BuriTheme.Muted.copy(alpha=.35f)))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun QueryDate(label:String,value:String,enabled:Boolean,onChange:(String)->Unit){
    val t=LocalUiText.current;var open by remember{mutableStateOf(false)}
    Column{
        CompactLabel(t(label),fontSize=15.sp,color=BuriTheme.Muted);Spacer(Modifier.height(8.dp))
        OutlinedButton({open=true},Modifier.fillMaxWidth().heightIn(min=56.dp).semantics{contentDescription=t(label)},enabled=enabled,shape=RoundedCornerShape(17.dp),colors=ButtonDefaults.outlinedButtonColors(contentColor=BuriTheme.Text)){
            Icon(painterResource(R.drawable.ic_clock),null,Modifier.size(20.dp));Spacer(Modifier.width(10.dp));CompactLabel(value.ifBlank{t("Any date")},Modifier.weight(1f),fontSize=16.sp)
        }
    }
    if(open){
        val initial=runCatching{LocalDate.parse(value).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()}.getOrNull()
        val picker=rememberDatePickerState(initialSelectedDateMillis=initial)
        DatePickerDialog(onDismissRequest={open=false},confirmButton={TextButton({picker.selectedDateMillis?.let{onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString())};open=false}){CompactLabel(t("Apply"))}},dismissButton={TextButton({open=false}){CompactLabel(t("Cancel"))}}){DatePicker(picker)}
    }
}

@Composable internal fun ListingFiltersPanel(model:BuriController){
    val target=model.listingTarget?:return
    val t=LocalUiText.current;val current=model.listingQuery;val enabled=!model.state.busy
    var draft by remember(target,current){mutableStateOf(current)}
    var from by remember(target,current){mutableStateOf(dateText(current.fromAt))}
    var until by remember(target,current){mutableStateOf(dateText(current.untilAt,true))}
    var minimum by remember(target,current){mutableStateOf(current.minRwf?.toString().orEmpty())}
    var maximum by remember(target,current){mutableStateOf(current.maxRwf?.toString().orEmpty())}
    var error by remember(target,current){mutableStateOf<String?>(null)}
    fun apply(){
        try{
            fun number(value:String):Long?=value.takeIf{it.isNotBlank()}?.let{require(Regex("-?[0-9]+").matches(it));it.toLong()}
            val value=draft.copy(fromAt=selectedBound(from,false),untilAt=selectedBound(until,true),minRwf=number(minimum),maxRwf=number(maximum)).validated(target)
            error=null;model.applyListingQuery(value)
        }catch(_:Exception){error="Check the date and amount range."}
    }
    Panel(footer={
        Column(verticalArrangement=Arrangement.spacedBy(6.dp)){
            Primary(t("Apply"),::apply,enabled)
            TextButton({draft=ListingQuery.defaultsFor(target);from="";until="";minimum="";maximum="";error=null;model.resetListingQuery()},enabled=enabled,modifier=Modifier.fillMaxWidth().heightIn(min=48.dp)){CompactLabel(t("Reset all"))}
        }
    }){
        if(target !in setOf(ListingTarget.SMS,ListingTarget.OBSERVATIONS))item{Entry(t("Search"),draft.q,{draft=draft.copy(q=it.take(80))},enabled=enabled)}
        if(!model.state.isMemberStatement&&ListingQuery.filters(target).size>1)item{ListingChoice("Status",draft.filter,ListingQuery.filters(target).map{it to listingValueLabel(it)},enabled,if(target==ListingTarget.PAYMENTS)"payment-filter-select"else "listing-filter-select"){draft=draft.copy(filter=it)}}
        item{ListingChoice("Sort by",draft.sort.wire,ListingQuery.allowedSorts(target).map{it.wire to listingSortLabel(it)},enabled,"listing-sort-select"){wire->draft=draft.copy(sort=ListingSort.entries.first{it.wire==wire})}}
        if(ListingQuery.supportsActive(target))item{ListingChoice(if(target==ListingTarget.STAFF)"Access status"else "Membership status",draft.active,listOf("all","active","inactive").map{it to listingValueLabel(it)},enabled,"listing-active-select"){draft=draft.copy(active=it)}}
        if(ListingQuery.supportsDirection(target))item{ListingChoice("Direction",draft.direction,listOf("all","incoming","outgoing").map{it to listingValueLabel(it)},enabled,"listing-direction-select"){draft=draft.copy(direction=it)}}
        if(ListingQuery.supportsDates(target)){
            item{CompactLabel(t("Date range"),fontSize=20.sp,fontWeight=FontWeight.Medium);Text(t("Dates use Kigali time. End date is included."),fontSize=14.sp,lineHeight=22.sp,color=BuriTheme.Muted)}
            item{ScrollingChips{chip ->
                for((days,label)in listOf(1L to "Today",7L to "Last 7 days",30L to "Last 30 days"))AssistChip(onClick={val today=LocalDate.now(ListingZone);from=today.minusDays(days-1).toString();until=today.toString()},label={CompactLabel(t(label))},enabled=enabled,modifier=chip.heightIn(min=48.dp))
            }}
            item{QueryDate("From date",from,enabled){from=it}}
            item{QueryDate("Through date",until,enabled){until=it}}
        }
        if(ListingQuery.supportsAmount(target)){
            item{CompactLabel(t("Amount range"),fontSize=20.sp,fontWeight=FontWeight.Medium);Text(t("Whole RWF values. Leave empty for no limit."),fontSize=14.sp,lineHeight=22.sp,color=BuriTheme.Muted)}
            item{QueryNumber("Minimum RWF",minimum,enabled){minimum=it.take(18)}}
            item{QueryNumber("Maximum RWF",maximum,enabled){maximum=it.take(18)}}
        }
        error?.let{message->item{Text(t(message),Modifier.semantics{liveRegion=LiveRegionMode.Polite},color=BuriTheme.Bad,fontSize=15.sp,lineHeight=23.sp)}}
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ListingExportSheet(model:BuriController,onPick:(ExportFormat)->Unit,onDismiss:()->Unit){
    val t=LocalUiText.current
    val target=model.listingTarget?:return
    val title=t(if(model.state.isMemberStatement)"Download statement" else "Export results")
    val formats=listOf(ExportFormat.XLSX to "Excel workbook (.xlsx)", ExportFormat.PDF to "PDF document (.pdf)")
    ModalBottomSheet(onDismissRequest=onDismiss,containerColor=BuriTheme.Surface,contentColor=BuriTheme.Text,
        shape=RoundedCornerShape(topStart=32.dp,topEnd=32.dp),scrimColor=Color.Black.copy(alpha=.62f)){
        Column(Modifier.fillMaxWidth().heightIn(max=LocalConfiguration.current.screenHeightDp.dp*.9f).verticalScroll(rememberScrollState()).padding(horizontal=24.dp).navigationBarsPadding().padding(bottom=24.dp).testTag("export-format-sheet").semantics{paneTitle=title}){
            Row(verticalAlignment=Alignment.CenterVertically){
                CompactLabel(title,Modifier.weight(1f).semantics{heading()},fontSize=28.sp,lineHeight=36.sp,fontWeight=FontWeight.SemiBold)
                IconButton(onDismiss,Modifier.size(48.dp)){Icon(painterResource(R.drawable.ic_close),t("Close"))}
            }
            Text(t("Current filters and sort are included."),Modifier.padding(vertical=12.dp),fontSize=15.sp,lineHeight=23.sp,color=BuriTheme.Muted)
            if(target in setOf(ListingTarget.SMS,ListingTarget.OBSERVATIONS))Text(t("SMS exports contain authorized metadata only. Message content is excluded."),Modifier.padding(bottom=12.dp),fontSize=15.sp,lineHeight=23.sp,color=BuriTheme.Warn)
            formats.forEach{(format,label)->
                OutlinedButton({onPick(format)},Modifier.fillMaxWidth().padding(vertical=5.dp).heightIn(min=60.dp).testTag("export-format:${format.name}"),enabled=model.canExportListing&&!model.state.busy&&!model.state.offline,shape=RoundedCornerShape(20.dp),colors=ButtonDefaults.outlinedButtonColors(contentColor=BuriTheme.Text)){
                    Icon(painterResource(R.drawable.ic_export),null,Modifier.size(24.dp));Spacer(Modifier.width(14.dp));CompactLabel(t(label),Modifier.weight(1f),fontSize=18.sp,lineHeight=26.sp)
                }
            }
        }
    }
}
