package rw.ikanisa.burimunsi

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.test.platform.app.InstrumentationRegistry
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cool.mobile.BuildConfig
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.export.ExportFormat
import rw.ikanisa.burimunsi.ui.*
import kotlin.math.ceil
import kotlin.math.floor
import java.util.Locale

/** Original handoff routes/panels exercised with synthetic records only.
 * These tests prove UI action wiring; server/device authorization is separately tested. */
@RunWith(AndroidJUnit4::class)
class NativeUiContractTest {
    @get:Rule val ui=createComposeRule()
    private fun show(c:FakeController,onPermissions:()->Unit={},onSupport:()->Unit={},onPhoneSettings:()->Unit={},onExport:(ExportFormat)->Unit={},onNotifications:()->Unit={},onBattery:()->Unit={}){ui.setContent{BuriContent(reduceMotion=true){BuriApp(model=c,onSupport=onSupport,onPermissions=onPermissions,onExport=onExport,onPhoneSettings=onPhoneSettings,onNotifications=onNotifications,onBatteryOptimization=onBattery)}}}
    private fun showInteractiveReview(
        c:FakeController,onExport:(ExportFormat)->Unit,onPickMemberFile:()->Unit,
        onTakeMemberPhoto:()->Unit,onPickMemberPhoto:()->Unit,onPreviewMemberFile:(String)->Unit
    ){
        ui.setContent{
            BuriContent(reduceMotion=true){
                BuriApp(model=c,onSupport={},onPermissions={},onExport=onExport,onPhoneSettings={},
                    onPickMemberFile=onPickMemberFile,onTakeMemberPhoto=onTakeMemberPhoto,
                    onPickMemberPhoto=onPickMemberPhoto,onPreviewMemberFile=onPreviewMemberFile)
            }
        }
    }
    private fun button(label:String)=ui.onNode(hasText(label) and hasClickAction())
    private fun radioOption(label:String)=ui.onNode(hasText(label) and
        SemanticsMatcher.expectValue(SemanticsProperties.Role,androidx.compose.ui.semantics.Role.RadioButton))
    private fun headerAction(label:String)=ui.onNode(hasContentDescription(label) and hasClickAction() and !hasAnyAncestor(hasScrollAction()))
    private fun visiblePayment(reference:String):SemanticsNodeInteraction{
        val match=hasText("FT Id: $reference") and hasClickAction()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(match)
        return ui.onNode(match).performScrollTo().assertIsDisplayed()
    }
    private fun panelButton(title:String,label:String)=ui.onNode(hasText(label) and hasClickAction() and hasAnyAncestor(
        SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.PaneTitle,title)))
    private fun panelList(title:String)=ui.onNode(hasScrollToIndexAction() and hasAnyAncestor(
        SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.PaneTitle,title)))
    private fun visiblePanelButton(title:String,label:String):SemanticsNodeInteraction{
        panelList(title).performScrollToNode(hasText(label) and hasClickAction())
        return panelButton(title,label).performScrollTo().assertIsDisplayed().assertIsEnabled()
    }
    private fun field(label:String)=ui.onNodeWithContentDescription(label)
    private fun assertReceiverControlsAbsent(c:FakeController){
        ui.onNodeWithContentDescription("Gateway status",substring=true).assertDoesNotExist()
        ui.onNodeWithContentDescription("Original SMS").assertDoesNotExist()
        for(label in listOf("Gateway","Pair receiver","Pair phone","Sync","Phone replacement","Replace phone","Replace receiver"))ui.onAllNodesWithText(label).assertCountEquals(0)
        ui.runOnIdle{check(!c.allows(Capability.SMS)&&!c.allows(Capability.GATEWAY));check(c.rawCalls==0&&c.pairCalls==0&&c.syncCalls==0&&c.replaceCalls==0)}
    }
    private fun captureOriginalEmptySignIn(){
        val image=ui.onRoot().captureToImage().asAndroidBitmap()
        InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.resolve("prototype-sign-in.png").outputStream().use{
            check(image.compress(Bitmap.CompressFormat.PNG,100,it))
        }
    }

    private fun capturePanel(panel: SemanticsNodeInteraction): Bitmap {
        panel.assertIsDisplayed()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return panel.captureToImage().asAndroidBitmap()

        // Compose cannot capture a dialog window before API 28. Crop the rendered screen to the panel.
        val node = panel.fetchSemanticsNode()
        val bounds = ui.runOnIdle {
            node.boundsInRoot.translate(node.positionOnScreen - node.positionInRoot)
        }
        val screenshot = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()) {
            "Unable to capture the dialog on screen"
        }
        val left = floor(bounds.left).toInt().coerceIn(0, screenshot.width)
        val top = floor(bounds.top).toInt().coerceIn(0, screenshot.height)
        val right = ceil(bounds.right).toInt().coerceIn(0, screenshot.width)
        val bottom = ceil(bounds.bottom).toInt().coerceIn(0, screenshot.height)
        check(left < right && top < bottom) { "Dialog has no visible area on screen: $bounds" }
        return Bitmap.createBitmap(screenshot, left, top, right - left, bottom - top)
    }

    @Test fun freshEntryIsOriginalPhoneAndFourDigitPasscode(){
        val c=FakeController(Route.LOGIN);show(c)
        ui.onNodeWithText("Welcome\nback.").assertExists()
        captureOriginalEmptySignIn()
        field("Phone number").performScrollTo().assertExists()
        field("Passcode").performScrollTo().assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").assertIsNotEnabled()
        for(extra in listOf("Setup code","Phone setup details","Email","Email code","Use another Collect account","Language"))ui.onNodeWithText(extra).assertDoesNotExist()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Phone number"))
        field("Phone number").performTextInput("0780000001")
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Passcode"))
        field("Passcode").performTextInput("246")
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").assertIsNotEnabled()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Passcode"))
        field("Passcode").performTextInput("8")
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").performClick()
        ui.runOnIdle{check(c.loginCalls==1&&c.lastPhone=="0780000001"&&c.lastPin=="2468")}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Passcode"))
        field("Passcode").assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText,androidx.compose.ui.text.AnnotatedString("")))
    }
    @Test fun startupShowsBlackBrandedSplashBeforeOriginalLogin(){
        val c=FakeController(Route.LOGIN);c.state=c.state.copy(starting=true,busy=true);c.operation=UiOperation.INITIAL_READ;c.operationLabel="Checking access";show(c)
        ui.onNodeWithTag("burimunsi-splash").assertIsDisplayed()
        ui.onNodeWithContentDescription("BuriMunsi").assertIsDisplayed()
        ui.onNodeWithText("Checking access").assertIsDisplayed()
        ui.onNodeWithText("Welcome\nback.").assertDoesNotExist()
        ui.onNodeWithContentDescription("Phone number").assertDoesNotExist()
        val bitmap=ui.onRoot().captureToImage().asAndroidBitmap()
        check(bitmap.getPixel(2,2)==android.graphics.Color.BLACK)
        ui.runOnIdle{c.state=c.state.copy(starting=false,busy=false)}
        ui.onNodeWithTag("burimunsi-splash").assertDoesNotExist()
        ui.onNodeWithText("Welcome\nback.").assertExists()
    }
    @Test fun syncPolicySettingsStayInTheReceiverAdminRole(){
        val c=FakeController(Route.SETTINGS);var notificationRequests=0;var batteryRequests=0
        show(c,onNotifications={notificationRequests++},onBattery={batteryRequests++})
        if(BuildConfig.IS_GATEWAY){
            button("Sync notifications").performScrollTo().assertIsEnabled().performClick()
            button("Battery optimization").performScrollTo().assertIsEnabled().performClick()
            ui.runOnIdle{check(notificationRequests==1&&batteryRequests==1)
                c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF,capabilities=setOf(Capability.READ.key)))}
        }
        ui.onNodeWithText("Sync notifications").assertDoesNotExist()
        ui.onNodeWithText("Battery optimization").assertDoesNotExist()
        ui.onNodeWithText("Background sync").assertDoesNotExist()
    }
    @Test fun phoneNextAndPasscodeDoneSubmitOnce(){
        val c=FakeController(Route.LOGIN);show(c)
        field("Phone number").performScrollTo().performTextInput("0780000001");field("Phone number").performImeAction()
        field("Passcode").assertIsFocused().performTextInput("2468");field("Passcode").performImeAction()
        ui.runOnIdle{check(c.loginCalls==1)}
    }
    @Test fun invalidPhoneNeverEnablesSignIn(){
        val c=FakeController(Route.LOGIN);show(c);field("Phone number").performScrollTo().performTextInput("abc");field("Passcode").performTextInput("2468")
        field("Passcode").performImeAction()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").assertIsNotEnabled();ui.runOnIdle{check(c.loginCalls==0)}
    }
    @Test fun signInShowsAccessibleProgressAndRetainsThePhoneOnFailure(){
        val c=FakeController(Route.LOGIN);c.simulatePendingSignIn=true;show(c)
        field("Phone number").performScrollTo().performTextInput("0780000001")
        field("Passcode").performScrollTo().performTextInput("2468")
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").performClick()
        ui.onNodeWithTag("active-operation:SIGN_IN").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Signing in…") and hasClickAction())
        button("Signing in…").assertIsNotEnabled().assert(SemanticsMatcher.expectValue(
            androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo,androidx.compose.ui.semantics.ProgressBarRangeInfo.Indeterminate))
        ui.runOnIdle{check(c.loginCalls==1);c.operation=UiOperation.NONE;c.state=c.state.copy(busy=false,error="Unable to sign in.")}
        ui.onNodeWithText("Unable to sign in.").assertExists()
        field("Phone number").performScrollTo().assert(SemanticsMatcher.expectValue(
            androidx.compose.ui.semantics.SemanticsProperties.EditableText,androidx.compose.ui.text.AnnotatedString("0780000001")))
        field("Passcode").performScrollTo().assert(SemanticsMatcher.expectValue(
            androidx.compose.ui.semantics.SemanticsProperties.EditableText,androidx.compose.ui.text.AnnotatedString("")))
    }
    @Test fun configurationBlockDoesNotPretendSignInIsRunning(){
        val c=FakeController(Route.LOGIN);c.state=c.state.copy(configurationRequired=true);show(c)
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Sign in") and hasClickAction())
        button("Sign in").assertIsNotEnabled()
        ui.onNodeWithText("Signing in…").assertDoesNotExist()
        ui.onNodeWithTag("active-operation:SIGN_IN").assertDoesNotExist()
    }
    @Test fun navigationUsesControllerReadPolicyAndAlwaysHonorsClosedAccessGate(){
        val c=FakeController(Route.HOME);c.state=c.state.copy(busy=true);c.operation=UiOperation.REFRESH;c.navigationOpenWhileBusy=true;c.simulateQueuedNavigation=true;show(c)
        ui.onNodeWithContentDescription("Members").assertIsEnabled().performClick()
        ui.onNodeWithContentDescription("Members").assertIsSelected()
        ui.onNodeWithTag("loading-skeleton").assertExists()
        ui.runOnIdle{check(c.state.route==Route.HOME&&c.requestedRoute==Route.MEMBERS);c.screenGate=ScreenGate.CHECKING}
        ui.onNodeWithContentDescription("Payments").assertIsNotEnabled()
        ui.onNodeWithText("Checking access").assertExists()
        ui.runOnIdle{check(c.state.route==Route.HOME)}
    }
    @Test fun smartOnboardingUsesTheExistingAddMemberSheet(){
        val c=FakeController(Route.HOME,Role.STAFF);var picks=0;var captures=0;var photos=0;val previews=mutableListOf<String>()
        ui.setContent{BuriContent(reduceMotion=true){BuriApp(c,{},{},{},{},onPickMemberFile={picks++},onPreviewMemberFile={previews.add(it)},onTakeMemberPhoto={captures++},onPickMemberPhoto={photos++})}}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Recent"))
        ui.onAllNodes(hasContentDescription("Add member") and hasClickAction()).assertCountEquals(1)
        ui.onNodeWithContentDescription("Your profile").assertDoesNotExist()
        val add=headerAction("Add member").assertIsDisplayed().assertIsEnabled()
        val addBounds=add.fetchSemanticsNode().boundsInRoot
        val refreshBounds=headerAction("Refresh").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        check(refreshBounds.right<=addBounds.left && refreshBounds.center.y in addBounds.top..addBounds.bottom){
            "Home Add member must sit beside Refresh: refresh=$refreshBounds, add=$addBounds"
        }
        add.performClick()
        ui.runOnIdle{check(c.state.route==Route.HOME && c.state.sheet==Sheet.ENROLL)}
        ui.onNodeWithText("How would you like to add members?",useUnmergedTree=true).assertDoesNotExist()
        val screenshot=capturePanel(ui.onNode(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.PaneTitle,"Add member")))
        InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.resolve("smart-onboarding-options.png").outputStream().use{
            check(screenshot.compress(Bitmap.CompressFormat.PNG,100,it))
        }
        visiblePanelButton("Add member","MoMo suggestions").assert(!hasText("Search unmatched payer names and last 3 digits")).performClick()
        ui.onNodeWithText("Add from MoMo").assertExists()
        ui.runOnIdle{check(c.state.onboarding.step==SmartOnboardingStep.SUGGESTIONS);c.onboardingOptions()}
        visiblePanelButton("Add member","Add manually").assert(!hasText("Enter a verified MoMo name and number")).performClick()
        field("MoMo name").assertExists();field("MoMo number").assertExists()
        panelList("Add member").performScrollToNode(hasText("Privacy notice and consent recorded"))
        ui.onNodeWithText("Privacy notice and consent recorded").assertIsDisplayed()
        ui.onNodeWithText("Eligible earlier MoMo payments may be matched and credited automatically after you add this member.").assertDoesNotExist()
        panelButton("Add member","Save member").assertIsNotEnabled()
        ui.runOnIdle{c.onboardingOptions()}
        val cameraNotice="Taking a photo sends it to OpenAI for extraction. Review members before saving."
        val camera=visiblePanelButton("Add member","Scan a list").assert(hasText(cameraNotice))
        ui.onNodeWithText(cameraNotice,useUnmergedTree=true).assertIsDisplayed()
        camera.performClick()
        ui.runOnIdle{check(captures==1&&c.state.onboarding.step==SmartOnboardingStep.IMPORT&&c.state.onboarding.photoCaptureFlow)}
        ui.onNodeWithText("Import member list").assertDoesNotExist()
        ui.onNodeWithText("Choose a file").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(onboarding=c.state.onboarding.copy(
            documentRequestId="capture-example",documentUri="content://synthetic/member-photo",documentSelected=true,ocrConsent=true,photoPreviewPending=false),error=null,busy=false)}
        panelButton("Add member","Retry").assertIsEnabled()
        ui.runOnIdle{c.state=c.state.copy(onboarding=c.state.onboarding.copy(sourceKind="image",documentRequestId=null,documentUri=null,
            documentSelected=false,rows=listOf(SmartImportRow(1,"Example Member","+250780000001","ready"))))}
        ui.onNodeWithText("Example Member").assertExists()
        ui.onNodeWithText("Choose a photo").assertDoesNotExist()
        ui.onNodeWithText("Choose a file").assertDoesNotExist()
        ui.runOnIdle{c.onboardingOptions()}
        visiblePanelButton("Add member","Choose a photo").assert(!hasText("Review extracted members before saving")).performClick()
        ui.runOnIdle{check(photos==1);c.state=c.state.copy(onboarding=c.state.onboarding.copy(
            documentRequestId="picker-example",documentUri="content://synthetic/member-photo",documentMimeType="image/jpeg",documentSelected=true))}
        panelList("Add member").performScrollToNode(hasText("Preview members"))
        panelButton("Add member","Preview members").assertIsNotEnabled()
        ui.onNodeWithText("I agree to send this document to OpenAI for text extraction").performScrollTo().performClick()
        panelButton("Add member","Preview members").performScrollTo().assertIsEnabled().performClick()
        ui.runOnIdle{check(previews==listOf("picker-example"))}
        ui.runOnIdle{c.onboardingOptions()}
        visiblePanelButton("Add member","Choose a file").assert(!hasText("Upload or scan, review, then register")).performClick()
        ui.runOnIdle{check(picks==1&&c.state.onboarding.step==SmartOnboardingStep.IMPORT)}
        panelList("Add member").performScrollToNode(hasText("Choose a file"))
        ui.onNodeWithText("Choose a file").assertExists()
        ui.onNodeWithText("Choose a file, review the extracted rows and register only verified members.").assertDoesNotExist()
        ui.onNodeWithText("CSV is available. Image, PDF and spreadsheet import require the document service.").assertDoesNotExist()
        panelList("Add member").performScrollToNode(hasText("Suggested from payments"))
        panelButton("Add member","Suggested from payments").performClick()
        ui.onNodeWithText("Add from MoMo").assertExists()
        ui.runOnIdle{c.onboardingImport()}
        panelList("Add member").performScrollToNode(hasText("Add manually"))
        panelButton("Add member","Add manually").performClick()
        field("MoMo name").assertExists()
        ui.runOnIdle{c.onboardingImport()}
        panelList("Add member").performScrollToNode(hasText("Take a photo of the list"))
        ui.onNodeWithText(cameraNotice).assertIsDisplayed()
        panelButton("Add member","Take a photo of the list").performClick()
        ui.runOnIdle{check(captures==2&&c.state.onboarding.photoCaptureFlow)}
        ui.runOnIdle{c.state=c.state.copy(onboarding=SmartOnboardingState(step=SmartOnboardingStep.IMPORT,sourceKind="csv",
            rows=listOf(SmartImportRow(1,"Reviewed Member","+250780000001","ready",verifiedOwnership=true,acceptedTerms=true,consentRecorded=true))))}
        ui.onNodeWithText("Suggested from payments").assertDoesNotExist()
        ui.onNodeWithText("Add manually").assertDoesNotExist()
        ui.onNodeWithText("Take a photo of the list").assertDoesNotExist()
    }
    @Test fun momoSuggestionsSearchMaskedPayersAndRequireVerifiedEnrollment(){
        val c=FakeController(Route.HOME,Role.STAFF);c.seedLinkedStatementReview();show(c)
        headerAction("Add member").performClick()
        visiblePanelButton("Add member","MoMo suggestions").performClick()
        ui.onAllNodesWithText("Add from MoMo").assertCountEquals(1)
        val search=ui.onNode(hasSetTextAction())
        search.assertIsDisplayed().assert(hasContentDescription("Name or last 3 digits"))
        button("Search").assertDoesNotExist();button("Select").assertDoesNotExist()
        button("Chantal Mukamana").assertIsDisplayed().assert(hasContentDescription("MoMo number ending in 4 1 8, 2 payments"))
        button("Élodie Uwase").assertIsDisplayed().assert(hasContentDescription("MoMo number ending in 7 6 3, 1 payment"))
        ui.onNodeWithText("+250780000418",substring=true,useUnmergedTree=true).assertDoesNotExist()
        ui.runOnIdle{
            val payers=c.state.onboarding.suggestions
            check(payers.map{Triple(it.momoName,it.last3,it.sourceCount)}==listOf(Triple("Chantal Mukamana","418",2),Triple("Élodie Uwase","763",1)))
            check(c.state.home?.unallocatedCount==0&&c.state.home?.recent?.all{it.memberId!=null}==true)
        }
        search.performTextReplacement("elodie");button("Élodie Uwase").assertExists();button("Chantal Mukamana").assertDoesNotExist()
        search.performTextReplacement("41");ui.onNodeWithText("No matching payers").assertExists()
        button("Clear search").performScrollTo().performClick();button("Chantal Mukamana").assertExists()
        search.performTextReplacement("418");button("Élodie Uwase").assertDoesNotExist()
        button("Chantal Mukamana").performScrollTo().assertIsEnabled().performClick()
        field("MoMo name").assert(hasText("Chantal Mukamana"))
        val number=field("MoMo number");number.assertExists()
        ui.runOnIdle{check(c.state.draft["phone"].isNullOrBlank())}
        val save=panelButton("Add member","Save member")
        save.assertIsNotEnabled()
        number.performTextReplacement("0780000999")
        ui.onNodeWithText("The number does not match the suggestion.").assertExists()
        number.performTextReplacement("0780000418");number.performImeAction()
        val checks=listOf("Full number and phone ownership verified","Member accepted the savings terms","Privacy notice and consent recorded")
        fun attest(){
            for(label in checks){
                panelList("Add member").performScrollToNode(hasText(label) and hasClickAction())
                ui.onNode(hasText(label) and hasClickAction()).performScrollTo().performClick()
            }
        }
        attest();save.assertIsEnabled()
        panelList("Add member").performScrollToNode(hasContentDescription("MoMo name"))
        field("MoMo name").performTextReplacement("Chantal Mukamana A.")
        save.assertIsNotEnabled()
        ui.runOnIdle{check(!c.state.onboarding.verifiedOwnership&&!c.state.onboarding.acceptedTerms&&!c.state.onboarding.consentRecorded)}
        field("MoMo name").performTextReplacement("Chantal Mukamana")
        attest();save.assertIsEnabled().performClick()
        ui.runOnIdle{check(c.state.onboarding.created==1&&c.state.onboarding.results.single().status=="created")}
        button("Done").performClick();headerAction("Add member").performClick()
        visiblePanelButton("Add member","MoMo suggestions").performClick()
        button("Chantal Mukamana").assertDoesNotExist();button("Élodie Uwase").assertExists()
    }

    @Test fun momoSuggestionVerificationRechecksTheKnownSourceNumberAndAccess(){
        val c=FakeController(Route.HOME,Role.STAFF);c.seedLinkedStatementReview();c.openSheet(Sheet.ENROLL)
        c.onboardingSuggestions()
        val candidate=c.state.onboarding.suggestions.single{it.last3=="418"}
        val originalHome=c.state.home
        c.onboardingSearchQuery("elodie");c.onboardingChoose(candidate.candidateId)
        check(c.state.onboarding.step==SmartOnboardingStep.SUGGESTIONS)
        c.onboardingSuggestions();c.onboardingChoose(candidate.candidateId)
        c.editDraft("phone","0781234418")
        for(key in listOf("ownership","terms","consent"))c.onboardingConsent(key,true,c.state.draft)
        c.onboardingSubmit(candidate.momoName,"0781234418")
        check(c.state.onboarding.created==0&&c.state.onboarding.results.single().status=="candidate_changed")
        check(c.state.home==originalHome)
        c.onboardingSuggestions();check(c.state.onboarding.suggestions.contains(candidate))
        c.state=c.state.copy(offline=true);c.onboardingChoose(candidate.candidateId)
        check(c.state.onboarding.step==SmartOnboardingStep.SUGGESTIONS)
        c.state=c.state.copy(offline=false,operator=null);c.onboardingChoose(candidate.candidateId)
        check(c.state.onboarding.step==SmartOnboardingStep.SUGGESTIONS)
    }

    @Test fun momoSuggestionStatesOfferRetryOrManualEntry(){
        val c=FakeController(Route.HOME,Role.STAFF);c.openSheet(Sheet.ENROLL)
        val loading=SmartOnboardingState(step=SmartOnboardingStep.SUGGESTIONS,suggestionsLoading=true)
        c.state=c.state.copy(onboarding=loading);show(c)
        ui.onNodeWithText("Finding payers").assertIsDisplayed()
        ui.onNodeWithText("No new payers yet").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(onboarding=loading.copy(suggestionsLoading=false,suggestionsFailed=true))}
        ui.onNodeWithText("Couldn’t load payers").assertIsDisplayed();button("Retry").performClick()
        ui.onNodeWithText("No new payers yet").assertIsDisplayed()
        button("Add manually").performClick();field("MoMo number").assertExists()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Test fun englishEnrollmentStaysUsableAtDoubleFontScaleOnANonEnglishConfiguration(){
        val c=FakeController(Route.MEMBERS);c.state=c.state.copy(sheet=Sheet.ENROLL)
        val target=InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        check(target.packageName in setOf("rw.ikanisa.burimunsi.staff.cloud.nativeTest","rw.ikanisa.burimunsi.gateway.cloud.nativeTest"))
        val display=target.getSharedPreferences("buri-display",android.content.Context.MODE_PRIVATE)
        val otherSettings=display.all.filterKeys{it!="language"}
        check(display.edit().putString("language","rw").commit())
        ui.setContent{
            ModalBottomSheet(onDismissRequest={},sheetState=rememberModalBottomSheetState(skipPartiallyExpanded=true)){
                // A sheet has its own Android window. Supply the test configuration inside that window.
                val context=LocalContext.current
                val deviceConfiguration=LocalConfiguration.current
                val reviewContext=remember(context,deviceConfiguration){
                    context.createConfigurationContext(Configuration(deviceConfiguration).apply{
                        setLocale(Locale.forLanguageTag("rw-RW"))
                        fontScale=2f
                    })
                }
                val config=reviewContext.resources.configuration
                CompositionLocalProvider(
                    LocalContext provides reviewContext,LocalConfiguration provides config,
                    LocalDensity provides Density(LocalDensity.current.density,config.fontScale)
                ){
                    BuriContent(reduceMotion=true){
                        check(LocalUiText.current.locale.language=="en")
                        SmartEnrollPanel(c.state,c,{},{},{},{})
                    }
                }
            }
        }
        ui.runOnIdle{
            check(!display.contains("language") && display.all==otherSettings){
                "The English-only migration must remove only the legacy language preference."
            }
        }
        val list=ui.onNode(hasScrollToIndexAction())
        fun method(label:String):SemanticsNodeInteraction{
            val match=hasText(label) and hasClickAction()
            list.performScrollToNode(match)
            return ui.onNode(match).performScrollTo().assertIsDisplayed().assertIsEnabled()
        }
        val suggestions=method("MoMo suggestions").fetchSemanticsNode().boundsInRoot
        val manual=method("Add manually").fetchSemanticsNode().boundsInRoot
        val layouts=mutableListOf<TextLayoutResult>()
        ui.onNodeWithText("Add manually",useUnmergedTree=true).performSemanticsAction(SemanticsActions.GetTextLayoutResult){
            check(it(layouts))
        }
        check(layouts.single().layoutInput.density.fontScale==2f){"The rendered method label must use 200% text."}
        check(kotlin.math.abs(suggestions.left-manual.left)<=1f && kotlin.math.abs(suggestions.right-manual.right)<=1f){
            "At 200% text size the first two methods must stack in one column."
        }
        val notice="Taking a photo sends it to OpenAI for extraction. Review members before saving."
        method("Scan a list").assert(hasText(notice))
        ui.onNodeWithText(notice,useUnmergedTree=true).assertIsDisplayed()
        method("Choose a photo")
        method("Choose a file")
        method("Add manually").performClick()
        for(label in listOf("MoMo name","MoMo number")){
            list.performScrollToNode(hasContentDescription(label));field(label).assertIsDisplayed()
        }
        val consent="Privacy notice and consent recorded"
        list.performScrollToNode(hasText(consent))
        ui.onNodeWithText(consent).assertIsDisplayed()
    }
    @Test fun privacyGateDisposesCredentialsAndRecordsWithinOriginalRoute(){
        val c=FakeController(Route.LOGIN);show(c);field("Passcode").performScrollTo().performTextInput("2468")
        ui.runOnIdle{c.screenGate=ScreenGate.BACKGROUND};field("Passcode").assertDoesNotExist()
        ui.runOnIdle{c.screenGate=ScreenGate.OPEN};field("Passcode").performScrollTo().assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.EditableText,androidx.compose.ui.text.AnnotatedString("")))
        ui.runOnIdle{c.state=c.state.copy(operator=c.operator,route=Route.PAYMENTS);c.screenGate=ScreenGate.CHECKING}
        ui.onNodeWithContentDescription("10,000 RWF").assertDoesNotExist()
        ui.onNodeWithContentDescription("Payments").assertIsSelected()
    }
    @Test fun bottomNavigationCoversEverySignedInRouteAndMapsDetailSelection(){
        val c=FakeController(Route.HOME);show(c)
        val expected=mapOf(Route.HOME to "Home",Route.PAYMENTS to "Payments",Route.PAYMENT to "Payments",Route.MEMBERS to "Members",Route.MEMBER to "Members",Route.SMS to "Home",Route.SETTINGS to "Account")
        for((route,selected)in expected){
            if(route==Route.SMS&&!BuildConfig.IS_GATEWAY)continue
            ui.runOnIdle{c.state=c.state.copy(route=route)}
            for(label in listOf("Home","Members","Payments","Account"))ui.onNodeWithContentDescription(label).assertExists()
            ui.onNodeWithContentDescription(selected).assertIsSelected().assert(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role,androidx.compose.ui.semantics.Role.Tab))
        }
    }
    @Test fun memberLinkOpensTheCentralPaymentsScreen(){
        val c=FakeController(Route.PAYMENTS,Role.STAFF);c.seedStatementReview();show(c)
        ui.onNodeWithContentDescription("Your profile").assertDoesNotExist()
        ui.onNodeWithContentDescription("Download statement").assertDoesNotExist()
        headerAction("Payment filters").assertIsDisplayed().assertIsEnabled().performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS && c.state.sheet==Sheet.FILTERS)}
        ui.onNodeWithTag("panel-close").performClick()
        visiblePayment("ST-A-IN").assert(hasContentDescription("Marie Uwase")).performClick()
        ui.onNodeWithText("Member statement").assertIsDisplayed()
        ui.onNodeWithText("Aline Nkurunziza").assertIsDisplayed()
        headerAction("Download statement").assertIsDisplayed().assertIsEnabled()
        ui.onNodeWithText("Clear member filter").assertDoesNotExist()
        ui.runOnIdle{
            check(c.state.route==Route.PAYMENTS && c.state.routeId=="member-1")
            check(c.state.payments?.items?.map{it.ftId}==listOf("ST-A-IN","ST-A-OUT","ST-A-EARLIER"))
        }
        visiblePayment("ST-A-IN").assert(hasContentDescription("Incoming"))
        visiblePayment("ST-A-EARLIER").assert(hasContentDescription("Incoming"))
        visiblePayment("ST-A-OUT").assert(hasContentDescription("Outgoing")).performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENT && c.state.payment?.id=="statement-a-out")}
        ui.onNodeWithContentDescription("Download statement").assertDoesNotExist()
        headerAction("Back").performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS && c.state.routeId=="member-1")}
        headerAction("Back").performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS && c.state.routeId==null)}
        visiblePayment("ST-B-IN").assert(hasContentDescription("Marie Uwase")).performClick()
        ui.onNodeWithText("Eric Nshimiyimana").assertIsDisplayed()
        ui.runOnIdle{check(c.state.routeId=="member-2" && c.state.payments?.items?.single()?.id=="statement-b-in")}
        visiblePayment("ST-B-IN").assert(hasContentDescription("Incoming"))
        ui.onNodeWithText("FT Id: ST-A-IN").assertDoesNotExist()
        headerAction("Back").performClick()
        visiblePayment("ST-UNLINKED").performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENT && c.state.payment?.id=="statement-unlinked")}
        ui.onNodeWithTag("payment-allocation-fixed").assertIsDisplayed()
        ui.onNodeWithContentDescription("Members").performClick()
        val memberRow=hasContentDescription("Aline Nkurunziza") and hasClickAction()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(memberRow)
        ui.onNode(memberRow).performScrollTo().performClick()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("View payments") and hasClickAction())
        button("View payments").performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS && c.state.routeId=="member-1")}
        headerAction("Back").performClick()
        ui.runOnIdle{check(c.state.route==Route.MEMBER && c.state.routeId=="member-1")}
    }
    @Test fun paymentFiltersUseOnlyTheAllocationStates(){
        val c=FakeController(Route.PAYMENTS);show(c);ui.onNodeWithContentDescription("Payment filters").performClick()
        ui.onNodeWithText("Filters").assertExists();ui.onNodeWithText("Status").assertExists();ui.onNodeWithTag("payment-filter-select").performClick()
        ui.onNodeWithTag("listing-choice-dialog").assertIsDisplayed()
        val radioOption = SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Role, androidx.compose.ui.semantics.Role.RadioButton)
        ui.onNode(hasText("All") and radioOption and isSelected()).assertExists()
        button("Cancel").performClick()
        ui.onNodeWithTag("listing-choice-dialog").assertDoesNotExist()
        ui.onNodeWithTag("payment-filter-select").assert(hasText("All")).performClick()
        ui.onNodeWithText("Processing").assertDoesNotExist();ui.onNode(hasText("Unallocated") and radioOption).performClick();ui.runOnIdle{check(c.filterCalls==0)}
        val applyBounds=button("Apply").fetchSemanticsNode().boundsInRoot
        val resetBounds=button("Reset all").fetchSemanticsNode().boundsInRoot
        check(applyBounds.bottom<=resetBounds.top){"Filter Apply and Reset must have separate hit areas"}
        button("Apply").performClick();ui.runOnIdle{check(c.filterCalls==1&&c.state.filter=="unallocated"&&c.state.sheet==null){"Expected Unallocated applied once; actual sheet=${c.state.sheet}, filter=${c.state.filter}, applies=${c.filterCalls}"}}
    }
    @Test fun overviewKeepsReportedUnallocatedCountAndAllPaymentsAction(){
        val c=FakeController(Route.HOME,Role.STAFF)
        val initial=c.state.home!!.copy(memberCount=128,unallocatedCount=1)
        fun useSavings(savings:HomeSavings?){c.state=c.state.copy(home=initial.copy(savings=savings))}
        val reconciled=HomeSavings(lifetimeContributionsRwf=10000,outgoingPaymentsRwf=2500,
            latestWalletBalanceRwf=7500,reconciliationStatus="reconciled")
        useSavings(reconciled)
        show(c)
        ui.onNodeWithContentDescription("Lifetime member contributions · 10,000 RWF").assertIsDisplayed()
        val outgoingBounds=ui.onNodeWithContentDescription("Total outgoing payments · 2,500 RWF")
            .assertIsDisplayed().assert(!hasClickAction()).fetchSemanticsNode().boundsInRoot
        val balanceBounds=ui.onNodeWithContentDescription("MoMo balance · last SMS · 7,500 RWF")
            .assertIsDisplayed().assert(!hasClickAction()).fetchSemanticsNode().boundsInRoot
        ui.onNodeWithText("Lifetime member contributions").assertDoesNotExist()
        ui.onNodeWithText("Total outgoing payments").assertDoesNotExist()
        ui.runOnIdle{useSavings(reconciled.copy(latestWalletBalanceRwf=7413,reconciliationStatus="mismatch"))}
        ui.onNodeWithContentDescription("MoMo balance · last SMS · 7,413 RWF").assertIsDisplayed()
        ui.onNodeWithText("7,413 RWF",useUnmergedTree=true).assertIsDisplayed()
        ui.onNodeWithContentDescription("MoMo balance · last SMS · 7,500 RWF").assertDoesNotExist()
        ui.onNodeWithText("Contributions less outgoing payments differ from the last MoMo balance.",useUnmergedTree=true).assertDoesNotExist()
        ui.runOnIdle{useSavings(reconciled.copy(lifetimeContributionsRwf=null,latestWalletBalanceRwf=null,reconciliationStatus="unavailable"))}
        ui.onNodeWithContentDescription("Lifetime member contributions · Unavailable").assertIsDisplayed()
        ui.onNodeWithContentDescription("MoMo balance · last SMS · Unavailable").assertIsDisplayed()
        ui.onNodeWithContentDescription("Recorded outgoing payments · 2,500 RWF").assertIsDisplayed()
        ui.onNodeWithContentDescription("Total outgoing payments · 2,500 RWF").assertDoesNotExist()
        ui.onNodeWithText("Wallet reconciliation needs a verified opening balance and a complete record of payments and fees.").assertExists()
        ui.runOnIdle{useSavings(null)}
        ui.onNodeWithContentDescription("Lifetime member contributions · Unavailable").assertIsDisplayed()
        ui.onNodeWithContentDescription("Total outgoing payments · Unavailable").assertIsDisplayed()
        ui.onNodeWithContentDescription("MoMo balance · last SMS · Unavailable").assertIsDisplayed()
        ui.runOnIdle { useSavings(reconciled);c.state=c.state.copy(homeSavingsLoading=true) }
        ui.onNodeWithText("Loading payment totals").assertExists()
        ui.onNodeWithText("Savings figures unavailable.").assertDoesNotExist()
        ui.onNodeWithContentDescription("Lifetime member contributions",substring=true).assertDoesNotExist()
        ui.runOnIdle { c.state=c.state.copy(homeSavingsLoading=false,homeWalletUnavailable=true) }
        ui.onNodeWithContentDescription("Cumulative incoming payments · Unavailable").assertExists()
        ui.onNodeWithContentDescription("Cumulative outgoing payments · Unavailable").assertExists()
        ui.onNodeWithContentDescription("Lifetime member contributions",substring=true).assertDoesNotExist()
        ui.runOnIdle { c.state=c.state.copy(homeWalletUnavailable=false) }
        val list=ui.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasContentDescription("1 unallocated"))
        ui.onNodeWithContentDescription("Open members").assertDoesNotExist()
        ui.onNodeWithContentDescription("Open payments").assertDoesNotExist()
        ui.onNodeWithContentDescription("Members · 128").assertDoesNotExist()
        ui.onNode(hasText("Members") and hasAnyAncestor(hasScrollToIndexAction()),useUnmergedTree=true).assertDoesNotExist()
        ui.onNodeWithText("As of ",substring=true).assertDoesNotExist()
        val membersTab=ui.onNodeWithContentDescription("Members")
        membersTab.assertIsDisplayed().assertIsEnabled()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role,androidx.compose.ui.semantics.Role.Tab)).performClick()
        ui.runOnIdle{check(c.state.route==Route.MEMBERS)}
        membersTab.assertIsSelected()
        ui.onNodeWithContentDescription("Your profile").assertDoesNotExist()
        headerAction("Add member").assertIsDisplayed().assertIsEnabled().performClick()
        ui.runOnIdle{check(c.state.route==Route.MEMBERS && c.state.sheet==Sheet.ENROLL)}
        ui.onNodeWithTag("panel-close").performClick()
        ui.onNodeWithContentDescription("Home").performClick()
        list.performScrollToNode(hasContentDescription("1 unallocated"))
        val rowBounds=ui.onNodeWithContentDescription("1 unallocated").assertHasClickAction().performScrollTo().fetchSemanticsNode().boundsInRoot
        if(InstrumentationRegistry.getInstrumentation().targetContext.resources.configuration.fontScale<=1f){
            check(maxOf(outgoingBounds.height,balanceBounds.height)<rowBounds.height){
                "Compact savings amounts should be shorter than the actionable Home row"
            }
            if(outgoingBounds.bottom>balanceBounds.top){
                check(outgoingBounds.right<=balanceBounds.left && balanceBounds.right-outgoingBounds.left<rowBounds.width){
                    "The short amounts should sit separately within a narrower span than the full Home row"
                }
            }
        }
        list.performScrollToNode(hasContentDescription("All payments"))
        val allPayments=ui.onNodeWithContentDescription("All payments").performScrollTo().assertIsDisplayed()
        val actionBounds=allPayments.fetchSemanticsNode().boundsInRoot
        val navBounds=ui.onNodeWithContentDescription("Account").fetchSemanticsNode().boundsInRoot
        check(actionBounds.bottom<=navBounds.top){"All payments is covered by navigation: action=$actionBounds; nav=$navBounds"}
        allPayments.performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS){"All payments opened ${c.state.route}"}}
    }
    @Test fun walletHomeShowsExactAmountsAndOnlyAuthorizedSmsFigures(){
        val c=FakeController(Route.HOME,Role.ADMIN)
        val home=checkNotNull(c.state.home)
        fun use(totals:HomeWalletTotals){ c.state=c.state.copy(home=home.copy(paymentTotals=totals)) }
        val totals=HomeWalletTotals("9007199254740993".toBigInteger(),"9007199254740994".toBigInteger(),
            500L,"-501".toBigInteger(),true)
        use(totals)
        show(c)
        val list=ui.onNode(hasScrollToIndexAction())
        fun expectAmount(label:String){
            list.performScrollToNode(hasContentDescription(label))
            ui.onNodeWithContentDescription(label).performScrollTo().assertIsDisplayed()
        }
        expectAmount("Cumulative incoming payments · 9,007,199,254,740,993 RWF")
        expectAmount("Cumulative outgoing payments · 9,007,199,254,740,994 RWF")
        expectAmount("Latest MoMo SMS balance · 500 RWF")
        list.performScrollToNode(hasText("Wallet difference · -501 RWF"))
        ui.onNodeWithText("Wallet difference · -501 RWF").performScrollTo().assertIsDisplayed()
        ui.onNodeWithText("Contributions less outgoing payments differ from the last MoMo balance.").assertDoesNotExist()
        val zero="0".toBigInteger()
        ui.runOnIdle { use(HomeWalletTotals(zero,zero,0L,zero,true)) }
        expectAmount("Cumulative incoming payments · 0 RWF")
        expectAmount("Cumulative outgoing payments · 0 RWF")
        expectAmount("Latest MoMo SMS balance · 0 RWF")
        ui.onNodeWithText("Wallet difference",substring=true).assertDoesNotExist()
        ui.runOnIdle { use(HomeWalletTotals(zero,zero,null,null,true)) }
        expectAmount("Latest MoMo SMS balance · Unavailable")
        ui.onNodeWithText("Wallet difference",substring=true).assertDoesNotExist()
        ui.runOnIdle { use(HomeWalletTotals(zero,zero,null,null,false)) }
        expectAmount("Cumulative outgoing payments · 0 RWF")
        ui.onNodeWithContentDescription("Latest MoMo SMS balance",substring=true).assertDoesNotExist()
        ui.onNodeWithText("Wallet difference",substring=true).assertDoesNotExist()
        ui.runOnIdle {
            use(totals)
            c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF))
        }
        expectAmount("Cumulative outgoing payments · 9,007,199,254,740,994 RWF")
        ui.onNodeWithContentDescription("Latest MoMo SMS balance",substring=true).assertDoesNotExist()
        ui.onNodeWithText("Wallet difference",substring=true).assertDoesNotExist()
    }
    @Test fun homeOpensActualRecentPaymentsAndShowsAllocationState(){
        val c=FakeController(Route.HOME,Role.STAFF)
        val home=c.state.home!!
        val original=c.state.payment!!
        val pending=original.copy(id="pending-1",payerNameRaw="EXAMPLE PENDING",state="unallocated",outcome="pending")
        val outgoing=original.copy(id="outgoing-1",payerNameRaw="EXAMPLE OUTGOING",state="allocated",direction="outgoing")
        c.state=c.state.copy(home=home.copy(recent=emptyList()))
        show(c)
        val list=ui.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasText("No recent payments"))
        ui.onNodeWithText("No recent payments").assertIsDisplayed()
        ui.runOnIdle{c.state=c.state.copy(home=home.copy(paymentCount=2,unallocatedCount=1,recent=listOf(pending,outgoing)))}
        list.performScrollToNode(hasContentDescription("EXAMPLE PENDING"))
        val pendingRow=ui.onNode(hasContentDescription("EXAMPLE PENDING") and hasClickAction())
        pendingRow.assert(hasContentDescription("Unallocated"))
        list.performScrollToNode(hasContentDescription("EXAMPLE OUTGOING"))
        val outgoingRow=ui.onNode(hasContentDescription("EXAMPLE OUTGOING") and hasClickAction())
        outgoingRow.assert(hasContentDescription("Outgoing") and hasContentDescription("Allocated")).performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENT&&c.lastNavigationId==outgoing.id)}
    }
    @Test fun searchIsLiveAndHasNoAddedSubmitControl(){
        val c=FakeController(Route.PAYMENTS,Role.STAFF);c.seedStatementReview();show(c)
        field("Name or payment reference").performTextInput("Marie")
        ui.mainClock.advanceTimeBy(350);ui.waitForIdle();ui.runOnIdle{
            check(c.state.search=="Marie" && c.searchCalls==1)
            check(c.state.payments?.items?.map{it.id}==listOf("statement-a-in","statement-b-in"))
        }
        ui.onNodeWithText("Load more").assertDoesNotExist()
        ui.onNodeWithContentDescription("Members").performClick()
        field("Name or MoMo number").assertIsDisplayed()
        val list=ui.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasTestTag("listing-sort-menu"))
        val sort=ui.onNodeWithTag("listing-sort-menu")
        sort.assert(hasContentDescription("Sort by") and hasText("Newest first")).performClick()
        ui.onNodeWithTag("listing-sort-choices").assertIsDisplayed()
        radioOption("Newest first").assertIsSelected()
        radioOption("Name · Z–A").assertIsNotSelected().performClick()
        sort.assert(hasText("Name · Z–A")).performClick()
        radioOption("Name · Z–A").assertIsSelected()
        radioOption("Newest first").assertIsNotSelected()
        radioOption("Name · Z–A").performClick()
        val directoryIndex=list.fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
        ui.runOnIdle{check(directoryIndex("member-2")>=0 && directoryIndex("member-2")<directoryIndex("member-1"))}
        button("Filters").performScrollTo().performClick()
        panelList("Filters").performScrollToNode(hasTestTag("listing-active-select"))
        val membership=ui.onNodeWithTag("listing-active-select")
        membership.performScrollTo().performClick()
        radioOption("All").assertIsSelected()
        radioOption("Active").assertIsNotSelected()
        radioOption("Inactive").assertIsNotSelected().performClick()
        membership.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription,"Inactive")).performClick()
        radioOption("Inactive").assertIsSelected()
        radioOption("All").assertIsNotSelected()
        radioOption("Active").assertIsNotSelected()
        radioOption("Inactive").performClick()
        panelButton("Filters","Apply").performClick()
        button("Filters (1)").assertExists()
        ui.runOnIdle{check(c.state.members?.items?.single()?.id=="member-2")}
        list.performScrollToNode(hasContentDescription("Name or MoMo number"))
        field("Name or MoMo number").performTextReplacement("780000002")
        field("Name or MoMo number").performImeAction()
        ui.runOnIdle{check(c.state.search=="780000002" && c.state.members?.items?.single()?.id=="member-2")}
        field("Name or MoMo number").performTextReplacement("Aline")
        field("Name or MoMo number").performImeAction()
        ui.runOnIdle{check(c.state.search=="Aline" && c.state.members?.items?.isEmpty()==true)}
    }
    @Test fun profileToPasscodeReplacesSheetAndCloseReturnsToRoute(){
        val c=FakeController(Route.HOME,Role.STAFF);show(c)
        ui.onNodeWithContentDescription("Account").performClick()
        ui.runOnIdle{check(c.state.route==Route.SETTINGS)}
        ui.onNode(hasContentDescription(c.operator.name) and hasClickAction()).assertIsDisplayed().performClick()
        ui.runOnIdle{check(c.state.sheet==Sheet.PROFILE)}
        panelButton("Profile","Change passcode").assertIsDisplayed().performClick();ui.runOnIdle{check(c.state.sheet==Sheet.PIN)}
        ui.onNodeWithContentDescription("Back to previous panel").assertDoesNotExist();ui.onNodeWithTag("panel-close").performClick()
        ui.runOnIdle{check(c.state.sheet==null&&c.state.route==Route.SETTINGS)}
    }
    @Test fun passcodeConfirmationImeDoesNotChangeCredentialUntilSave(){
        val c=FakeController(Route.HOME);c.state=c.state.copy(sheet=Sheet.PIN);show(c)
        val panelTitle = "Change passcode"
        panelList(panelTitle).performScrollToNode(hasContentDescription("Current passcode"))
        field("Current passcode").assertIsDisplayed().performTextInput("2468")
        field("Current passcode").assertIsFocused().performImeAction()
        field("New passcode").assertIsFocused().performTextInput("8642")
        field("New passcode").performImeAction()
        field("Confirm passcode").assertIsFocused().performTextInput("8642")
        field("Confirm passcode").performImeAction()
        ui.runOnIdle { check(c.pinChangeCalls == 0) }
        panelButton(panelTitle, "Save").assertIsEnabled().performClick()
        ui.runOnIdle { check(c.pinChangeCalls == 1) }
    }
    @Test fun rawReceiptOpensDirectlyAndLinksToItsPayment(){
        val c=FakeController(Route.PAYMENT);show(c)
        if(BuildConfig.IS_GATEWAY){
            ui.onNodeWithTag("payment-details-scroll").performScrollToNode(hasContentDescription("Original SMS"))
            ui.onNodeWithContentDescription("Original SMS").performClick()
            ui.onNodeWithText(c.receiptBody).performScrollTo().assertExists();ui.onNodeWithText("Review reason").assertDoesNotExist();ui.onNodeWithText("Reveal original SMS").assertDoesNotExist()
            panelButton("M-Money","Open payment").performClick();ui.runOnIdle{check(c.state.route==Route.PAYMENT&&c.lastNavigationId=="tx-1"&&c.rawCalls==1)}
        }else{
            assertReceiverControlsAbsent(c)
            ui.onNodeWithText(c.receiptBody).assertDoesNotExist()
        }
    }
    @Test fun backgroundPrivacyNeverExposesRawReceipt(){
        val c=FakeController(Route.PAYMENT)
        if(BuildConfig.IS_GATEWAY)c.openSheet(Sheet.RAW,"sms-1")
        show(c)
        if(BuildConfig.IS_GATEWAY){
            ui.onNodeWithText(c.receiptBody).assertExists();ui.runOnIdle{c.screenGate=ScreenGate.BACKGROUND};ui.onNodeWithText(c.receiptBody).assertDoesNotExist()
        }else{
            assertReceiverControlsAbsent(c);ui.onNodeWithContentDescription("10,000 RWF").assertExists()
            ui.runOnIdle{c.screenGate=ScreenGate.BACKGROUND}
            ui.onNodeWithContentDescription("10,000 RWF").assertDoesNotExist();ui.onNodeWithText(c.receiptBody).assertDoesNotExist()
            ui.runOnIdle{c.screenGate=ScreenGate.OPEN}
            ui.onNodeWithContentDescription("10,000 RWF").assertExists();assertReceiverControlsAbsent(c)
        }
    }
    @Test fun allCurrentPanelTitlesRemainReachable(){
        val c=FakeController(Route.HOME);show(c)
        val titles=mapOf(Sheet.PROFILE to "Profile",Sheet.PIN to "Change passcode",Sheet.HELP to "Help",Sheet.ALLOCATE to "Allocate",Sheet.ENROLL to "Add member",Sheet.STAFF to "Staff access",Sheet.STAFF_EDIT to "Add staff",Sheet.REMOVE_STAFF to "Remove access?",Sheet.GATEWAY to "Gateway",Sheet.REPLACE_DEVICE to "Replace receiver",Sheet.RAW to "M-Money",Sheet.MEMBER_DETAILS to "Member details",Sheet.AUDIT to "Activity log",Sheet.FILTERS to "Filters")
        check(titles.size==14)
        val receiverPanels=setOf(Sheet.GATEWAY,Sheet.REPLACE_DEVICE,Sheet.RAW)
        val accessible=if(BuildConfig.IS_GATEWAY)titles else titles.filterKeys{it !in receiverPanels}
        check(accessible.size==if(BuildConfig.IS_GATEWAY)14 else 11)
        for((sheet,title)in accessible){ui.runOnIdle{c.openSheet(sheet,if(sheet==Sheet.RAW)"sms-1"else null)};ui.onNode(hasText(title)and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Heading,Unit)).assertExists();ui.onNodeWithTag("panel-close").performClick();ui.runOnIdle{check(c.state.sheet==null)}}
        if(!BuildConfig.IS_GATEWAY){ui.runOnIdle{c.state=c.state.copy(route=Route.SETTINGS)};assertReceiverControlsAbsent(c)}
    }
    @Test fun gatewayUsesSmsPermissionWithoutPairingCode(){
        val c=FakeController(Route.HOME);var requests=0
        c.state=c.state.copy(gateway=GatewayStatus(true,true,null,0,null,null,null,"permission_required",observationMode=true),sheet=if(BuildConfig.IS_GATEWAY)Sheet.GATEWAY else null);show(c,onPermissions={requests++})
        if(BuildConfig.IS_GATEWAY){
            ui.onNodeWithText("Gateway").assertExists();field("Pairing code").assertDoesNotExist()
            ui.onNodeWithTag("check:Business SIM inserted").assertDoesNotExist()
            panelButton("Gateway","SMS permission").performClick();ui.runOnIdle{check(requests==1&&c.pairCalls==0)}
        }else{
            assertReceiverControlsAbsent(c);field("Pairing code").assertDoesNotExist()
            ui.runOnIdle{c.state=c.state.copy(route=Route.SETTINGS)};assertReceiverControlsAbsent(c)
        }
    }
    @Test fun homeOmitsGatewayControlForAllRolesAndSettingsKeepsRecovery(){
        val c=FakeController(Route.HOME);val healthy=c.state.gateway!!;show(c)
        fun assertHomeHasNoGatewayControl(){
            ui.onNodeWithContentDescription("Gateway status",substring=true).assertDoesNotExist()
            for(label in listOf("Sync enabled","Sync paused","SMS access required","Notification access required","Sync unconfirmed","Status unavailable"))ui.onNodeWithText(label).assertDoesNotExist()
            val list=ui.onNode(hasScrollToIndexAction())
            if(c.allows(Capability.SMS)){
                list.performScrollToNode(hasContentDescription("Messages"))
                ui.onNodeWithContentDescription("Messages").assertIsDisplayed().assertHasClickAction()
            }else{
                list.performScrollToNode(hasText("Recent"))
                ui.onNodeWithContentDescription("Messages").assertDoesNotExist()
            }
            ui.onNodeWithContentDescription("Open members").assertDoesNotExist()
            ui.onNodeWithContentDescription("Open payments").assertDoesNotExist()
            ui.runOnIdle{check(c.state.sheet==null)}
        }
        assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.state=c.state.copy(offline=true)}
        ui.onNodeWithContentDescription("Add member").assertIsDisplayed().assertIsNotEnabled()
        ui.runOnIdle{c.state=c.state.copy(offline=false,busy=true)}
        ui.onNodeWithContentDescription("Add member").assertIsDisplayed().assertIsNotEnabled()
        ui.runOnIdle{c.state=c.state.copy(busy=false);c.screenGate=ScreenGate.CHECKING}
        ui.onNodeWithContentDescription("Add member").assertDoesNotExist()
        ui.runOnIdle{c.screenGate=ScreenGate.OPEN}
        ui.runOnIdle{c.continuousSyncRunning=false};assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.continuousSyncRunning=true;c.continuousSyncProblem="notification_permission_required"};assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.continuousSyncProblem=null;c.state=c.state.copy(gateway=healthy.copy(captureEnabled=false,problem="observation_paused",observationMode=true))};assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.state=c.state.copy(gateway=healthy.copy(problem="permission_required"))};assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.state=c.state.copy(gateway=null)};assertHomeHasNoGatewayControl()
        ui.runOnIdle{c.state=c.state.copy(gateway=healthy)}
        ui.onNodeWithContentDescription("Account").performClick()
        if(BuildConfig.IS_GATEWAY){
            button("Gateway").performScrollTo().assertIsEnabled().performClick()
            ui.runOnIdle{check(c.state.sheet==Sheet.GATEWAY)}
            ui.onNodeWithTag("panel-close").performClick()
        }else assertReceiverControlsAbsent(c)
        // A stale authorized receiver snapshot must not expose SMS controls to staff.
        ui.runOnIdle{c.state=c.state.copy(route=Route.HOME,operator=c.operator.copy(role=Role.STAFF,capabilities=setOf(Capability.READ.key)),gateway=healthy)}
        assertHomeHasNoGatewayControl();assertReceiverControlsAbsent(c)
        ui.onNodeWithContentDescription("Add member").assertDoesNotExist()
        val paymentsTab=ui.onNodeWithContentDescription("Payments")
        paymentsTab.assertIsDisplayed().assertIsEnabled()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role,androidx.compose.ui.semantics.Role.Tab))
            .performClick()
        ui.runOnIdle{check(c.state.route==Route.PAYMENTS && c.state.routeId==null)}
        paymentsTab.assertIsSelected()
        ui.onNodeWithContentDescription("Home").performClick()
        ui.onNodeWithContentDescription("Account").performClick();assertReceiverControlsAbsent(c)
    }
    @Test fun gatewayObservationsCanSyncAndResumeButCannotPauseWithoutPairing(){
        val c=FakeController(Route.HOME);c.state=c.state.copy(gateway=GatewayStatus(true,true,null,0,null,null,null,null,observationMode=true),sheet=if(BuildConfig.IS_GATEWAY)Sheet.GATEWAY else null);show(c)
        if(BuildConfig.IS_GATEWAY){
            panelList("Gateway").performScrollToNode(hasText("Sync") and hasClickAction());panelButton("Gateway","Sync").performClick();ui.runOnIdle{check(c.syncCalls==1)}
            ui.onNodeWithText("Pause").assertDoesNotExist()
            ui.runOnIdle{c.state=c.state.copy(gateway=c.state.gateway!!.copy(captureEnabled=false,problem="observation_paused"))}
            panelButton("Gateway","Resume").performScrollTo().performClick();ui.runOnIdle{check(c.state.gateway?.captureEnabled==true&&c.pairCalls==0&&c.replaceCalls==0)}
            field("Pairing code").assertDoesNotExist()
        }else{
            assertReceiverControlsAbsent(c)
            ui.runOnIdle{c.state=c.state.copy(route=Route.SETTINGS)};assertReceiverControlsAbsent(c)
        }
    }
    @Test fun pairedReceiverCanRequestMissingSmsPermissionWithoutPausing(){
        val c=FakeController(Route.HOME);var requests=0;c.permissionsRequired=true
        c.state=c.state.copy(gateway=GatewayStatus(true,false,1,0,null,null,null,"permission_required"),sheet=if(BuildConfig.IS_GATEWAY)Sheet.GATEWAY else null)
        show(c,onPermissions={requests++})
        if(BuildConfig.IS_GATEWAY){
            panelList("Gateway").performScrollToNode(hasText("SMS permission") and hasClickAction())
            panelButton("Gateway","SMS permission").assertIsEnabled().performClick()
            ui.onNodeWithText("Pause").assertDoesNotExist();ui.onNodeWithText("Resume").assertDoesNotExist()
            ui.runOnIdle{check(requests==1&&c.state.gateway?.captureEnabled==false)}
        }else assertReceiverControlsAbsent(c)
    }
    @Test fun queuedSmsMetadataShowsQueuedAndIsPermissionGated(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS);c.smsAccessGranted=true
        c.state=c.state.copy(filter="queued",messages=null,observations=null,offline=true,
            queuedObservations=listOf(QueuedObservationRow("request-1","SyntheticSender","2026-11-09T00:00:00Z","Synthetic queued preview")))
        show(c)
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("queued-observation:request-1"))
        ui.onNodeWithTag("queued-observation:request-1").assertExists().assert(!hasClickAction())
        ui.onNodeWithContentDescription("SyntheticSender").assertExists();ui.onNodeWithText("Synthetic queued preview").assertExists();ui.onNodeWithText("Not verified").assertDoesNotExist()
        ui.onNodeWithText(c.receiptBody).assertDoesNotExist();ui.onNodeWithText("Open contribution").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(queuedObservations=listOf(QueuedObservationRow("request-2","OtherSender","2026-11-09T00:01:00Z")))}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("queued-observation:request-2"))
        ui.onNodeWithTag("queued-observation:request-1").assertDoesNotExist();ui.onNodeWithTag("queued-observation:request-2").assertExists()
        ui.runOnIdle{c.smsAccessGranted=false}
        ui.onNodeWithTag("queued-observation:request-2").assertDoesNotExist()
        ui.runOnIdle{c.logout()};ui.onNodeWithTag("queued-observation:request-2").assertDoesNotExist()
    }
    @Test fun originalFormPlaceholdersDescribeExpectedInputs(){
        val c=FakeController(Route.HOME);c.state=c.state.copy(sheet=Sheet.ENROLL);show(c)
        panelButton("Add member","Add manually").performClick()
        ui.onNodeWithText("Registered full name",useUnmergedTree=true).assertExists()
        ui.runOnIdle{c.state=c.state.copy(sheet=Sheet.ALLOCATE,sheetId=null)}
        panelList("Allocate").performScrollToNode(hasContentDescription("Find member"))
        field("Find member").assertIsDisplayed()
        ui.onNodeWithText("How was the member confirmed?",useUnmergedTree=true).assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(sheet=Sheet.STAFF_EDIT,sheetId=null,selectedStaff=null,draft=emptyMap())}
        ui.onNodeWithText("Full name",useUnmergedTree=true).assertExists()
        val account=StaffAccount("staff-1","Example Staff","+250780000001",true,1,setOf("records.read"))
        ui.runOnIdle{c.state=c.state.copy(sheetId=account.id,selectedStaff=account,draft=mapOf("name" to account.name,"phone" to account.phone))}
        ui.onNodeWithText("Leave blank to keep current",useUnmergedTree=true).assertExists()
        ui.runOnIdle{c.state=c.state.copy(draft=c.state.draft+("phone" to "+250780000002"))}
        ui.onNodeWithText("Leave blank to keep current",useUnmergedTree=true).assertExists()
        panelButton("Edit staff","Save changes").assertIsEnabled().performClick()
        ui.runOnIdle{check(c.staffSaveCalls==1&&c.lastStaffPhone=="+250780000002"&&c.lastStaffPin.isEmpty())}
        ui.runOnIdle{c.state=c.state.copy(sheetId=null,selectedStaff=null,draft=mapOf("name" to "Example Staff","phone" to "+250780000002"))}
        ui.onNodeWithText("Passcode",useUnmergedTree=true).assertDoesNotExist()
        ui.onNodeWithText("New passcode",useUnmergedTree=true).assertDoesNotExist()
        panelButton("Add staff","Create staff").assertIsEnabled().performClick()
        ui.runOnIdle{check(c.staffSaveCalls==2&&c.lastStaffPin.isEmpty())}
        ui.runOnIdle{c.state=c.state.copy(sheetId=account.id,selectedStaff=account,draft=mapOf("name" to account.name,"phone" to account.phone))}
        field("New passcode").performScrollTo().performTextInput("26")
        panelButton("Edit staff","Save changes").assertIsNotEnabled()
        field("New passcode").performTextInput("84")
        panelButton("Edit staff","Save changes").assertIsEnabled().performClick()
        ui.runOnIdle{check(c.staffSaveCalls==3&&c.lastStaffPin=="2684")}
    }
    @Test fun staffViewsHaveNoInventedPreferencesOrAdminGatewayControls(){
        val c=FakeController(Route.SETTINGS,Role.STAFF);show(c)
        for(extra in listOf("Language","Reduce screen motion","Staff access","Gateway","Activity","Open BuriMunsi Admin","Receive payment SMS"))ui.onNodeWithText(extra).assertDoesNotExist()
        for(label in listOf("Use phone language","English","Ikinyarwanda"))ui.onNode(hasText(label) and hasClickAction()).assertDoesNotExist()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Change passcode"));ui.onNodeWithText("Change passcode").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Help"));ui.onNodeWithText("Help").assertExists()
        ui.runOnIdle{c.state=c.state.copy(route=Route.HOME)};assertReceiverControlsAbsent(c)
    }
    @Test fun settingsSmsPermissionUsesTheAvailableAndroidAction(){
        val c=FakeController(Route.SETTINGS,Role.ADMIN);var requests=0;var settings=0
        show(c,onPermissions={requests++},onPhoneSettings={settings++})
        val row=button("SMS permission")
        if(BuildConfig.IS_GATEWAY){
            ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("SMS permission") and hasClickAction())
            row.assertIsEnabled().assert(hasText("Required")).performClick()
            ui.runOnIdle{check(requests==1&&settings==0);c.smsAccessGranted=true}
            row.assertIsEnabled().assert(hasText("Granted")).performClick()
            ui.runOnIdle{check(requests==1&&settings==1);c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF))}
            row.assertDoesNotExist()
        }else{
            val target = InstrumentationRegistry.getInstrumentation().targetContext
            var opened: android.content.Intent? = null
            val recording = object : android.content.ContextWrapper(target) {
                override fun startActivity(intent: android.content.Intent) { opened = intent }
            }
            check(!AdminReceiverEntry.open(recording,Role.STAFF) && opened == null)
            if (AdminReceiverEntry.intent(target) == null) {
                ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Receive payment SMS"))
                ui.onNodeWithText("Install the signed BuriMunsi Admin app provided by your organization, then sign in with your mobile number and passcode.").assertExists()
                check(!AdminReceiverEntry.open(recording,Role.ADMIN))
            } else {
                ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Open BuriMunsi Admin") and hasClickAction())
                button("Open BuriMunsi Admin").assertIsEnabled()
                check(AdminReceiverEntry.open(recording,Role.ADMIN) && opened?.component?.packageName == "rw.ikanisa.burimunsi.gateway.cloud.nativeTest")
                check(opened?.data == null && opened?.extras == null)
            }
            ui.runOnIdle{c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF))}
            row.assertDoesNotExist()
            ui.onNodeWithText("Open BuriMunsi Admin").assertDoesNotExist()
            ui.runOnIdle{check(requests==0&&settings==0)}
        }
    }
    @Test fun parsedSmsUsesExistingScreensWithoutManualVerification(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS);c.smsAccessGranted=true;val source=SmsSourceRef.Observation("synthetic-source")
        c.state=c.state.copy(messages=null,observations=Page(listOf(ObservationListRow(source,"synthetic-group","2026-11-09T00:00:00Z")),null,1,"v1","2026-11-09T00:00:00Z"),
            observationProcessing=mapOf(source to ObservationProcessing("parsed",false)))
        show(c);ui.onNodeWithText("Parsed").assertExists();ui.onNodeWithText("Not verified").assertDoesNotExist()
        ui.onNodeWithText("SMS receipt · Unavailable").assertExists()
        ui.runOnIdle{c.state=c.state.copy(gateway=c.state.gateway!!.copy(approvedSenders=listOf("Example provider")))}
        ui.onNodeWithText("Example provider · Unavailable").assertExists()
        ui.runOnIdle{c.state=c.state.copy(gateway=c.state.gateway!!.copy(approvedSenders=listOf("First provider","Second provider")))}
        ui.onNodeWithText("SMS receipt · Unavailable").assertExists()
        ui.runOnIdle{c.openSms(source)}
        ui.onNodeWithText("This message is unverified and has not been posted to the ledger.").assertDoesNotExist()
        ui.onNodeWithText("Reference shown in SMS").assertExists()
        panelButton("M-Money","Open payment").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(raw=c.state.raw!!.copy(sender="Example provider"))}
        ui.onNode(hasText("Example provider") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Heading,Unit)).assertExists()
        ui.runOnIdle{c.state=c.state.copy(raw=c.state.raw!!.copy(sender=""))}
        ui.onNode(hasText("SMS receipt") and SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.Heading,Unit)).assertExists()
    }
    @Test fun auditedSmsPreviewsSearchBothTypedStreamsAndMarkPartial(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS);c.smsAccessGranted=true;val canonical=SmsSourceRef.Canonical("source-1");val observed=SmsSourceRef.Observation("source-1")
        c.state=c.state.copy(messages=Page(listOf(SmsRow(canonical.id,"","2026-11-09T08:00:00Z","","synced",null)),null,1,"c-v1","2026-11-09T08:00:00Z"),
            observations=Page(listOf(ObservationListRow(observed,"synthetic-group","2026-11-09T08:00:00Z")),"next",2,"o-v1","2026-11-09T08:00:00Z"),
            queuedObservations=emptyList(),
            smsListContent=mapOf(canonical to SmsListContent("Canonical sender","ordinary body"),observed to SmsListContent("Observation sender","A".repeat(220)+"needle")))
        show(c)
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Canonical sender"))
        ui.onNodeWithContentDescription("Canonical sender").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Observation sender"))
        ui.onNodeWithContentDescription("Observation sender").assertExists()
        ui.runOnIdle{c.state=c.state.copy(smsListSearch="needle")}
        ui.onNodeWithContentDescription("Canonical sender").assertDoesNotExist()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Observation sender"))
        ui.onNodeWithContentDescription("Observation sender").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Search incomplete for this account and phone."))
        ui.onNodeWithText("Search incomplete for this account and phone.").assertExists()
        ui.runOnIdle{c.state=c.state.copy(smsListSearch="no-match")}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Search incomplete for this account and phone."))
        ui.onNodeWithText("Search incomplete for this account and phone.").assertExists()
        ui.onNodeWithText("No matching messages on this account and phone.").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(observations=c.state.observations!!.copy(nextCursor=null,totalCount=1))}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("No matching messages on this account and phone."))
        ui.onNodeWithText("No matching messages on this account and phone.").assertExists()
        val capped=(0 until 98).associate{SmsSourceRef.Observation("other-$it") as SmsSourceRef to SmsListContent("Sender","body")}+
            mapOf(canonical to SmsListContent("Canonical sender","body"),observed to SmsListContent("Observation sender","body"))
        ui.runOnIdle{c.moreCalls=0;c.moreObservationCalls=0;c.state=c.state.copy(smsListSearch="",smsListContent=capped,
            observations=c.state.observations!!.copy(nextCursor="next",totalCount=2))}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Messages incomplete for this account and phone."))
        ui.onNodeWithText("Messages incomplete for this account and phone.").assertExists()
        ui.mainClock.advanceTimeBy(350);ui.waitForIdle();ui.runOnIdle{check(c.moreCalls==0&&c.moreObservationCalls==0)}
    }
    @Test fun allSmsIncludesOwnQueuedRowsWithoutMergingUncertainSources(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS);c.smsAccessGranted=true
        val source=SmsSourceRef.Observation("same-id")
        c.state=c.state.copy(messages=Page(emptyList(),null,0,"c-v1","2026-11-09T08:00:00Z"),
            observations=Page(listOf(ObservationListRow(source,"synthetic-group","2026-11-09T08:00:00Z")),null,1,"o-v1","2026-11-09T08:00:00Z"),
            queuedObservations=listOf(QueuedObservationRow("same-id","Local sender","2026-11-09T08:00:00Z","Local preview")),
            smsListContent=mapOf(source to SmsListContent("Remote sender","Remote preview")))
        show(c)
        ui.onNodeWithText("Unavailable").assertExists() // Two sources may describe one SMS after a lost acknowledgement.
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("queued-observation:same-id"))
        ui.onNodeWithTag("queued-observation:same-id").assertExists().assert(!hasClickAction())
        ui.onNodeWithContentDescription("Local sender").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("Remote sender"))
        ui.onNodeWithContentDescription("Remote sender").assertExists()
        ui.onNodeWithText("Not verified").assertDoesNotExist();ui.onNodeWithText("Status unavailable").assertExists()
        ui.onNodeWithText("Parsed").assertDoesNotExist()
        ui.runOnIdle{c.smsAccessGranted=false};ui.onNodeWithTag("queued-observation:same-id").assertDoesNotExist()
        ui.onNodeWithContentDescription("Remote sender").assertDoesNotExist();ui.onNodeWithText("Remote preview").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(smsListSearch="Remote preview")}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Search incomplete for this account and phone."))
        ui.onNodeWithText("Search incomplete for this account and phone.").assertExists()
        ui.runOnIdle{c.smsAccessGranted=true;c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF))}
        ui.onNodeWithTag("queued-observation:same-id").assertDoesNotExist()
    }
    @Test fun observationStatusAndRetryReflectAdminProcessingAuthority(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS);c.smsAccessGranted=true
        val source=SmsSourceRef.Observation("synthetic-source")
        c.state=c.state.copy(messages=null,queuedObservations=emptyList(),
            observations=Page(listOf(ObservationListRow(source,"synthetic-group","2026-11-09T00:00:00Z")),null,1,"v1","2026-11-09T00:00:00Z"))
        show(c)
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Status unavailable"))
        ui.onNodeWithText("Status unavailable").assertExists();ui.onNodeWithText("Parsed").assertDoesNotExist()
        for((status,label) in listOf("pending" to "Pending","parsed" to "Parsed","retrying" to "Retrying","needs_review" to "Needs review")){
            ui.runOnIdle{c.state=c.state.copy(observationProcessing=mapOf(source to ObservationProcessing(status,status=="needs_review")))}
            ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(label));ui.onNodeWithText(label).assertExists()
        }
        ui.runOnIdle{c.openSms(source)}
        panelList("M-Money").performScrollToNode(hasText("This status does not confirm a payment."))
        ui.onNodeWithText("This status does not confirm a payment.").assertExists()
        panelButton("M-Money","Retry").assertIsEnabled().performClick()
        ui.runOnIdle{check(c.observationRetryCalls==1)}
        ui.onNodeWithText("Retry scheduled.").assertExists();panelButton("M-Money","Retry").assertDoesNotExist()
        ui.runOnIdle{c.closeSheet();c.state=c.state.copy(operator=c.operator.copy(role=Role.STAFF,capabilities=setOf(Capability.READ.key)));c.openSms(source)}
        ui.runOnIdle{check(c.state.sheet==null&&c.deniedSheetRequests==1&&c.observationRetryCalls==1)}
    }
    @Test fun allSmsDoesNotClaimEmptyWhileTheLocalQueueIsUnknown(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.SMS)
        c.state=c.state.copy(messages=Page(emptyList(),null,0,"c-v1","2026-11-09T08:00:00Z"),
            observations=Page(emptyList(),null,0,"o-v1","2026-11-09T08:00:00Z"),queuedObservations=null)
        show(c)
        ui.onNodeWithText("No messages").assertDoesNotExist();ui.onNodeWithText("SMS sync unavailable.").assertExists()
        ui.onNodeWithText("Unavailable").assertExists()
        ui.runOnIdle{c.smsAccessGranted=true;c.state=c.state.copy(queuedUnavailable=true)}
        ui.onNodeWithText("No messages").assertDoesNotExist();ui.onNodeWithText("SMS sync unavailable.").assertExists()
        ui.runOnIdle{c.state=c.state.copy(queuedUnavailable=false)}
        ui.onNodeWithText("No messages").assertDoesNotExist();ui.onNodeWithText("Queue state unavailable").assertExists()
    }
    @Test fun legacyNonAssignableStatesNeverOfferAllocate(){
        val c=FakeController(Route.PAYMENT);c.state=c.state.copy(payment=c.state.payment!!.copy(state="unknown"));show(c)
        ui.onNodeWithText("Unallocated").assertExists();button("Allocate").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(payment=c.state.payment!!.copy(state="corrected"))}
        ui.onNodeWithText("Unallocated").assertExists()
        button("Allocate").assertDoesNotExist()
    }
    @Test fun incompleteOutgoingPaymentKeepsActualFieldsAndBlocksAllocation(){
        val c=FakeController(Route.PAYMENT)
        c.state=c.state.copy(payment=c.state.payment!!.copy(payerNameRaw="",payerPhoneRaw="",amountRwf=null,ftId=null,
            state="recorded",memberId=null,memberPhone=null,sourceKind="observation",direction="outgoing",outcome="pending",
            feeRwf=25,walletBalanceAfterRwf=1900))
        show(c)
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Direction"))
        ui.onNodeWithText("Outgoing").assertExists();ui.onNodeWithText("Unallocated").assertExists()
        ui.onNodeWithText("RWF 25").assertExists()
        ui.onNodeWithText("null").assertDoesNotExist()
        button("Allocate").assertDoesNotExist()
        if(BuildConfig.IS_GATEWAY){
            ui.onNodeWithTag("payment-details-scroll").performScrollToNode(hasContentDescription("Original SMS"))
            ui.onNodeWithContentDescription("Original SMS").performClick()
            ui.runOnIdle{check(c.state.rawSource==SmsSourceRef.Observation("sms-1"))}
        }
    }
    @Test fun paymentReferenceAndProviderIdDisplayIndependently(){
        val c=FakeController(Route.PAYMENT)
        c.state=c.state.copy(payment=c.state.payment!!.copy(paymentReference="100000000017",ftId="FT-EXAMPLE"))
        show(c)
        val list=ui.onNodeWithTag("payment-details-scroll")
        list.performScrollToNode(hasText("Payment reference"))
        ui.onNodeWithText("Payment reference").assertIsDisplayed()
        ui.onNodeWithText("100000000017").assertIsDisplayed()
        list.performScrollToNode(hasText("FT-EXAMPLE"))
        ui.onNodeWithText("FT-EXAMPLE").assertIsDisplayed()
        ui.runOnIdle{c.state=c.state.copy(payment=c.state.payment!!.copy(paymentReference=null))}
        ui.onNodeWithText("Payment reference").assertDoesNotExist()
        ui.onNodeWithText("FT-EXAMPLE").assertIsDisplayed()
    }
    @Test fun allocationActionStaysAboveNavigationAndHonorsAccessAndOfflineState(){
        val c=FakeController(Route.PAYMENT);c.state=c.state.copy(payment=c.state.payment!!.copy(state="unallocated",direction="outgoing",memberId=null,memberPhone=null));show(c)
        ui.onNodeWithTag("payment-details-scroll").performScrollToNode(hasText("Direction"))
        ui.onNodeWithTag("payment-allocation-fixed").assertIsDisplayed().assertIsEnabled().performClick()
        ui.runOnIdle{check(c.state.sheet==Sheet.ALLOCATE)}
        panelButton("Allocate","Allocate").assertIsNotEnabled()
        ui.runOnIdle{c.state=c.state.copy(selectedMember=c.state.members!!.items.first())}
        panelButton("Allocate","Allocate").assertIsEnabled().performClick()
        ui.runOnIdle{check(c.allocateCalls==1);c.state=c.state.copy(sheet=null,offline=true)}
        ui.onNodeWithTag("payment-allocation-fixed").assertIsDisplayed().assertIsNotEnabled()
        ui.runOnIdle{c.state=c.state.copy(offline=false,operator=c.operator.copy(capabilities=setOf("records.read")))}
        ui.onNodeWithTag("payment-allocation-fixed").assertDoesNotExist()
    }
    @Test fun discardPromptRemainsInTheCurrentSheetAndPreservesDraftUntilConfirmed(){
        val c=FakeController(Route.HOME);c.state=c.state.copy(sheet=Sheet.ENROLL,draft=mapOf("name" to "Example"),draftDirty=true,discardRequested=true);show(c)
        panelButton("Add member","Keep editing").assertIsDisplayed().performClick()
        ui.runOnIdle{check(c.state.sheet==Sheet.ENROLL&&!c.state.discardRequested&&c.state.draft["name"]=="Example");c.state=c.state.copy(discardRequested=true)}
        panelButton("Add member","Discard changes").assertIsDisplayed().performClick()
        ui.runOnIdle{check(c.state.sheet==null&&c.state.draft.isEmpty())}
    }
    @Test fun gatewayShowsOnlyThePairedReceivingCodeSnapshot(){
        if(!BuildConfig.IS_GATEWAY)return
        val c=FakeController(Route.HOME);c.state=c.state.copy(gateway=c.state.gateway!!.copy(pairedReceivingCode="31415"),sheet=Sheet.GATEWAY);show(c)
        ui.onNodeWithText("Paired receiving code").performScrollTo().assertExists()
        ui.onNodeWithText("31415").performScrollTo().assertExists()
    }
    @Test fun supportUsesThePublishedWhatsAppNumberFromHelpAndSignIn(){
        val c=FakeController(Route.SETTINGS);var calls=0;show(c,onSupport={calls++})
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Help") and hasClickAction())
        ui.onNodeWithText("Help").performClick()
        ui.onNodeWithText("+250 788 767 816").assertIsDisplayed()
        panelButton("Help","WhatsApp").assertIsEnabled().performClick();ui.runOnIdle{check(calls==1)}
        ui.runOnIdle{c.state=UiState(configurationRequired=true)}
        ui.onNodeWithContentDescription("Contact admin on WhatsApp").assertIsEnabled().performClick()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Contact admin on WhatsApp") and hasClickAction())
        button("Contact admin on WhatsApp").assertIsEnabled().performClick();ui.runOnIdle{check(calls==3)}
    }
    private data class RenderedHomeAmount(val text:String,val sizeSp:Float,val weight:Int,val bounds:Rect)

    private fun renderedHomeAmount(label:String,amount:String,fontScale:Float):RenderedHomeAmount{
        val expected="$amount RWF"
        val description="$label · $expected"
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription(description))
        val card=ui.onNodeWithContentDescription(description).performScrollTo().assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val characters=expected.filterNot(Char::isWhitespace)
        val text=ui.onNode(SemanticsMatcher("rendered $expected"){node->
            SemanticsProperties.Text in node.config && node.config[SemanticsProperties.Text].any{
                it.text.filterNot(Char::isWhitespace)==characters
            }
        },useUnmergedTree=true).assertIsDisplayed()
        val results=mutableListOf<TextLayoutResult>()
        text.performSemanticsAction(SemanticsActions.GetTextLayoutResult){check(it(results))}
        val result=results.single()
        val value=result.layoutInput.text.text
        check(value.filterNot(Char::isWhitespace)==characters && result.layoutInput.density.fontScale==fontScale)
        check(!result.hasVisualOverflow && (0 until result.lineCount).none(result::isLineEllipsized)){
            "$label has overflowing or ellipsized text: $value at font scale $fontScale"
        }
        if(fontScale==1f)check(result.lineCount==1){"$label should fit $value on one line at ordinary width"}
        val bounds=text.fetchSemanticsNode().boundsInRoot
        check(bounds.width+1f>=result.size.width && bounds.height+1f>=result.size.height &&
            bounds.left>=card.left-1f && bounds.right<=card.right+1f &&
            bounds.top>=card.top-1f && bounds.bottom<=card.bottom+1f){"$label is clipped by its container"}
        for(offset in value.indices.filterNot{value[it].isWhitespace()}){
            val glyph=result.getBoundingBox(offset)
            check(glyph.width>0f && glyph.height>0f && glyph.left>=-1f && glyph.top>=-1f &&
                glyph.right<=result.size.width+1f && glyph.bottom<=result.size.height+1f){
                "$label does not fully draw character $offset of $value at font scale $fontScale"
            }
        }
        val style=result.layoutInput.style
        return RenderedHomeAmount(value,style.fontSize.value,(style.fontWeight?:FontWeight.Normal).weight,card)
    }

    @Test fun twoHundredPercentTypePreservesCompleteMoneyAndAccessibleIdentity(){
        val c=FakeController(Route.HOME,Role.STAFF)
        val home=checkNotNull(c.state.home)
        var scale by mutableStateOf(1f)
        var widthFraction by mutableStateOf(1f)
        ui.setContent{
            val displayDensity=LocalDensity.current.density
            CompositionLocalProvider(LocalDensity provides Density(displayDensity,scale)){
                Box(Modifier.fillMaxSize(),contentAlignment=Alignment.TopCenter){
                    Box(Modifier.widthIn(max=400.dp).fillMaxWidth(widthFraction).fillMaxHeight()){
                        BuriContent(reduceMotion=true){BuriApp(c,{},{},{},{})}
                    }
                }
            }
        }
        fun measure(savings:HomeSavings,lifetime:String,outgoing:String,wallet:String):List<RenderedHomeAmount>{
            ui.runOnIdle{c.state=c.state.copy(home=home.copy(savings=savings))}
            return listOf(
                renderedHomeAmount("Lifetime member contributions",lifetime,scale),
                renderedHomeAmount("Total outgoing payments",outgoing,scale),
                renderedHomeAmount("MoMo balance · last SMS",wallet,scale)
            )
        }
        val list=ui.onNode(hasScrollToIndexAction())
        val ordinaryWidth=list.fetchSemanticsNode().boundsInRoot.width
        for(fontScale in listOf(1f,2f)){
            ui.runOnIdle{scale=fontScale;widthFraction=if(fontScale==1f)1f else .8f}
            if(fontScale==2f)check(list.fetchSemanticsNode().boundsInRoot.width<ordinaryWidth)
            val short=measure(HomeSavings(1000,200,800,"reconciled"),"1,000","200","800")
            val long=measure(HomeSavings(100_000_000_000,10_000_000_000,10_000_000,"mismatch"),
                "100,000,000,000","10,000,000,000","10,000,000")
            for((brief,extended) in short.zip(long)){
                check(extended.weight<brief.weight){"${extended.text} must use a lighter weight than ${brief.text} at font scale $fontScale"}
                val sizeFits=if(fontScale==1f)extended.sizeSp<brief.sizeSp else extended.sizeSp<=brief.sizeSp
                check(sizeFits){"${extended.text} has an unexpected font size ${extended.sizeSp} sp against ${brief.sizeSp} sp for ${brief.text} at font scale $fontScale"}
            }
            for((brief,extended) in short.drop(1).zip(long.drop(1))){
                check(extended.bounds.width>brief.bounds.width || extended.bounds.height>brief.bounds.height){
                    "The amount card must grow to fit the larger balance at font scale $fontScale"
                }
            }
            list.performScrollToIndex(0)
            val image=ui.onRoot().captureToImage().asAndroidBitmap()
            val file=if(fontScale==1f)"home-amounts-standard.png" else "home-amounts-compact-200.png"
            InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.resolve(file).outputStream().use{
                check(image.compress(Bitmap.CompressFormat.PNG,100,it))
            }
        }
        ui.runOnIdle{widthFraction=1f;c.navigate(Route.PAYMENTS,null)}
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("10,000 RWF"))
        ui.onNodeWithContentDescription("10,000 RWF").assertExists();ui.onNodeWithContentDescription("EXAMPLE PERSON WITH A VERY LONG FULL NAME",substring=true).assertExists()
        ui.runOnIdle{c.state=c.state.copy(route=Route.MEMBERS,sheet=Sheet.ENROLL);c.onboardingManual()}
        panelList("Add member").performScrollToNode(hasText("Privacy notice and consent recorded"))
        ui.onNodeWithText("Privacy notice and consent recorded").assertIsDisplayed()
        panelButton("Add member","Save member").assertIsDisplayed().assertIsNotEnabled()
    }

    private fun assertTextLayout(text:String, ellipsized:Boolean) {
        ui.onNodeWithText(text, useUnmergedTree=true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { getLayout ->
                val layouts=mutableListOf<TextLayoutResult>()
                check(getLayout(layouts))
                val layout=layouts.single()
                check(layout.layoutInput.text.text==text)
                if(ellipsized) check(layout.lineCount==1 && layout.isLineEllipsized(0))
                else check(layout.lineCount>1 && (0 until layout.lineCount).none(layout::isLineEllipsized))
            }
    }

    @Test fun narrowStaffAndActionLabelsKeepTheirFullAccessibleNamesAndWarningsWrap(){
        val name="Example cooperative operator with an especially long personal name"
        val action="Register verified members from the reviewed list"
        val warning="Check the saved details before confirming this change."
        var opened=0
        ui.setContent {
            val density=LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density,2f)) {
                BuriContent(reduceMotion=true) {
                    Box(Modifier.fillMaxSize()) {
                        Column(Modifier.width(216.dp).verticalScroll(rememberScrollState())) {
                            SettingRow(app.cool.mobile.R.drawable.ic_members,name,click={opened++})
                            Primary(action,{},icon=app.cool.mobile.R.drawable.ic_arrow,iconTrailing=true)
                            BuriStatusMessage(warning,error=true)
                        }
                    }
                }
            }
        }
        assertTextLayout(name,ellipsized=true)
        assertTextLayout(action,ellipsized=true)
        assertTextLayout(warning,ellipsized=false)
        button(name).performClick()
        ui.runOnIdle{check(opened==1)}
    }

    @Test fun longSearchChipFitsItsScrollingToolbarAndKeepsTheCompleteRemovalAction(){
        val search="Example member from the demonstration cooperative in Kigali"
        val label="Search: $search"
        val c=FakeController(Route.MEMBERS)
        c.seedQuery(c.listingQuery.copy(q=search))
        ui.setContent {
            BuriContent(reduceMotion=true) {
                Box(Modifier.fillMaxSize()) {
                    Column(Modifier.width(216.dp)) {
                        ListingToolbar(c,onExport={},showFilter=false,showExport=false)
                    }
                }
            }
        }
        assertTextLayout(label,ellipsized=true)
        button(label).performClick()
        ui.runOnIdle{check(c.lastAppliedQuery?.q=="")}
        ui.onNodeWithText(label).assertDoesNotExist()
    }

    @Test fun importedMemberNamesUseOneLineAndKeepReviewAccessible(){
        val name="Example cooperative member with a very long full name ".repeat(3).trimEnd()
        val c=FakeController(Route.MEMBERS)
        c.state=c.state.copy(sheet=Sheet.ENROLL,onboarding=SmartOnboardingState(
            step=SmartOnboardingStep.IMPORT,sourceKind="csv",
            rows=listOf(SmartImportRow(1,name,"+250780000001","ready"))
        ))
        show(c)
        panelList("Add member").performScrollToNode(hasText(name))
        assertTextLayout(name,ellipsized=true)
        ui.onNode(hasText(name) and hasText("Review") and hasClickAction()).assertIsDisplayed()
    }
    @Test fun exportFormatsDispatchOnlyAfterAnExplicitContextualChoice(){
        val c=FakeController(Route.PAYMENTS,Role.STAFF);c.seedStatementReview()
        val chosen=mutableListOf<Triple<ExportFormat,String?,List<String>>>()
        show(c,onExport={format->chosen+=Triple(format,c.state.routeId,checkNotNull(c.state.payments).items.map{it.id})})
        ui.onNodeWithContentDescription("Export results").performScrollTo().performClick()
        ui.onNodeWithTag("export-format-sheet").assertIsDisplayed();ui.onNodeWithTag("export-format:CSV").assertDoesNotExist()
        ui.onNodeWithTag("export-format:PDF").assertExists();ui.runOnIdle{check(chosen.isEmpty())}
        ui.onNodeWithTag("export-format:XLSX").performScrollTo().performClick()
        ui.runOnIdle{check(chosen.single().first==ExportFormat.XLSX && chosen.single().second==null)}
        visiblePayment("ST-A-IN").performClick()
        ui.onNodeWithContentDescription("Export results").assertDoesNotExist()
        headerAction("Download statement").performClick()
        ui.runOnIdle{check(chosen.size==1)}
        ui.onNodeWithTag("export-format:PDF").performScrollTo().performClick()
        ui.runOnIdle{check(chosen.last()==Triple(ExportFormat.PDF,"member-1",listOf("statement-a-in","statement-a-out","statement-a-earlier")))}

        val list=ui.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasTestTag("listing-sort-menu"))
        ui.onNodeWithTag("listing-sort-menu").assert(hasText("Newest first")).performClick()
        val choices=hasAnyAncestor(hasTestTag("listing-sort-choices"))
        ui.onNode(hasText("Newest first") and choices and hasClickAction()).assertIsSelected()
        ui.onNode(hasText("Amount · high to low") and choices and hasClickAction()).performClick()
        ui.onNodeWithTag("listing-sort-menu").assert(hasText("Amount · high to low"))
        val renderedIndex=list.fetchSemanticsNode().config[SemanticsProperties.IndexForKey]
        ui.runOnIdle{
            val indices=listOf("statement-a-out","statement-a-in","statement-a-earlier").map(renderedIndex)
            check(indices.first()>=0 && indices.zipWithNext().all{(first,second)->first<second})
            check(renderedIndex("statement-b-in")==-1 && renderedIndex("statement-unlinked")==-1)
        }
        visiblePayment("ST-A-OUT")
        ui.onNodeWithContentDescription("75,000 RWF").assertIsDisplayed()
        list.performScrollToNode(hasText("Filters") and hasClickAction())
        button("Filters").performScrollTo().performClick()
        ui.onNodeWithTag("payment-filter-select").assertDoesNotExist()
        panelList("Filters").performScrollToNode(hasTestTag("listing-direction-select"))
        ui.onNodeWithTag("listing-direction-select").performScrollTo().performClick()
        radioOption("Incoming").performClick()
        panelButton("Filters","Apply").performClick()
        ui.runOnIdle{
            check(c.listingQuery.direction=="incoming" && c.listingQuery.sort==ListingSort.AMOUNT_DESC)
            check(c.state.payments?.items?.map{it.ftId}==listOf("ST-A-IN","ST-A-EARLIER"))
        }
        list.performScrollToNode(hasContentDescription("Search transactions"))
        field("Search transactions").performTextReplacement("Marie")
        field("Search transactions").performImeAction()
        ui.runOnIdle{
            check(c.listingQuery.q=="Marie" && c.state.routeId=="member-1")
            check(c.state.payments?.items?.single()?.id=="statement-a-in")
        }
        visiblePayment("ST-A-IN")
        ui.onNodeWithText("FT Id: ST-B-IN").assertDoesNotExist()
        headerAction("Download statement").performClick()
        ui.onNodeWithTag("export-format:XLSX").performScrollTo().performClick()
        ui.runOnIdle{check(chosen.size==3 && chosen.last()==Triple(ExportFormat.XLSX,"member-1",listOf("statement-a-in")))}
    }
    @Test fun refreshAndExportFeedbackNeverReplaceValidRecordsWithFakeSuccess(){
        val c=FakeController(Route.PAYMENTS);c.state=c.state.copy(busy=true);c.operation=UiOperation.REFRESH;show(c)
        ui.onNodeWithTag("active-operation:REFRESH").assertExists()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("10,000 RWF"))
        ui.onNodeWithContentDescription("10,000 RWF").assertExists()
        ui.onNodeWithText("File saved").assertDoesNotExist()
        ui.runOnIdle{c.operation=UiOperation.EXPORT;c.exportFeedback=UiExportFeedback(UiExportPhase.PREPARING,ExportFormat.XLSX,completedRows=5,totalRows=10)}
        ui.onNodeWithText("5 of 10 rows").assertExists();ui.mainClock.advanceTimeBy(1500);ui.onNodeWithText("File saved").assertDoesNotExist()
        ui.runOnIdle{c.exportFeedback=c.exportFeedback!!.copy(phase=UiExportPhase.WRITING)}
        ui.onNodeWithText("Saving file").assertExists();ui.onNodeWithText("File saved").assertDoesNotExist()
        ui.runOnIdle{c.state=c.state.copy(busy=false);c.operation=UiOperation.NONE;c.exportFeedback=c.exportFeedback!!.copy(phase=UiExportPhase.COMPLETE)}
        ui.onNodeWithText("File saved").assertExists()
        ui.runOnIdle{c.openSheet(Sheet.AUDIT);c.state=c.state.copy(busy=true);c.operation=UiOperation.EXPORT;c.exportFeedback=UiExportFeedback(UiExportPhase.PREPARING,ExportFormat.PDF,canCancel=true)}
        panelButton("Activity log","Cancel export").assertIsDisplayed().performClick();ui.runOnIdle{check(c.cancelExportCalls==1)}
    }
    @Test fun initialLoadingSkeletonDoesNotClaimAnEmptyResult(){
        val c=FakeController(Route.PAYMENTS);c.state=c.state.copy(payments=null,busy=true);c.operation=UiOperation.INITIAL_READ;show(c)
        ui.onNodeWithTag("loading-skeleton").assertExists();ui.onNodeWithText("No payments").assertDoesNotExist()
        ui.runOnIdle{c.operation=UiOperation.NONE;c.state=c.state.copy(busy=false,payments=Page(emptyList(),null,0,"empty","now"))}
        ui.onNodeWithTag("loading-skeleton").assertDoesNotExist();ui.onNodeWithText("No payments").assertExists()
    }

    private fun indeterminateWork()=ui.onAllNodes(SemanticsMatcher.expectValue(
        androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo,
        androidx.compose.ui.semantics.ProgressBarRangeInfo.Indeterminate))

    @Test fun loadingUsesTheRequestedScreenAndRemovesPrivateGeometryOnAnAccessCheck(){
        val c=FakeController(Route.PAYMENTS)
        c.state=c.state.copy(home=null,payments=null,members=null,payment=null,member=null,messages=null,busy=true)
        c.operation=UiOperation.INITIAL_READ
        show(c)
        for(route in listOf(Route.PAYMENTS,Route.MEMBERS,Route.PAYMENT,Route.MEMBER,Route.SMS,Route.HOME)){
            ui.runOnIdle{c.state=c.state.copy(route=route)}
            if(route==Route.SMS && !BuildConfig.IS_GATEWAY){
                ui.onNodeWithTag("loading-skeleton").assertDoesNotExist()
                ui.onNodeWithText("Loading records").assertIsDisplayed()
            }else ui.onNodeWithTag("loading-layout:${route.name}").assertIsDisplayed()
            indeterminateWork().assertCountEquals(1)
            ui.onNodeWithContentDescription("10,000 RWF").assertDoesNotExist()
        }
        ui.runOnIdle{c.screenGate=ScreenGate.CHECKING}
        ui.onNodeWithTag("loading-skeleton").assertDoesNotExist()
        ui.onNodeWithText("Checking access").assertIsDisplayed()
        indeterminateWork().assertCountEquals(1)
    }

    @Test fun sheetCommandAndVisibleRefreshEachHaveOneProgressAnnouncement(){
        val c=FakeController(Route.PAYMENTS)
        c.state=c.state.copy(busy=true)
        c.operation=UiOperation.REFRESH
        show(c)
        ui.onNodeWithTag("active-operation:REFRESH").assertIsDisplayed()
        indeterminateWork().assertCountEquals(1)
        ui.onNodeWithTag("loading-skeleton").assertDoesNotExist()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("10,000 RWF"))
        ui.onNodeWithContentDescription("10,000 RWF").assertIsDisplayed()
        ui.runOnIdle{c.openSheet(Sheet.PIN);c.operation=UiOperation.COMMAND}
        ui.onNodeWithTag("active-operation:COMMAND").assertIsDisplayed()
        panelButton("Change passcode","Save").assertIsNotEnabled()
        indeterminateWork().assertCountEquals(1)
    }

    @Test fun reducedMotionKeepsLoadingMeaningWithStaticRendering(){
        val c=FakeController(Route.PAYMENTS);c.state=c.state.copy(payments=null,busy=true);c.operation=UiOperation.INITIAL_READ;show(c)
        ui.onAllNodes(SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.ProgressBarRangeInfo,androidx.compose.ui.semantics.ProgressBarRangeInfo.Indeterminate)).onFirst().assertExists()
        val before=ui.onRoot().captureToImage().asAndroidBitmap();ui.mainClock.advanceTimeBy(2000);ui.waitForIdle()
        check(before.sameAs(ui.onRoot().captureToImage().asAndroidBitmap()))
    }

    @Test fun defaultMotionPulsesThePaymentSkeletonAndDisposesItWhenRecordsArrive(){
        val c=FakeController(Route.PAYMENTS)
        val payments=checkNotNull(c.state.payments)
        c.state=c.state.copy(payments=null,busy=true)
        c.operation=UiOperation.INITIAL_READ
        var enabled=false
        var searchBarCentreY=0
        ui.mainClock.autoAdvance=false
        try {
            ui.setContent {
                BuriContent() {
                    val motion=LocalBuriMotionAllowed.current
                    val centre=with(LocalDensity.current){24.dp.roundToPx()}
                    androidx.compose.runtime.SideEffect{enabled=motion;searchBarCentreY=centre}
                    BuriApp(c,{},{},{},{})
                }
            }
            ui.mainClock.advanceTimeBy(96)
            ui.runOnIdle{check(enabled){"This test requires the default motion preference and a positive Android animator duration scale."}}
            val skeleton=ui.onNodeWithTag("loading-layout:PAYMENTS").assertIsDisplayed()
            val first=skeleton.captureToImage().asAndroidBitmap()
            ui.mainClock.advanceTimeBy(560)
            val second=skeleton.captureToImage().asAndroidBitmap()
            check(first.width==second.width && first.height==second.height && searchBarCentreY in 0 until first.height)
            val x=first.width/2
            check(first.getPixel(x,searchBarCentreY)!=second.getPixel(x,searchBarCentreY)){"The search placeholder did not pulse between frames."}
            indeterminateWork().assertCountEquals(1)
            ui.runOnIdle{c.operation=UiOperation.NONE;c.state=c.state.copy(payments=payments,busy=false)}
            ui.mainClock.advanceTimeByFrame()
            ui.onNodeWithTag("loading-skeleton").assertDoesNotExist()
            indeterminateWork().assertCountEquals(0)
        } finally {
            ui.mainClock.autoAdvance=true
        }
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasContentDescription("10,000 RWF"))
        ui.onNodeWithContentDescription("10,000 RWF").assertIsDisplayed()
    }
    @Test fun typedFiltersValidateAmountsAndPreserveInclusiveKigaliDates(){
        val c=FakeController(Route.PAYMENTS)
        c.seedQuery(ListingQuery(fromAt="2026-11-13T22:00:00Z",untilAt="2026-11-14T22:00:00Z",minRwf=0,maxRwf=100))
        c.openSheet(Sheet.FILTERS);show(c)
        panelList("Filters").performScrollToNode(hasContentDescription("Minimum RWF"))
        field("Minimum RWF").performTextClearance();field("Minimum RWF").performTextInput("-1")
        button("Apply").performClick();panelList("Filters").performScrollToNode(hasText("Check the date and amount range."));ui.onNodeWithText("Check the date and amount range.").assertExists();ui.runOnIdle{check(c.filterCalls==0)}
        panelList("Filters").performScrollToNode(hasContentDescription("Minimum RWF"))
        field("Minimum RWF").performTextClearance();field("Minimum RWF").performTextInput("0");button("Apply").performClick()
        ui.runOnIdle{check(c.filterCalls==1&&c.lastAppliedQuery?.fromAt=="2026-11-13T22:00:00Z"&&c.lastAppliedQuery?.untilAt=="2026-11-14T22:00:00Z"&&c.lastAppliedQuery?.minRwf==0L&&c.lastAppliedQuery?.maxRwf==100L&&c.state.sheet==null)}
    }
    @Test fun typedFilterOverlayReturnsToItsStaffPanelAndRetainsTheSelection(){
        val c=FakeController(Route.SETTINGS);c.openSheet(Sheet.STAFF);show(c)
        ui.onNodeWithTag("listing-tools:STAFF").assertExists()
        ui.onNodeWithTag("listing-sort-menu").performClick();ui.onNodeWithText("Newest first").performClick()
        ui.runOnIdle{check(c.state.sheet==Sheet.STAFF&&c.lastAppliedQuery?.sort==ListingSort.NEWEST)}
        button("Filters").performClick();ui.onNodeWithTag("listing-active-select").performClick();ui.onNodeWithText("Inactive").performClick()
        ui.onNodeWithTag("listing-active-select").assert(hasText("Inactive"));button("Apply").performClick()
        ui.runOnIdle{check(c.state.sheet==Sheet.STAFF&&c.lastAppliedQuery?.active=="inactive")}
    }
    @Test fun smsDownloadsStayMetadataOnlyAndRequireClearingBodySearch(){
        val c=FakeController(if(BuildConfig.IS_GATEWAY)Route.SMS else Route.SETTINGS);c.smsAccessGranted=true;show(c)
        if(!BuildConfig.IS_GATEWAY){ui.onNodeWithContentDescription("Export results").assertDoesNotExist();return}
        ui.onNodeWithContentDescription("Export results").performScrollTo().performClick()
        ui.onNodeWithText("SMS exports contain authorized metadata only. Message content is excluded.").assertExists()
        ui.onNodeWithTag("export-format:CSV").assertDoesNotExist();ui.onNodeWithContentDescription("Close").performClick()
        ui.runOnIdle{c.state=c.state.copy(smsListSearch="private search")}
        ui.onNodeWithContentDescription("Export results").assertDoesNotExist()
        ui.onNodeWithText("Clear SMS search to download source metadata. Message text is not included.").assertExists()
        ui.runOnIdle{c.state=c.state.copy(smsListSearch="");c.openSheet(Sheet.FILTERS)}
        ui.onNodeWithContentDescription("Search source or state").assertDoesNotExist();ui.onNodeWithTag("listing-sort-select").assertExists()
    }
    @Test fun paginationFailureRequiresExplicitRetryInsteadOfAnAutomaticLoop(){
        val c=FakeController(Route.PAYMENTS);c.state=c.state.copy(payments=c.state.payments!!.copy(nextCursor="next",totalCount=2),error="Read failed")
        show(c);ui.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Retry loading") and hasClickAction())
        ui.onNodeWithText("Retry loading").assertExists();ui.mainClock.advanceTimeBy(700);ui.runOnIdle{check(c.moreCalls==0)}
        ui.onNodeWithText("Retry loading").performClick();ui.mainClock.advanceTimeBy(700);ui.runOnIdle{check(c.moreCalls==1)}
    }
}
private class FakeController(route:Route,role:Role=Role.ADMIN):BuriController{
    private val snapshotAt=System.currentTimeMillis()
    val operator=Operator("operator-1","EXAMPLE STAFF","+250780000002",role,if(role==Role.ADMIN)Capability.values().map{it.key}.toSet()else setOf("records.read","members.enroll","payments.allocate"),Long.MAX_VALUE)
    val receiptBody="Synthetic M-Money receipt · no live SMS data"
    private val person=Member("member-1","EXAMPLE PERSON WITH A VERY LONG FULL NAME","+250780000001",true,1)
    private val pay=Payment("tx-1",person.name,"*********816",10000,"2026-10-08 15:15:20","90000000001","allocated",1,person.id,person.phone,"sms-1")
    private var reviewPayments:List<Payment>?=null
    private var reviewMembers=emptyList<Member>()
    private var payerRead:ReviewPayerRead?=null
    private val enrolledAfterSnapshot=mutableListOf<Member>()
    private val reviewHistory=mutableListOf<Pair<UiState,ListingQuery>>()

