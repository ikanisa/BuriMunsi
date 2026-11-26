package rw.ikanisa.burimunsi.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*

@Composable private fun SmartConsent(label:String,checked:Boolean,enabled:Boolean,onChange:(Boolean)->Unit){
    val t=LocalUiText.current
    Row(Modifier.fillMaxWidth().heightIn(min=52.dp).toggleable(value=checked,enabled=enabled,role=SemanticRole.Checkbox,onValueChange=onChange),
        verticalAlignment=Alignment.CenterVertically){
        Checkbox(checked=checked,onCheckedChange=null,enabled=enabled)
        Text(t(label),Modifier.weight(1f),fontSize=15.sp,lineHeight=22.sp)
    }
}
@Composable
private fun MemberMethodGroup(content:@Composable ColumnScope.()->Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp))
        .background(BuriTheme.Group).padding(horizontal=14.dp), content=content)
}

@Composable
private fun MemberMethodDivider() {
    HorizontalDivider(Modifier.padding(start=50.dp), color=Color.White.copy(alpha=.08f))
}

private fun LazyListScope.memberMethods(onboarding:SmartOnboardingState, m:BuriController, enabled:Boolean,
    onTakePhoto:()->Unit, onPickPhoto:()->Unit, onPickFile:()->Unit) {
    val importing = onboarding.step == SmartOnboardingStep.IMPORT
    item(key="member-entry-methods") {
        val t = LocalUiText.current
        val suggestions = t(if(importing) "Suggested from payments" else "MoMo suggestions")
        val manual = t("Add manually")
        MemberMethodGroup {
            SettingRow(R.drawable.ic_home_wallet, suggestions, enabled=enabled) { m.onboardingSuggestions() }
            MemberMethodDivider()
            SettingRow(R.drawable.ic_person_add, manual, enabled=enabled, click=m::onboardingManual)
        }
    }
    item(key="member-import-methods") {
        val t = LocalUiText.current
        MemberMethodGroup {
            SettingRow(R.drawable.ic_camera, t(if(importing) "Take a photo of the list" else "Scan a list"),
                t("Taking a photo sends it to OpenAI for extraction. Review members before saving."), enabled) {
                m.onboardingPhoto()
                onTakePhoto()
            }
            MemberMethodDivider()
            SettingRow(R.drawable.ic_photo_library, t("Choose a photo"), enabled=enabled) {
                if(!importing) m.onboardingImport()
                onPickPhoto()
            }
            MemberMethodDivider()
            SettingRow(R.drawable.ic_file_import, t(if(importing && onboarding.documentSelected) "Choose another file" else "Choose a file"), enabled=enabled) {
                if(!importing) m.onboardingImport()
                onPickFile()
            }
        }
    }
}

@Composable
private fun PayerRow(payer: SmartCandidate, first: Boolean, last: Boolean, enabled: Boolean, onChoose: () -> Unit) {
    val t = LocalUiText.current
    val action = focusAction("payer:${payer.candidateId}", onChoose)
    val payments = if (payer.sourceCount == 1) t("1 payment") else t("%1\$d payments", payer.sourceCount)
    val ending = t("MoMo number ending in %1\$s", payer.last3.toCharArray().joinToString(" "))
    val review = t("Review payer")
    Box(Modifier.fillMaxWidth().clip(rowShape(first, last)).background(BuriTheme.Group)) {
        Row(action.modifier.fillMaxWidth().heightIn(min = 74.dp)
            .clickable(enabled = enabled, role = SemanticRole.Button, onClickLabel = review, onClick = action.click)
            .padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Avatar(payer.momoName, size = 44)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                CompactLabel(payer.momoName, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
                Text(t("••• %1\$s · %2\$s", payer.last3, payments), Modifier.clearAndSetSemantics { contentDescription = "$ending, $payments" },
                    style = MaterialTheme.typography.bodySmall, color = BuriTheme.Muted)
            }
            Spacer(Modifier.width(8.dp))
            Glyph(R.drawable.ic_arrow, null, BuriTheme.Muted, 19)
        }
        if (!last) HorizontalDivider(Modifier.align(Alignment.BottomCenter).padding(start = 72.dp, end = 16.dp),
            color = BuriTheme.Text.copy(alpha = .08f))
    }
}

@Composable
private fun PayerListMessage(icon: Int, message: String, action: String, enabled: Boolean, onClick: () -> Unit) {
    val t = LocalUiText.current
    Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(46.dp).background(BuriTheme.Group, CircleShape), contentAlignment = Alignment.Center) {
            Glyph(icon, null, BuriTheme.Muted, 23)
        }
        Spacer(Modifier.height(10.dp))
        Text(t(message), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleMedium)
        TextButton(onClick, enabled = enabled) { CompactLabel(t(action), color = if (enabled) BuriTheme.Blue else BuriTheme.Muted) }
    }
}

