package rw.ikanisa.burimunsi.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.foundation.focusable
import androidx.compose.ui.platform.LocalWindowInfo
import kotlinx.coroutines.flow.first
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.Role

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun Sheets(s:UiState,m:BuriController,onSupport:()->Unit,onPermissions:()->Unit,
    onPickMemberFile:()->Unit,onPreviewMemberFile:(requestId:String)->Unit,onTakeMemberPhoto:()->Unit,onPickMemberPhoto:()->Unit,onExport:()->Unit){
    val t=LocalUiText.current
    val sheet=s.sheet?:return
    val external=LocalUriHandler.current
    val payerPicker=sheet==Sheet.ENROLL && s.onboarding.step==SmartOnboardingStep.SUGGESTIONS
    val title=when(sheet){Sheet.PROFILE->t("Profile");Sheet.PIN->t("Change passcode");Sheet.HELP->t("Help");Sheet.ALLOCATE->t("Allocate");Sheet.ENROLL->t(if(payerPicker) "Add from MoMo" else "Add member");Sheet.STAFF->t("Staff access");Sheet.STAFF_EDIT->if(s.selectedStaff==null)t("Add staff")else t("Edit staff");Sheet.REMOVE_STAFF->t("Remove access?");Sheet.GATEWAY->t("Gateway");Sheet.REPLACE_DEVICE->t("Replace receiver");Sheet.RAW->s.raw?.sender?.takeIf{it.isNotBlank()}?:t("SMS receipt");Sheet.MEMBER_DETAILS->t("Member details");Sheet.AUDIT->t("Activity log");Sheet.FILTERS->t("Filters")}
    key(sheet,s.sheetId){
    val latest=rememberUpdatedState(s)
    val sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true,confirmValueChange={target->
        if(target==SheetValue.Hidden&&(latest.value.busy||latest.value.draftDirty)){
            if(!latest.value.busy)m.closeSheet()
            false
        }else true
    })
    val keyboard=LocalSoftwareKeyboardController.current
    val imeVisible=WindowInsets.ime.getBottom(LocalDensity.current)>0
    CompositionLocalProvider(LocalBuriRouteColors provides BuriRouteColors(Color(0xFFB0B0B5),Color(0xFF8CA2FF),Color(0xFF2C2C2F),Color(0xFF242426)),LocalBuriRoute provides Route.SETTINGS){
    ModalBottomSheet(onDismissRequest=m::closeSheet,sheetState=sheetState,containerColor=Color(0xFF1C1C1E),contentColor=BuriTheme.Text,shape=RoundedCornerShape(topStart=32.dp,topEnd=32.dp),scrimColor=Color.Black.copy(alpha=.62f),dragHandle={
        Box(Modifier.fillMaxWidth().padding(top=11.dp,bottom=3.dp),contentAlignment=Alignment.Center){Box(Modifier.size(width=34.dp,height=4.dp).background(Color(0xFF505054),RoundedCornerShape(4.dp)))}
    }){
        val initialFilterFocus=if(sheet==Sheet.FILTERS) remember { FocusRequester() } else null
        if(initialFilterFocus!=null){
            val window=LocalWindowInfo.current
            val sheetKeyboard=LocalSoftwareKeyboardController.current
            LaunchedEffect(initialFilterFocus){
                snapshotFlow{window.isWindowFocused}.first{it}
                initialFilterFocus.requestFocus()
                sheetKeyboard?.hide()
            }
        }
        BackHandler(enabled=payerPicker && !imeVisible && !s.busy && !s.discardRequested) { m.onboardingOptions() }
        BackHandler(enabled=s.discardRequested && !s.busy) { m.keepDraft() }
        Column(Modifier.fillMaxWidth().heightIn(max=LocalConfiguration.current.screenHeightDp.dp*.94f).imePadding().semantics{paneTitle=title}.onPreviewKeyEvent{
            if(it.key==Key.Escape){if(it.type==KeyEventType.KeyUp){if(imeVisible)keyboard?.hide()else if(s.discardRequested)m.keepDraft()else if(payerPicker)m.onboardingOptions()else m.closeSheet()};true}else false
        }){
            Row(Modifier.fillMaxWidth().heightIn(min=65.dp).padding(start=if(payerPicker)8.dp else 22.dp,end=12.dp,top=7.dp,bottom=10.dp),verticalAlignment=Alignment.CenterVertically){
                if(payerPicker)IconButton({keyboard?.hide();m.onboardingOptions()},enabled=!s.busy&&!s.discardRequested){Glyph(R.drawable.ic_back,t("Back"))}
                val headingFocus=if(initialFilterFocus==null)Modifier else Modifier.focusRequester(initialFilterFocus).focusable()
                CompactLabel(title,Modifier.weight(1f).then(headingFocus).semantics{heading()},fontSize=30.sp,fontWeight=FontWeight.SemiBold,lineHeight=38.sp)
                IconButton(m::closeSheet,enabled=!s.busy&&!s.discardRequested,modifier=Modifier.testTag("panel-close")){Glyph(R.drawable.ic_close,t("Close"))}
            }
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f,fill=false)){
            val noticeLimit = maxHeight / 2
            Column(Modifier.fillMaxWidth()){
            if(s.discardRequested)DiscardPrompt(s,m)
            val showPanelProgress=hasOperationProgress(m.operation,s.busy,m.exportFeedback)
            if(!s.discardRequested)SheetFeedback(s,m,sheet,payerPicker,showPanelProgress,Modifier.heightIn(max=noticeLimit))
            // Keep in-memory form inputs while removing the form from layout, focus and hit testing.
            val blockedContent=if(s.discardRequested)Modifier.clearAndSetSemantics{}.layout { _, constraints ->
                layout(constraints.minWidth,0) {}
            }else Modifier
            Box(Modifier.fillMaxWidth().weight(1f,fill=false).then(blockedContent)){
                CompositionLocalProvider(LocalProgressPresented provides showPanelProgress) {
                key(sheet,s.sheetId){when(sheet){
                    Sheet.PROFILE->Panel(footer={Primary(t("Change passcode"),{m.openSheet(Sheet.PIN)},!s.busy)}){
                        item{FactGroup(listOf(t("Name") to s.operator?.name.orEmpty(),t("Phone number") to s.operator?.phone.orEmpty()),BuriTheme.Group,compactValueLabels=setOf(t("Name")))}
                    }
                    Sheet.PIN->PinPanel(s.busy,s.pending,m::changePin)
                    Sheet.HELP->HelpPanel(!s.busy,onSupport,external)
                    Sheet.ALLOCATE->AllocatePanel(s,m)
                    Sheet.ENROLL->SmartEnrollPanel(s,m,onPickMemberFile,onPreviewMemberFile,onTakeMemberPhoto,onPickMemberPhoto)
                    Sheet.STAFF->Panel{
                        item{ListingToolbar(m,onExport)}
                        item{Row(Modifier.fillMaxWidth(),verticalAlignment=Alignment.CenterVertically){
                            val count=s.staff?.totalCount?.let{if(it==1)t("1 account")else t("%1\$d accounts",it)}
                            CompactLabel(count?:t("Unavailable"),Modifier.weight(1f),color=BuriTheme.Muted,fontSize=14.sp)
                            RoundAction(R.drawable.ic_plus,t("Add staff"),{m.openSheet(Sheet.STAFF_EDIT)},!s.busy&&!s.offline&&!s.pending,48)
                        }}
                        val staff=s.staff?.items.orEmpty()
                        if(staff.isNotEmpty())item{Column(Modifier.fillMaxWidth().background(BuriTheme.Group,RoundedCornerShape(24.dp)).padding(horizontal=16.dp,vertical=2.dp)){
                            staff.forEachIndexed{index,person->
                                SettingRow(R.drawable.ic_members,person.name,t("%1\$s · %2\$s",person.phone,t(if(person.active)"Active" else "Disabled")),enabled=!s.busy,singleLineTitle=true){m.openSheet(Sheet.STAFF_EDIT,person.id)}
                                if(index<staff.lastIndex)HorizontalDivider(color=Color.White.copy(alpha=.08f))
                            }
                        }}
                        if(s.staff?.items?.isEmpty()==true)item{Empty(t("No staff"))}
                        if(s.staff==null&&s.busy)item{BuriSkeletonRows(3,LoadingRows.MEMBERS)}
                        moreButton(s.staff?.nextCursor,s.busy,m::more,autoEnabled=!s.offline&&s.error==null,paging=m.operation==UiOperation.LOAD_MORE)
                    }
                    Sheet.STAFF_EDIT->StaffPanel(s,m)
                    Sheet.REMOVE_STAFF->Panel(footer={Primary(t("Remove access"),{m.staffAction("remove")},!s.busy&&!s.offline&&!s.pending,danger=true,working=s.busy&&m.operation==UiOperation.COMMAND)}){
                        item{SingleLineName(s.selectedStaff?.name.orEmpty(),Modifier.fillMaxWidth(),20)}
                        item{Text(t("This staff member will no longer be able to sign in."),fontSize=15.sp,color=BuriTheme.Muted,lineHeight=23.sp)}
                    }
                    Sheet.GATEWAY->GatewayPanel(s,m,onPermissions)
                    Sheet.REPLACE_DEVICE->ReplaceReceiverPanel(s,m,onPermissions)
                    Sheet.RAW->RawPanel(s,m)
                    Sheet.MEMBER_DETAILS->{
                        val member=s.member
                        Panel(footer=if(member!=null&&s.operator?.role==Role.ADMIN&&m.allows(Capability.ENROLL)){{Primary(if(member.active)t("Deactivate membership") else t("Reactivate membership"),{m.setMemberActive(!member.active)},!s.busy&&!s.offline&&!s.pending,secondary=true,working=s.busy&&m.operation==UiOperation.COMMAND)}}else null){
                            member?.let{item{FactGroup(listOf(t("Name") to it.name,t("MoMo number") to it.phone,t("Membership") to if(it.active)t("Active") else t("Inactive")),BuriTheme.Group,compactValueLabels=setOf(t("Name"),t("Membership")))}}
                        }
                    }
                    Sheet.AUDIT->Panel{
                        item{ListingToolbar(m,onExport)}
                        items(s.audit?.items.orEmpty(),key={it.id}){a->Column(Modifier.fillMaxWidth().padding(vertical=10.dp)){SingleLineName(a.action);Spacer(Modifier.height(5.dp));Text(historyTime(a.at,t.locale),color=BuriTheme.Muted,fontSize=14.sp,lineHeight=22.sp)}}
                        if(s.audit?.items?.isEmpty()==true)item{Empty()}
                        if(s.audit==null&&s.busy)item{BuriSkeletonRows(3,LoadingRows.ACTIVITY)}
                        moreButton(s.audit?.nextCursor,s.busy,m::more,autoEnabled=!s.offline&&s.error==null,paging=m.operation==UiOperation.LOAD_MORE)
                    }
                    Sheet.FILTERS->if(m.listingTarget!=null)ListingFiltersPanel(m)else FiltersPanel(s,m)
                }}
                }
            }
            }
            }
        }
    }
    }
}

}