    fun seedStatementReview()=seedStatementRows(includeUnlinked=true)
    fun seedLinkedStatementReview()=seedStatementRows(includeUnlinked=false)

    private fun seedStatementRows(includeUnlinked:Boolean){
        val primary=person.copy(name="Aline Nkurunziza")
        val other=Member("member-2","Eric Nshimiyimana","+250780000002",false,1)
        val rows=listOf(
            pay.copy(id="statement-a-in",payerNameRaw="Marie Uwase",amountRwf=25_000,atRaw="2026-11-25T10:30:00Z",ftId="ST-A-IN",memberId=primary.id,memberPhone=primary.phone),
            pay.copy(id="statement-b-in",payerNameRaw="Marie Uwase",amountRwf=32_500,atRaw="2026-11-24T08:45:00Z",ftId="ST-B-IN",memberId=other.id,memberPhone=other.phone),
            pay.copy(id="statement-unlinked",payerNameRaw="Unmatched transfer",amountRwf=7_500,atRaw="2026-11-23T12:20:00Z",ftId="ST-UNLINKED",state="unallocated",memberId=null,memberPhone=null),
            pay.copy(id="statement-a-out",payerNameRaw="Market Cooperative",amountRwf=75_000,atRaw="2026-11-22T15:45:00Z",ftId="ST-A-OUT",memberId=primary.id,memberPhone=primary.phone,direction="outgoing",feeRwf=250),
            pay.copy(id="statement-a-earlier",payerNameRaw="Family transfer",amountRwf=18_000,atRaw="2026-11-15T09:15:00Z",ftId="ST-A-EARLIER",memberId=primary.id,memberPhone=primary.phone)
        ).filter{includeUnlinked || PaymentPresentation.linkedMemberId(it)!=null}
        reviewPayments=rows
        reviewMembers=listOf(primary,other)
        payerRead=if(includeUnlinked)null else ReviewPayerRead(rows)
        enrolledAfterSnapshot.clear()
        reviewHistory.clear()
        state=state.copy(home=state.home?.copy(paymentCount=rows.size,memberCount=reviewMembers.size,
            unallocatedCount=rows.count{it.state=="unallocated"},recent=rows.take(3)),
            payments=Page(rows,null,rows.size,"statement-review","2026-11-25T10:30:00Z"),
            members=Page(reviewMembers,null,reviewMembers.size,"statement-review","2026-11-25T10:30:00Z"),
            member=primary,payment=rows.first())
    }