@Composable
private fun MoMoPayerPicker(s: UiState, m: BuriController, enabled: Boolean) {
    val t = LocalUiText.current
    val o = s.onboarding
    val keyboard = LocalSoftwareKeyboardController.current
    Panel(itemSpacing = 0.dp) {
        item(key = "payer-search") {
            Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(t("Payers who haven’t joined this group."), color = BuriTheme.Muted,
                    style = MaterialTheme.typography.bodyMedium)
                SearchField(o.query, m::onboardingSearchQuery, {
                    keyboard?.hide()
                    m.onboardingSuggestions(o.query)
                }, hint = "Name or last 3 digits", busy = !enabled)
            }
        }
        itemsIndexed(o.suggestions, key = { _, payer -> payer.candidateId }) { index, payer ->
            PayerRow(payer, index == 0, index == o.suggestions.lastIndex, enabled) {
                keyboard?.hide()
                m.onboardingChoose(payer.candidateId)
            }
        }
        when {
            o.suggestionsFailed -> item(key = "payer-error") {
                PayerListMessage(R.drawable.ic_alert, s.error ?: "Couldn’t load payers", "Retry", enabled) {
                    m.onboardingSuggestions(o.query, o.nextCursor)
                }
            }
            o.suggestionsLoading || !o.suggestionsLoaded -> item(key = "payer-loading") {
                BuriInlineLoading(if (o.suggestions.isEmpty()) "Finding payers" else "Loading more")
            }
            o.suggestions.isEmpty() && o.query.isNotBlank() -> item(key = "payer-no-match") {
                PayerListMessage(R.drawable.ic_search, "No matching payers", "Clear search", enabled) {
                    m.onboardingSearchQuery("")
                }
            }
            o.suggestions.isEmpty() -> item(key = "payer-empty") {
                PayerListMessage(R.drawable.ic_members, "No new payers yet", "Add manually", enabled, m::onboardingManual)
            }
            enabled -> moreButton(o.nextCursor, false, { m.onboardingSuggestions(o.query, o.nextCursor) })
        }
    }
}

