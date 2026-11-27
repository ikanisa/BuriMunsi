package rw.ikanisa.burimunsi

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cool.mobile.BuildConfig
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.ui.*

@RunWith(AndroidJUnit4::class)
class OperationUiContractTest {
    @get:Rule val ui = createComposeRule()

    private fun show(controller: FakeController) {
        ui.setContent {
            BuriContent(reduceMotion = true) {
                BuriApp(controller, onSupport = {}, onPermissions = {}, onExport = {}, onPhoneSettings = {})
            }
        }
    }

    @Test fun changingBeneficiarySearchDisablesThePreviousSelection() {
        val controller = FakeController(Route.PAYMENT, Role.STAFF)
        val payment = controller.state.payment!!.copy(state = "unallocated", memberId = null, memberPhone = null)
        val first = controller.state.members!!.items.first()
        val second = first.copy(id = "member-two", name = "Another person", phone = "+250780000002")
        controller.state = controller.state.copy(payment = payment, routeId = payment.id, sheet = Sheet.ALLOCATE)
        ui.setContent { BuriContent(reduceMotion = true) { AllocatePanel(controller.state, controller) } }

        val allocate = ui.onNode(hasText("Allocate") and hasClickAction())
        ui.onNode(hasText(first.phone) and hasClickAction()).performScrollTo().performClick()
        allocate.assertIsEnabled()
        ui.onNodeWithContentDescription("Find member").performScrollTo().performTextInput("Another")
        allocate.assertIsNotEnabled()
        ui.onNodeWithText(first.phone).assertDoesNotExist()
        ui.runOnIdle {
            check(controller.allocateCalls == 0)
            controller.state = controller.state.copy(allocationQuery = "Another",
                members = controller.state.members!!.copy(items = listOf(second)))
        }
        allocate.assertIsNotEnabled()
        ui.onNode(hasText(second.phone) and hasClickAction()).performScrollTo().performClick()
        allocate.assertIsEnabled().performClick()
        ui.runOnIdle { check(controller.allocateCalls == 1 && controller.state.selectedMember?.id == second.id) }
    }