    fun statementReviewPayments(memberId:String):List<Payment> =
        reviewPayments.orEmpty().filter{it.memberId==memberId}

    private fun updateReviewListing(){
        val rows=reviewPayments?:return
        val query=listingQuery
        if(state.route==Route.MEMBERS){
            val matches=reviewMembers.filter{m->
                (query.active=="all" || m.active==(query.active=="active")) &&
                    (m.name.contains(query.q.trim(),true) || m.phone.contains(query.q.trim()))
            }
            val sorted=when(query.sort){
                ListingSort.NAME_ASC->matches.sortedBy{it.name}
                ListingSort.NAME_DESC->matches.sortedByDescending{it.name}
                ListingSort.PHONE_ASC->matches.sortedBy{it.phone}
                ListingSort.PHONE_DESC->matches.sortedByDescending{it.phone}
                ListingSort.OLDEST->matches.reversed()
                else->matches
            }
            state=state.copy(members=Page(sorted,null,sorted.size,"statement-review","2026-11-25T10:30:00Z"))
            return
        }
        if(state.route!=Route.PAYMENTS)return
        val scoped=state.routeId?.let(::statementReviewPayments)?:rows
        val start=query.fromAt?.let(java.time.Instant::parse)
        val end=query.untilAt?.let(java.time.Instant::parse)
        val minimum=query.minRwf;val maximum=query.maxRwf
        val matches=scoped.filter{p->
            val at=java.time.Instant.parse(p.atRaw)
            val amount=p.amountRwf
            (query.filter=="all" || p.state==query.filter) && (query.direction=="all" || p.direction==query.direction) &&
                (start==null || at>=start) && (end==null || at<end) &&
                (minimum==null || amount!=null && amount>=minimum) && (maximum==null || amount!=null && amount<=maximum) &&
                listOfNotNull(p.payerNameRaw,p.payerPhoneRaw,p.memberPhone,p.ftId,p.paymentReference).any{it.contains(query.q.trim(),ignoreCase=true)}
        }
        val sorted=when(query.sort){
            ListingSort.OLDEST->matches.sortedBy{it.atRaw}
            ListingSort.AMOUNT_ASC->matches.sortedBy{it.amountRwf}
            ListingSort.AMOUNT_DESC->matches.sortedByDescending{it.amountRwf}
            else->matches.sortedByDescending{it.atRaw}
        }
        state=state.copy(payments=Page(sorted,null,sorted.size,"statement-review","2026-11-25T10:30:00Z"))
    }
    override var screenGate by mutableStateOf(ScreenGate.OPEN)
    override var notificationAccessGranted:Boolean? by mutableStateOf(null)
    override var continuousSyncRunning:Boolean? by mutableStateOf(true)
    override var continuousSyncProblem:String? by mutableStateOf(null)
    var permissionsRequired by mutableStateOf(false)
    override val receivingPermissionsRequired get()=permissionsRequired
    override var smsAccessGranted by mutableStateOf(false)
    override var operation by mutableStateOf(UiOperation.NONE)
    override var operationLabel:String? by mutableStateOf(null)
    var navigationOpenWhileBusy by mutableStateOf(false)
    override val navigationBlocked get()=(state.busy&&!navigationOpenWhileBusy)||screenGate!=ScreenGate.OPEN
    override var requestedRoute:Route? by mutableStateOf(null)
    var simulateQueuedNavigation=false
    var simulatePendingSignIn=false
    override var exportFeedback:UiExportFeedback? by mutableStateOf(null)
    var cancelExportCalls=0
    override fun cancelExport(){cancelExportCalls++}
    private var filterOrigin:ListingTarget?=null
    private var filterParent:Sheet?=null
    private val queries=androidx.compose.runtime.mutableStateMapOf<ListingTarget,ListingQuery>()
    var lastAppliedQuery:ListingQuery?=null
    fun seedQuery(query:ListingQuery,target:ListingTarget=listingTarget?:ListingTarget.PAYMENTS){queries[target]=query.validated(target)}
    override val listingTarget:ListingTarget? get()=if(state.sheet==Sheet.FILTERS)filterOrigin else when(state.sheet){
        Sheet.STAFF->ListingTarget.STAFF;Sheet.AUDIT->ListingTarget.AUDIT
        null->when(state.route){Route.PAYMENTS->ListingTarget.PAYMENTS;Route.MEMBERS->ListingTarget.MEMBERS;Route.SMS->if(state.filter=="queued")ListingTarget.OBSERVATIONS else ListingTarget.SMS;else->null}
        else->null
    }
    override val listingQuery get()=listingTarget?.let{queries[it]?:ListingQuery.defaultsFor(it)}?:ListingQuery()
    override val canExportListing get()=listingTarget!=null&&allows(Capability.READ)&&!state.offline&&when(listingTarget){
        ListingTarget.SMS,ListingTarget.OBSERVATIONS->allows(Capability.SMS)&&smsAccessGranted&&state.smsListSearch.isBlank()&&state.queuedSearch.isBlank()
        ListingTarget.STAFF,ListingTarget.AUDIT->allows(Capability.STAFF)
        else->true
    }
    override fun applyListingQuery(query:ListingQuery){
        val target=listingTarget?:return;query.validated(target);lastAppliedQuery=query;queries[target]=query;filterCalls++
        state=state.copy(sheet=if(state.sheet==Sheet.FILTERS)filterParent else state.sheet,
            filter=if(target in setOf(ListingTarget.PAYMENTS,ListingTarget.SMS))query.filter else state.filter,
            search=if(state.route!=Route.SMS)query.q else state.search)
        filterOrigin=null;filterParent=null
        updateReviewListing()
    }
    override fun resetListingQuery(){val target=listingTarget?:return;queries[target]=ListingQuery.defaultsFor(target);state=state.copy(search="",filter=if(target in setOf(ListingTarget.PAYMENTS,ListingTarget.SMS))"all"else state.filter);if(state.sheet!=Sheet.FILTERS)updateReviewListing()}
    override fun dismissExportFeedback(){exportFeedback=null}
    var retirementUnconfirmed=false;var retirementChecks=0
    var loginCalls=0;var lastPhone="";var lastPin="";var searchCalls=0;var filterCalls=0;var pinChangeCalls=0;var rawCalls=0;var pairCalls=0;var replaceCalls=0;var syncCalls=0;var lastPairCode="";var lastNavigationId:String?=null
    var staffSaveCalls=0;var lastStaffPhone="";var lastStaffPin="";var moreCalls=0;var moreObservationCalls=0;var observationRetryCalls=0
    var deniedSheetRequests=0;var lastSheetRequest:Sheet?=null
    override var state by mutableStateOf(UiState(operator=if(route==Route.LOGIN)null else operator,route=route,savedAt=snapshotAt,panelSavedAt=snapshotAt,
        home=Home(1,1,0,listOf(pay),"2026-11-06T10:00:00Z"),payments=Page(listOf(pay),null,1,"v1","now"),members=Page(listOf(person),null,1,"v1","now"),member=person,payment=pay,
        gateway=if(role==Role.ADMIN)GatewayStatus(true,true,1,0,null,"09:42","09:42",null)else null,messages=Page(listOf(SmsRow("sms-1","M-Money",pay.atRaw,"Synthetic preview","synced","tx-1","SIM 1")),null,1,"v1","now"),staff=Page(emptyList(),null,0,"staff-v1","now"),audit=Page(emptyList(),null,0,"audit-v1","now")))
    override fun allows(capability:Capability)=screenGate==ScreenGate.OPEN&&Access.allows(state.operator,capability,System.currentTimeMillis(),BuildConfig.IS_GATEWAY)
    override fun login(phone:String,pin:String){loginCalls++;lastPhone=phone;lastPin=pin;if(simulatePendingSignIn){operation=UiOperation.SIGN_IN;state=state.copy(busy=true)}}
    override fun logout(){state=UiState()}
    override fun navigate(route:Route,id:String?){
        lastNavigationId=id
        if(simulateQueuedNavigation){requestedRoute=route;return}
        val rows=reviewPayments
        if(rows==null){state=state.copy(route=route,routeId=id,sheet=null);return}
        if(route==state.route && id==state.routeId && state.sheet==null)return
        reviewHistory+=state to listingQuery
        if(route==Route.PAYMENTS)queries[ListingTarget.PAYMENTS]=ListingQuery.defaultsFor(ListingTarget.PAYMENTS)
        if(route==Route.MEMBERS)queries[ListingTarget.MEMBERS]=ListingQuery.defaultsFor(ListingTarget.MEMBERS)
        val member=if(route==Route.MEMBER || route==Route.PAYMENTS)reviewMembers.singleOrNull{it.id==id} else state.member
        state=state.copy(route=route,routeId=id,sheet=null,search="",filter="all",listIndex=0,listOffset=0,member=member,
            payment=if(route==Route.PAYMENT)rows.singleOrNull{it.id==id} else state.payment)
        updateReviewListing()
    }
    override fun back(){
        if(reviewPayments!=null){
            if(state.sheet!=null){closeSheet();return}
            reviewHistory.removeLastOrNull()?.let{(previous,query)->
                if(previous.route==Route.PAYMENTS)queries[ListingTarget.PAYMENTS]=query
                if(previous.route==Route.MEMBERS)queries[ListingTarget.MEMBERS]=query
                state=previous
                return
            }
        }
        state=state.copy(route=Route.HOME,sheet=null)
    }
    override fun openUnallocated(){
        if(reviewPayments==null)state=state.copy(route=Route.PAYMENTS,filter="unallocated")
        else{navigate(Route.PAYMENTS,null);setFilter("unallocated")}
    }
    override fun search(value:String){state=if(state.route==Route.SMS&&state.filter=="queued")state.copy(queuedSearch=value)else if(state.route==Route.SMS)state.copy(smsListSearch=value)else state.copy(search=value)}
    override fun searchSubmit(){
        searchCalls++
        if(reviewPayments!=null && state.route in setOf(Route.PAYMENTS,Route.MEMBERS)){
            val target=listingTarget?:return
            queries[target]=listingQuery.copy(q=state.search)
            updateReviewListing()
        }
    }
    override fun setFilter(value:String){filterCalls++;state=state.copy(filter=value,sheet=null);listingTarget?.let{target->if(value in ListingQuery.filters(target))queries[target]=listingQuery.copy(filter=value)};updateReviewListing()}
    override fun refresh(){}
    override fun more(){moreCalls++}
    override fun moreObservations(){moreObservationCalls++}
    override fun retryObservation(){
        val source=state.rawSource as? SmsSourceRef.Observation?:return
        if(state.sheet!=Sheet.RAW||!smsAccessGranted||!allows(Capability.SMS)||!allows(Capability.GATEWAY)||state.observationProcessing[source]?.canRetry!=true)return
        observationRetryCalls++
        state=state.copy(observationProcessing=state.observationProcessing+(source to ObservationProcessing("retrying",false)),observationRetryNotice="Retry scheduled.")
    }
    override fun openSms(source:SmsSourceRef){
        if(source is SmsSourceRef.Observation&&allows(Capability.SMS))state=state.copy(sheet=Sheet.RAW,sheetId=source.id,rawSource=source,
            raw=RawSms(source.id,"M-Money","2026-11-09T00:00:00Z",receiptBody,null),
            observationHints=ObservationHintSet(1,"partial_inbox_display_only","synthetic-profile","a".repeat(64),Values.sha256(receiptBody),
                listOf(ObservationHint("quoted_reference","Synthetic",0,9))),rawDisclosure=RawDisclosureState.REVEALED)
        else openSheet(Sheet.RAW,source.id)
    }
    override fun openSheet(sheet:Sheet,id:String?){
        lastSheetRequest=sheet
        // Model the real controller boundary; direct fixture calls must not bypass role/profile checks.
        val permitted=when(sheet){
            Sheet.GATEWAY,Sheet.REPLACE_DEVICE->BuildConfig.IS_GATEWAY&&state.operator?.role==Role.ADMIN
            Sheet.RAW->allows(Capability.SMS)
            Sheet.STAFF,Sheet.STAFF_EDIT,Sheet.REMOVE_STAFF,Sheet.AUDIT->allows(Capability.STAFF)
            Sheet.ENROLL->allows(Capability.ENROLL)
            Sheet.ALLOCATE->allows(Capability.ALLOCATE)
            else->state.operator!=null
        }
        if(!permitted){deniedSheetRequests++;return}
        if(sheet==Sheet.FILTERS){filterOrigin=listingTarget?:ListingTarget.PAYMENTS;filterParent=state.sheet}
        state=state.copy(sheet=sheet,sheetId=id,draft=emptyMap(),draftDirty=false,
            onboarding=if(sheet==Sheet.ENROLL)SmartOnboardingState() else state.onboarding)
        if(sheet==Sheet.RAW){rawCalls++;state=state.copy(raw=RawSms("sms-1","M-Money",pay.atRaw,receiptBody,"tx-1","SIM 1"),rawDisclosure=RawDisclosureState.REVEALED)}
    }
    override fun closeSheet(){val parent=if(state.sheet==Sheet.FILTERS)filterParent else null;state=state.copy(sheet=parent,sheetId=null,draft=emptyMap());filterOrigin=null;filterParent=null}
    override fun keepDraft(){state=state.copy(discardRequested=false)}
    override fun discardDraft(){state=state.copy(sheet=null,sheetId=null,discardRequested=false,draftDirty=false,draft=emptyMap())}
    override fun revealRaw(reason:String){rawCalls++}
    override fun editDraft(key:String,value:String){
        val onboarding=if(state.sheet==Sheet.ENROLL)
            SmartOnboardingPresentation.identityEdited(state.onboarding,key,state.draft[key],value) else state.onboarding
        state=state.copy(draft=state.draft+(key to value),draftDirty=true,onboarding=onboarding)
    }
    override fun selectMember(member:Member){state=state.copy(selectedMember=member)}
    override fun allocationSearch(q:String){}
    var allocateCalls=0
    override fun allocate(){allocateCalls++}
    override fun enroll(name:String,phone:String){}
    private fun mayEnroll()=state.sheet==Sheet.ENROLL&&!state.busy&&!state.offline&&!state.pending&&allows(Capability.ENROLL)
    override fun onboardingOptions(){state=state.copy(onboarding=SmartOnboardingState(),draft=emptyMap(),draftDirty=false)}
    override fun onboardingManual(){state=state.copy(onboarding=SmartOnboardingState(step=SmartOnboardingStep.MEMBER),draft=emptyMap(),draftDirty=false)}
    override fun onboardingSearchQuery(value:String){
        if(state.onboarding.step==SmartOnboardingStep.SUGGESTIONS)onboardingSuggestions(value)
    }
    override fun onboardingSuggestions(query:String,cursor:String?){
        if(!mayEnroll()||query.length>80||cursor!=null)return
        val items=payerRead?.candidates(reviewMembers+enrolledAfterSnapshot,query).orEmpty()
        state=state.copy(onboarding=SmartOnboardingState(step=SmartOnboardingStep.SUGGESTIONS,query=query,
            suggestions=items,suggestionsLoaded=true),draft=emptyMap(),draftDirty=false,error=null)
    }
    override fun onboardingChoose(candidateId:String){
        if(!mayEnroll()||state.onboarding.step!=SmartOnboardingStep.SUGGESTIONS)return
        val candidate=state.onboarding.suggestions.singleOrNull{it.candidateId==candidateId}?:return
        state=state.copy(onboarding=state.onboarding.copy(step=SmartOnboardingStep.MEMBER,candidate=candidate,
            verifiedOwnership=false,acceptedTerms=false,consentRecorded=false),
            draft=mapOf("name" to candidate.momoName),draftDirty=false,error=null)
    }
    override fun onboardingConsent(field:String,value:Boolean,displayedDraft:Map<String,String>?){
        if(mayEnroll())state=state.copy(onboarding=SmartOnboardingPresentation.consent(state.onboarding,state.draft,displayedDraft,field,value))
    }
    override fun onboardingSubmit(name:String,phone:String){
        if(!mayEnroll())return
        val row=try{SmartOnboardingPresentation.confirmedMember(state.onboarding,state.draft,name,phone)}catch(_:ContractFailure){return}
        val number=row.phone?:return
        val candidateId=row.candidateId
        val members=reviewMembers+enrolledAfterSnapshot
        val existing=members.singleOrNull{it.phone==number}
        val result=when{
            candidateId!=null&&payerRead?.accepts(candidateId,number,members)!=true->
                SmartImportResult(row.row,"candidate_changed",null)
            existing!=null->SmartImportResult(row.row,"already_registered",existing.id)
            else->{
                val member=Member("review-member-${enrolledAfterSnapshot.size+1}",row.name,number,true,1)
                enrolledAfterSnapshot+=member
                SmartImportResult(row.row,"created",member.id)
            }
        }
        state=state.copy(onboarding=SmartOnboardingState(step=SmartOnboardingStep.RESULTS,results=listOf(result),
            created=if(result.status=="created")1 else 0),draft=emptyMap(),draftDirty=false,error=null)
    }
    override fun onboardingImport(){state=state.copy(onboarding=state.onboarding.copy(step=SmartOnboardingStep.IMPORT))}
    override fun onboardingPhoto(){state=state.copy(onboarding=SmartOnboardingState(step=SmartOnboardingStep.IMPORT,photoCaptureFlow=true))}
    override fun onboardingDocumentConsent(requestId:String,value:Boolean){if(state.onboarding.documentRequestId==requestId)state=state.copy(onboarding=state.onboarding.copy(ocrConsent=value))}
    override fun changePin(current:String,next:String,confirm:String){pinChangeCalls++}
    override fun saveStaff(name:String,phone:String,pin:String,enroll:Boolean,allocate:Boolean){staffSaveCalls++;lastStaffPhone=phone;lastStaffPin=pin}
    override fun staffAction(action:String,pin:String?){}
    override fun requestRemoveStaff(){openSheet(Sheet.REMOVE_STAFF)}
    override fun setMemberActive(active:Boolean){}
    override fun pair(code:String){pairCalls++;lastPairCode=code;state=state.copy(gateway=state.gateway!!.copy(authorized=true),sheet=Sheet.GATEWAY)}
    override fun replaceReceiver(code:String){
        if(state.receiverRetirementPending)retirementChecks++ else{replaceCalls++;lastPairCode=code}
        if(retirementUnconfirmed){screenGate=ScreenGate.CHECKING;state=state.copy(receiverRetirementPending=true)}
        else{screenGate=ScreenGate.OPEN;state=UiState()}
    }
    override fun syncReceiver(){syncCalls++}
    override fun setPaused(value:Boolean){state=state.copy(gateway=state.gateway!!.copy(captureEnabled=!value))}
    override fun retry(){}
}