/** Additional onboarding screens stay inside the original Add member entry. */
@Composable internal fun SmartEnrollPanel(s:UiState,m:BuriController,onPickFile:()->Unit,onPreviewFile:(requestId:String)->Unit,
    onTakePhoto:()->Unit,onPickPhoto:()->Unit){
    val t=LocalUiText.current;val o=s.onboarding;val candidate=o.candidate;val enabled=!s.busy&&!s.offline&&!s.pending
    val name=s.draft["name"].orEmpty();val phone=s.draft["phone"].orEmpty();val phoneFocus=remember{FocusRequester()}
    val normalized=runCatching{Values.phone(phone)}.getOrNull()
    val ready=Presentation.validName(name)&&normalized!=null&&
        (candidate==null||normalized.endsWith(candidate.last3))&&o.verifiedOwnership&&o.acceptedTerms&&o.consentRecorded
    val previewNeedsConsent=SmartOnboardingPresentation.previewNeedsConsent(o.documentMimeType)
    val verified=o.rows.filter{it.verified}
    when(o.step){
        SmartOnboardingStep.OPTIONS->Panel{
            memberMethods(o,m,enabled,onTakePhoto,onPickPhoto,onPickFile)
        }
        SmartOnboardingStep.SUGGESTIONS->MoMoPayerPicker(s,m,enabled)
        SmartOnboardingStep.MEMBER,SmartOnboardingStep.IMPORT_MEMBER->Panel(footer={
            Primary(t(if(o.step==SmartOnboardingStep.MEMBER)"Save member" else "Add verified row to batch"),
                {if(o.step==SmartOnboardingStep.MEMBER)m.onboardingSubmit(name,phone)else m.onboardingSaveRow(name,phone)},ready&&enabled,working=s.busy&&m.operation==UiOperation.COMMAND)
        }){
            if(candidate!=null)item{CompactLabel(t("Suggested from MoMo")+" ···"+candidate.last3,color=BuriTheme.Muted,fontSize=15.sp)}
            item{Entry(t("MoMo name"),name,{m.editDraft("name",it)},enabled=!s.busy,nextFocus=phoneFocus,placeholder="Registered full name")}
            item{Entry(t("MoMo number"),phone,{m.editDraft("phone",it)},phone=true,enabled=!s.busy,imeAction=ImeAction.Done,fieldFocus=phoneFocus,
                errorText=if(phone.isNotBlank()&&normalized!=null&&candidate!=null&&!normalized.endsWith(candidate.last3))"The number does not match the suggestion." else null)}
            item{SmartConsent("Full number and phone ownership verified",o.verifiedOwnership,enabled){m.onboardingConsent("ownership",it,s.draft)}}
            item{SmartConsent("Member accepted the savings terms",o.acceptedTerms,enabled){m.onboardingConsent("terms",it,s.draft)}}
            item{SmartConsent("Privacy notice and consent recorded",o.consentRecorded,enabled){m.onboardingConsent("consent",it,s.draft)}}
            item{TextButton({when {
                o.step==SmartOnboardingStep.IMPORT_MEMBER -> m.onboardingImport()
                candidate!=null -> m.onboardingSuggestions(o.query)
                else -> m.onboardingOptions()
            }},enabled=!s.busy){CompactLabel(t("Back"),color=BuriTheme.Blue)}}
        }
        SmartOnboardingStep.IMPORT->Panel(footer=if(verified.isNotEmpty()){{
            Primary(t("Register verified members")+" (${verified.size})",m::onboardingSubmitBatch,enabled,working=s.busy&&m.operation==UiOperation.COMMAND)
        }}else null){
            if(!o.photoCaptureFlow&&o.sourceKind==null&&o.rows.isEmpty()){
                item{CompactLabel(t("Import member list"),fontSize=23.sp,fontWeight=FontWeight.SemiBold)}
                memberMethods(o,m,enabled,onTakePhoto,onPickPhoto,onPickFile)
                if(o.documentSelected){
                    item{CompactLabel(t("File selected"),color=BuriTheme.Muted,fontSize=14.sp)}
                    if(previewNeedsConsent)item{SmartConsent("I agree to send this document to OpenAI for text extraction",o.ocrConsent,enabled){value->o.documentRequestId?.let{m.onboardingDocumentConsent(it,value)}}}
                    item{Primary(t("Preview members"),{o.documentRequestId?.let(onPreviewFile)},enabled&&(!previewNeedsConsent||o.ocrConsent),secondary=true)}
                }
            }else if(!o.photoCaptureFlow){
                if(o.rows.isEmpty())item{Empty(t("No members"))}
                else item{Text(t("Review extracted members before saving"),fontSize=18.sp,fontWeight=FontWeight.SemiBold)}
            }else if(o.sourceKind==null&&(o.photoPreviewPending||s.busy||(o.documentUri==null&&s.error==null))){
                item{BuriInlineLoading("Working")}
            }else if(o.sourceKind==null&&o.documentUri!=null){
                item{Primary(t("Retry"),{o.documentRequestId?.let(onPreviewFile)},enabled,secondary=true)}
            }else if(o.sourceKind!=null&&o.rows.isEmpty()){
                item{Empty(t("No members"))}
            }
            if(o.rows.isNotEmpty())item{CompactLabel(t("%1\$d rows · %2\$d verified",o.rows.size,verified.size),fontSize=16.sp,fontWeight=FontWeight.Medium)}
            items(o.rows,key={it.row}){row->
                Row(Modifier.fillMaxWidth().heightIn(min=64.dp).clickable(enabled=enabled){m.onboardingEditRow(row.row)}.padding(vertical=8.dp),verticalAlignment=Alignment.CenterVertically){
                    Column(Modifier.weight(1f)){CompactLabel(row.name.ifBlank{t("Unreadable name")},fontSize=17.sp);CompactLabel(row.phone?:t("Number missing"),color=BuriTheme.Muted,fontSize=14.sp)}
                    CompactLabel(t(if(row.verified)"Verified" else "Review"),color=if(row.verified)BuriTheme.Good else BuriTheme.Blue,fontSize=15.sp)
                }
            }
            item{TextButton(m::onboardingOptions,enabled=!s.busy){CompactLabel(t("Back"),color=BuriTheme.Blue)}}
        }
        SmartOnboardingStep.RESULTS->Panel(footer={Primary(t("Done"),m::closeSheet,!s.busy)}){
            item{CompactLabel(t("%1\$d members registered",o.created),fontSize=22.sp,fontWeight=FontWeight.SemiBold)}
            items(o.results,key={it.row}){result->CompactLabel(t("Row %1\$d: %2\$s",result.row,t(result.status.replace('_',' '))),fontSize=15.sp,lineHeight=22.sp)}
        }
    }
}