@Composable private fun HelpPanel(enabled:Boolean,onSupport:()->Unit,external:UriHandler){
    val t=LocalUiText.current
    var showAddress by remember{mutableStateOf(false)}
    Panel(footer={Primary(t("WhatsApp"),onSupport,enabled)}){
        item{Text(BuriMunsiSupport.phone,fontSize=26.sp,lineHeight=34.sp)}
        item{
            OutlinedButton(onClick={
                try{external.openUri(BuriMunsiSupport.privacyNoticeUrl);showAddress=false}
                catch(_:IllegalArgumentException){showAddress=true}
                catch(_:SecurityException){showAddress=true}
            },enabled=enabled){CompactLabel(t("Privacy notice"))}
        }
        if(showAddress)item{SelectionContainer{Text(BuriMunsiSupport.privacyNoticeUrl)}}
    }
}

@Composable private fun SheetFeedback(s:UiState,m:BuriController,sheet:Sheet,payerPicker:Boolean,progress:Boolean,modifier:Modifier){
    val t=LocalUiText.current
    val signedIn=s.operator!=null && m.screenGate==ScreenGate.OPEN && m.presentation.showRecords
    val message=s.error?.takeUnless{payerPicker && s.onboarding.suggestionsFailed}
    if(!progress && message==null && !(signedIn && (s.offline||s.pending||s.commandNotice!=null||m.exportFeedback!=null)))return
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState())){
        if(progress){
            val label=if(sheet==Sheet.RAW && s.rawDisclosure==RawDisclosureState.LOADING)"Loading original SMS" else m.operationLabel
            BuriOperationFeedback(m.operation,label)
        }
        if(signedIn){
            if(s.offline)BuriStatusMessage("Offline · read only",warning=true)
            if(s.pending){
                BuriStatusMessage("Previous action needs confirmation",warning=true)
                if(!s.draftDirty)TextButton(m::retry,enabled=m.presentation.mayCheckOutcome,modifier=Modifier.padding(horizontal=16.dp)){
                    Text(t("Check previous action"))
                }
            }
            s.commandNotice?.let{BuriStatusMessage(it,warning=true)}
            m.exportFeedback?.let{BuriExportFeedback(it,m::cancelExport,m::dismissExportFeedback)}
        }
        message?.let{
            BuriStatusMessage(it,error=true)
            if(sheet in setOf(Sheet.STAFF,Sheet.AUDIT,Sheet.ALLOCATE,Sheet.GATEWAY,Sheet.MEMBER_DETAILS))
                TextButton(m::refresh,enabled=!s.busy,modifier=Modifier.padding(horizontal=16.dp)){CompactLabel(t("Retry loading"))}
        }
    }
}