/** Synthetic payments read on 26 Nov. The statement and Home remain the supplied 25 Nov snapshot. */
private class ReviewPayerRead(linkedSnapshot:List<Payment>){
    private data class Receipt(val collection:String,val admittedAt:String,val payment:Payment)
    private data class Payer(val item:SmartCandidate,val knownNumber:String?)
    private val collection="offline-review"
    private val listingAsOf="2026-11-25T10:30:00Z"
    private val suggestionAsOf="2026-11-26T09:00:00Z"

    private fun receipt(serial:Int,name:String,identifier:String,at:String,amount:Long,group:String=collection):Receipt{
        val id="00000000-0000-4000-8000-"+serial.toString().padStart(12,'0')
        return Receipt(group,"2026-11-26T08:00:00Z",Payment(id,name,identifier,amount,at,"QA-$serial","unallocated",1,
            sourceId="review-sms-$serial",direction="incoming",outcome="successful"))
    }

    private val receipts=linkedSnapshot.map{Receipt(collection,listingAsOf,it)}+listOf(
        receipt(101,"Chantal Mukamana","+250780000418","2026-11-10T07:10:00Z",8_500),
        receipt(102,"Chantal Mukamana","*******418","2026-11-12T11:20:00Z",12_000),
        receipt(103,"Élodie Uwase","*******763","2026-11-09T18:30:00Z",6_500),
        receipt(104,"Solange Mugisha","*******629","2026-11-11T08:46:00Z",5_000,group="other-review-collection"),
        receipt(105,"Aline Nkurunziza","*******001","2026-11-08T09:00:00Z",3_000)
    )