    @Test fun staffEditImeReachesFieldsOutsideTheVisibleViewport() {
        val controller = FakeController(Route.SETTINGS)
        val staff = StaffAccount("staff-1", "Sample Staff", "+250780000002", true, 1, setOf(Capability.READ.key))
        controller.state = controller.state.copy(sheet = Sheet.STAFF_EDIT, sheetId = staff.id, selectedStaff = staff)
        ui.setContent {
            BuriContent(reduceMotion = true) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 1.6f)) {
                    Box(Modifier.fillMaxSize()) {
                        Box(Modifier.size(width = 300.dp, height = 260.dp)) { StaffPanel(controller.state, controller) }
                    }
                }
            }
        }
        val name = ui.onNodeWithContentDescription("Name")
        val phone = ui.onNodeWithContentDescription("Phone number")
        val pin = ui.onNodeWithContentDescription("New passcode")
        name.performScrollTo().performClick().performImeAction()
        phone.assertIsFocused().performImeAction()
        pin.assertIsFocused().performTextInput("2684")
        pin.performImeAction()
        ui.runOnIdle { check(controller.staffSaveCalls == 0) }
        ui.onNode(hasText("Save changes") and hasClickAction()).assertIsDisplayed().performClick()
        ui.runOnIdle { check(controller.staffSaveCalls == 1 && controller.lastStaffPin == "2684") }
    }

    @Test fun shortDiscardPromptKeepsBothChoicesReachable() {
        val controller = FakeController(Route.PAYMENT)
        controller.state = controller.state.copy(sheet = Sheet.ALLOCATE, pending = true,
            discardRequested = true, draftDirty = true, draft = mapOf("query" to "Member"))
        ui.setContent {
            BuriContent(reduceMotion = true) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    Box(Modifier.fillMaxSize()) {
                        Box(Modifier.size(width = 280.dp, height = 168.dp)) {
                            if (controller.state.discardRequested) DiscardPrompt(controller.state, controller)
                        }
                    }
                }
            }
        }
        ui.onNode(hasText("Keep editing") and hasClickAction()).performScrollTo().assertIsDisplayed().performClick()
        ui.runOnIdle {
            check(!controller.state.discardRequested && controller.state.draft["query"] == "Member")
            controller.state = controller.state.copy(discardRequested = true)
        }
        ui.onNode(hasText("Discard changes") and hasClickAction()).performScrollTo().assertIsDisplayed().performClick()
        ui.runOnIdle { check(controller.state.sheet == null && controller.state.pending) }
    }

    @Test fun originalSmsRetryRequiresAnExplicitActionAndCurrentAccess() {
        val controller = FakeController(Route.PAYMENT)
        val source = SmsSourceRef.Observation("retained-source")
        controller.smsAccessGranted = true
        controller.openSms(source)
        if (!BuildConfig.IS_GATEWAY) {
            show(controller)
            ui.onNodeWithContentDescription("Original SMS").assertDoesNotExist()
            ui.runOnIdle { check(controller.state.sheet == null && controller.deniedSheetRequests == 1) }
            return
        }
        controller.state = controller.state.copy(raw = null, rawDisclosure = RawDisclosureState.FAILURE,
            rawError = NativeSmsDisclosure.UNAVAILABLE,
            observationProcessing = mapOf(source to ObservationProcessing("needs_review", true)))
        show(controller)
        val retryRead = ui.onNode(hasText("Retry loading") and hasClickAction())
        val retryProcessing = ui.onNode(hasText("Retry") and hasClickAction())
        val list = ui.onNode(hasScrollToIndexAction() and hasAnyAncestor(
            SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.PaneTitle, "SMS receipt")))
        list.performScrollToNode(hasText("Retry loading") and hasClickAction())
        ui.runOnIdle { check(controller.rawCalls == 0 && controller.observationRetryCalls == 0) }
        retryRead.performClick()
        ui.runOnIdle {
            check(controller.rawCalls == 1 && controller.observationRetryCalls == 0)
            controller.state = controller.state.copy(rawError = "Original SMS access is unconfirmed. Close and check before trying again.")
        }
        retryRead.assertDoesNotExist()
        list.performScrollToNode(hasText("Retry") and hasClickAction())
        retryProcessing.assertIsEnabled()
        ui.runOnIdle { controller.smsAccessGranted = false }
        retryProcessing.assertDoesNotExist()
        ui.runOnIdle {
            controller.smsAccessGranted = true
            controller.state = controller.state.copy(operator = controller.operator.copy(
                capabilities = controller.operator.capabilities - Capability.GATEWAY.key))
        }
        retryProcessing.assertDoesNotExist()
    }

    @Test fun gatewayShowsLastAcknowledgementInKigaliTime() {
        val controller = FakeController(Route.SETTINGS)
        controller.openSheet(Sheet.GATEWAY)
        if (!BuildConfig.IS_GATEWAY) {
            show(controller)
            ui.onNodeWithText("Last upload acknowledgement").assertDoesNotExist()
            ui.runOnIdle { check(controller.state.sheet == null && controller.deniedSheetRequests == 1) }
            return
        }
        controller.state = controller.state.copy(gateway = controller.state.gateway!!.copy(
            lastCapture = "09:42", lastUpload = "2026-11-26T23:05:07Z", problem = "uploads_on_hold"))
        show(controller)
        val list = ui.onNode(hasScrollToIndexAction() and hasAnyAncestor(
            SemanticsMatcher.expectValue(androidx.compose.ui.semantics.SemanticsProperties.PaneTitle, "Gateway")))
        list.performScrollToNode(hasText("Last upload acknowledgement"))
        ui.onNodeWithText("09:42").assertExists()
        ui.onNodeWithText("27 Nov 2026 01:05:07 UTC+02:00").performScrollTo().assertIsDisplayed()
        list.performScrollToNode(hasText("Upload is paused. This phone can keep receiving messages."))
        ui.onNodeWithText("Upload is paused. This phone can keep receiving messages.").assertIsDisplayed()
    }
}
