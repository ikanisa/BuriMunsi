package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*

@Composable internal fun AllocatePanel(s:UiState,m:BuriController){
    val t=LocalUiText.current;val query=s.draft["query"].orEmpty();val p=s.payment?:return
    val canAllocate = PaymentPresentation.canAllocate(p) && m.allows(Capability.ALLOCATE) &&
        s.selectedMember?.active == true && !s.busy && !s.offline && !s.pending
    Panel(footer={Primary(t("Allocate"),m::allocate,canAllocate,working=s.busy&&m.operation==UiOperation.COMMAND)}){
        item{CountLine(p.ftId?.let{t("FT Id: %1\$s",it)}?:t("Payment"),p.amountRwf?.let{t("RWF %1\$s",money(it,t.locale))}?:t("Unavailable"),exactAmount=true)}
        item{Search(query,{m.editDraft("query",it)},{m.allocationSearch(query)},t("Find member"),s.busy)}
        items(s.members?.items.orEmpty().filter{it.active},key={it.id}){member->Row(Modifier.fillMaxWidth().selectable(selected=s.selectedMember?.id==member.id,enabled=!s.busy,role=SemanticRole.RadioButton,onClick={m.selectMember(member)}).padding(vertical=9.dp),verticalAlignment=Alignment.CenterVertically){
            RadioButton(selected=s.selectedMember?.id==member.id,onClick=null,enabled=!s.busy);Column(Modifier.weight(1f)){SingleLineName(member.name);CompactLabel(member.phone,fontSize=14.sp,color=BuriTheme.Muted)}
        }}
        if(s.members?.items?.none{it.active}==true)item{Empty(t("No eligible members. Change the search or ask an administrator."))}
        moreButton(s.members?.nextCursor,s.busy,m::more,autoEnabled=!s.offline&&s.error==null,paging=m.operation==UiOperation.LOAD_MORE)
    }
}
@Composable private fun CheckRow(label:String,checked:Boolean,enabled:Boolean=true,confirmation:Boolean=false,change:(Boolean)->Unit){
    Row(Modifier.testTag("check:$label").fillMaxWidth().heightIn(min=48.dp).toggleable(value=checked,enabled=enabled,role=SemanticRole.Checkbox,onValueChange=change),verticalAlignment=Alignment.CenterVertically){Checkbox(checked,onCheckedChange=null,enabled=enabled)
        Spacer(Modifier.width(10.dp))
        if(confirmation)Text(label,Modifier.weight(1f),fontSize=16.sp,lineHeight=24.sp)
        else CompactLabel(label,Modifier.weight(1f),fontSize=16.sp,lineHeight=24.sp)
    }
}
@Composable internal fun StaffPanel(s:UiState,m:BuriController){
    val t=LocalUiText.current;val existing=s.selectedStaff
    if(s.sheetId!=null&&existing==null){Panel{item{Empty(t("Staff account unavailable. Go back and refresh the staff list."))}};return}
    val name=s.draft["name"]?:existing?.name.orEmpty();val phone=s.draft["phone"]?:existing?.phone.orEmpty();var pin by remember(existing?.id){mutableStateOf("")}
    val phoneFocus=remember{FocusRequester()};val pinFocus=remember{FocusRequester()};val enroll=s.draft["enroll"]=="true";val allocate=s.draft["allocate"]=="true"
    val normalized=runCatching{Values.phone(phone)}.getOrNull()
    // The server applies the default at creation and enforces any change to an existing credential.
    val ready=Presentation.validName(name)&&normalized!=null&&(pin.isEmpty()||runCatching{Values.pin(pin)}.isSuccess)
    Panel(footer={Primary(t(if(existing==null)"Create staff"else "Save changes"),{m.saveStaff(name,phone,pin,enroll,allocate);pin=""},ready&&!s.busy&&!s.offline&&!s.pending,working=s.busy&&m.operation==UiOperation.COMMAND)}){
        item{Entry(t("Name"),name,{m.editDraft("name",it)},enabled=!s.busy,nextFocus=phoneFocus,placeholder="Full name")}
        item{Entry(t("Phone number"),phone,{m.editDraft("phone",it)},phone=true,enabled=!s.busy,fieldFocus=phoneFocus,
            nextFocus=if(existing!=null)pinFocus else null,imeAction=if(existing!=null)ImeAction.Next else ImeAction.Done)}
        if(existing!=null)item{Entry(t("New passcode"),pin,{pin=it.filter{ch->ch in '0'..'9'}.take(4)},pin=true,enabled=!s.busy,imeAction=ImeAction.Done,fieldFocus=pinFocus,
            placeholder="Leave blank to keep current")}
        item{CheckRow(t("Allocate unmatched payments"),allocate,!s.busy){m.editDraft("allocate",it.toString())}}
        item{CheckRow(t("Enroll members"),enroll,!s.busy){m.editDraft("enroll",it.toString())}}
        if(existing!=null)item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){
            OutlinedButton({m.staffAction(if(existing.active)"disable"else "enable")},enabled=!s.busy&&!s.offline&&!s.pending){CompactLabel(t(if(existing.active)"Disable"else "Enable"))}
            OutlinedButton(m::requestRemoveStaff,enabled=!s.busy&&!s.offline){CompactLabel(t("Remove"))}
        }}
    }
}
@Composable internal fun GatewayPanel(s:UiState,m:BuriController,onPermissions:()->Unit){
    val t=LocalUiText.current;val g=s.gateway;val health=GatewayHealth.describe(g)
    if(g==null){Panel{item{if(s.busy){BuriInlineLoading("Loading records");BuriFactsSkeleton()}else Empty(t("Status unavailable"))}};return}
    if(g.observationMode){
        Panel {
            item{CompactLabel(t(health.title),fontSize=24.sp,fontWeight=FontWeight.SemiBold)}
            item{FactGroup(listOf(
                t("SMS permission") to t(if(m.smsAccessGranted)"Granted" else "Required"),
                t("Sender") to (g.approvedSenders?.joinToString(", ")?:t("Unavailable")),
                t("Sync") to t(if(health.code in setOf("permissions","waiting","reauthorize"))"Blocked" else if(g.captureEnabled)"Listening" else "Paused"),
                t("Queued") to (if(g.pending>=0)g.pending.toString()else t("Unavailable"))
            ),BuriTheme.Group,compactValueLabels=setOf(t("Sender")))}
            item{Text(t(health.explanation),fontSize=15.sp,color=BuriTheme.Muted)}
            if(health.needsPermission||m.receivingPermissionsRequired)item{OutlinedButton(onPermissions,enabled=!s.busy){CompactLabel(t("SMS permission"))}}
            if(g.authorized)item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){
                if(!g.captureEnabled&&health.canResume&&!m.receivingPermissionsRequired)OutlinedButton({m.setPaused(false)},enabled=!s.busy){CompactLabel(t("Resume"))}
                OutlinedButton(m::syncReceiver,enabled=!s.busy&&!s.offline){CompactLabel(t("Sync"))}
            }}
        }
        return
    }
    if(!g.authorized){
        Panel{item{CompactLabel(t(health.title),fontSize=24.sp,fontWeight=FontWeight.SemiBold)}
            item{Text(t(health.explanation),fontSize=15.sp,color=BuriTheme.Muted)}}
        return
    }
    Panel{
        item{Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){Glyph(R.drawable.ic_device,null,BuriTheme.Text,32);Spacer(Modifier.width(14.dp));CompactLabel(t("Receiving phone"),fontSize=24.sp,fontWeight=FontWeight.SemiBold)}}
        item{FactGroup(listOf(
            t("Paired receiving code") to (g.pairedReceivingCode?:t("Unavailable")),
            t("Sender") to (g.approvedSenders?.joinToString(", ")?:t("Unavailable")),
            t("SIM") to t(if((g.subscriptionId?:-1)>=0&&health.code !in setOf("source","attention","permissions"))"Verified"else if(health.code=="source")"Changed · sync blocked"else "Unavailable"),
            t("SMS permission") to t(if(m.receivingPermissionsRequired)"Required"else "Granted"),
            t("Sync") to t(if(health.code in setOf("source","permissions","attention","queue","reauthorize"))"Blocked"else if(g.captureEnabled)"Listening"else "Paused"),
            t("Last receipt") to (g.lastCapture?:t("Not recorded")),
            t("Queued") to (if(g.pending>=0)g.pending.toString()else t("Unavailable")),
            t("Sync") to t(if(s.offline)"Offline"else if(g.problem=="uploads_on_hold")"Paused"else "Unavailable")
        ),BuriTheme.Group,compactValueLabels=setOf(t("Sender")))}
        if(health.needsPermission||m.receivingPermissionsRequired)item{OutlinedButton(onPermissions,enabled=!s.busy){CompactLabel(t("SMS permission"))}}
        item{Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(12.dp)){
            if(!g.captureEnabled&&health.canResume&&!m.receivingPermissionsRequired)OutlinedButton({m.setPaused(false)},enabled=!s.busy){CompactLabel(t("Resume"))}
            OutlinedButton(m::syncReceiver,enabled=!s.busy&&!s.offline){CompactLabel(t("Sync"))}
        }}
        item{Text(t("Only the registered business SIM is ingested."),fontSize=15.sp,color=BuriTheme.Muted)}
    }
}
@Composable internal fun ReplaceReceiverPanel(s:UiState,m:BuriController,onPermissions:()->Unit){
    val t=LocalUiText.current;var code by remember{mutableStateOf("")};var confirmed by remember{mutableStateOf(false)}
    val checking=m.receiverRetirementPending
    Panel(footer={Primary(t(if(checking)"Check replacement"else "Replace receiver"),{
        if(checking)m.replaceReceiver("")else if(m.receivingPermissionsRequired)onPermissions()else{m.replaceReceiver(code);code=""}
    },!s.busy&&(checking||(confirmed&&code.trim().length in 4..128&&!s.offline&&!s.pending)))}){
        item{Text(t("Retire this receiver and pair its replacement to the same receiving account. There can be only one active receiver."),fontSize=15.sp,color=BuriTheme.Muted)}
        item{CheckRow(t("I have the registered business SIM"),confirmed,!s.busy&&!checking,confirmation=true){confirmed=it}}
        item{Entry(t("Pairing code"),code,{code=it.take(128)},enabled=!s.busy&&!checking,imeAction=ImeAction.Done)}
    }
}
@Composable internal fun FiltersPanel(s:UiState,m:BuriController){
    val t=LocalUiText.current;var selected by remember(s.filter){mutableStateOf(s.filter)}
    val options=listOf("all" to "All","allocated" to "Allocated","unallocated" to "Unallocated")
    Panel(footer={Primary(t("Apply"),{m.setFilter(selected)},!s.busy)}){
        item{ListingChoice("Status",selected,options,!s.busy,"payment-filter-select"){selected=it}}
        s.payments?.asOf?.let{asOf->item{CompactLabel(historyTime(asOf,t.locale),fontSize=15.sp,color=BuriTheme.Muted)}}
    }
}