    private fun fold(value:String)=java.text.Normalizer.normalize(value,java.text.Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"),"").lowercase(Locale.ROOT)

    private fun payers(members:List<Member>):List<Payer>{
        val eligible=receipts.filter{it.collection==collection&&it.admittedAt<=suggestionAsOf}.map{it.payment}.filter{
            it.direction=="incoming"&&it.outcome=="successful"&&it.state=="unallocated"&&it.memberId==null&&
                it.sourceId!=null&&it.payerPhoneRaw.takeLast(3).matches(Regex("[0-9]{3}"))
        }
        return eligible.groupBy{it.payerNameRaw.trim().lowercase(Locale.ROOT) to it.payerPhoneRaw.takeLast(3)}
            .mapNotNull{(identity,records)->
                val (nameKey,last3)=identity
                val numbers=records.mapNotNull{runCatching{Values.phone(it.payerPhoneRaw)}.getOrNull()}.toSet()
                val known=numbers.singleOrNull()
                if(numbers.size>1||members.any{it.phone==known||
                    it.name.trim().lowercase(Locale.ROOT)==nameKey&&it.phone.endsWith(last3)})return@mapNotNull null
                val latest=records.maxWith(compareBy<Payment>{it.atRaw}.thenBy{it.id})
                Payer(SmartCandidate(latest.id,latest.payerNameRaw,last3,latest.atRaw,records.size),known)
            }
    }

    fun candidates(members:List<Member>,query:String):List<SmartCandidate>{
        val q=fold(query.trim())
        return payers(members).map{it.item}.filter{q.isEmpty()||fold(it.momoName).contains(q)||it.last3==q}
            .sortedWith(compareBy<SmartCandidate>{fold(it.momoName)}.thenBy{it.candidateId})
    }

    fun accepts(id:String,number:String,members:List<Member>):Boolean{
        val selected=payers(members).singleOrNull{it.item.candidateId==id}?:return false
        return number.endsWith(selected.item.last3)&&(selected.knownNumber==null||selected.knownNumber==number)
    }
}