@Composable internal fun DiscardPrompt(s:UiState,m:BuriController){
    val t=LocalUiText.current;val keep=remember{FocusRequester()}
    val keyboard=LocalSoftwareKeyboardController.current;val focus=LocalFocusManager.current
    LaunchedEffect(Unit){keyboard?.hide();focus.clearFocus();keep.requestFocus()}
    Column(Modifier.fillMaxWidth().background(Color(0xFF28282B)).verticalScroll(rememberScrollState()).padding(horizontal=24.dp,vertical=16.dp).semantics{liveRegion=LiveRegionMode.Assertive},verticalArrangement=Arrangement.spacedBy(8.dp)){
        Text(t("Discard unsaved changes?"),fontSize=18.sp,fontWeight=FontWeight.SemiBold,lineHeight=25.sp)
        Text(if(s.pending)t("An earlier action may have been submitted. Discarding this draft does not cancel it. Check the previous action before retrying.") else t("Nothing has been submitted. Credentials will be cleared."),fontSize=14.sp,color=BuriTheme.Muted,lineHeight=21.sp)
        Primary(t("Keep editing"),m::keepDraft,!s.busy,secondary=true,modifier=Modifier.focusRequester(keep))
        Primary(t("Discard changes"),m::discardDraft,!s.busy,danger=true)
    }
}
