package rw.ikanisa.burimunsi

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.core.ListRestoreStop
import rw.ikanisa.burimunsi.core.Role
import rw.ikanisa.burimunsi.core.Route
import rw.ikanisa.burimunsi.core.ScreenGate
import rw.ikanisa.burimunsi.ui.*

@RunWith(AndroidJUnit4::class)
class NativeShellRecoveryTest {
    @get:Rule val ui = createComposeRule()

    @Test fun submittingBeforeDebounceRunsOneSearchAndAllowsAnExplicitRetry() {
        var value by mutableStateOf("")
        val requests = mutableListOf<String>()
        ui.setContent {
            BuriContent(reduceMotion=true) {
                Search(value, { value = it }, { requests += value }, "Find member")
            }
        }
        val field = ui.onNodeWithContentDescription("Find member")
        ui.mainClock.autoAdvance = false
        try {
            field.performTextInput("Marie")
            ui.mainClock.advanceTimeBy(80)
            field.performImeAction()
            ui.mainClock.advanceTimeBy(400)
            ui.runOnIdle { check(requests == listOf("Marie")) }
            field.performImeAction()
            ui.runOnIdle { check(requests == listOf("Marie", "Marie")) }
        } finally {
            ui.mainClock.autoAdvance = true
        }
    }

    @Test fun pauseHidesTaskFeedbackAndResumeKeepsBothTheRouteAndItsWarningsReachable() {
        val model = FakeController(Route.SETTINGS, Role.STAFF)
        val notice = "Operation committed. Refresh to check the result."
        val error = "Refresh could not finish. Check your connection and try again."
        model.state = model.state.copy(commandNotice=notice, error=error, offline=true,
            pending=true, savedAt=System.currentTimeMillis(), listRestoration=ListRestoreStop.OFFLINE)
        ui.setContent {
            BuriContent(reduceMotion=true) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.width(320.dp).height(320.dp)) {
                        BuriApp(model, {}, {}, {}, {})
                    }
                }
            }
        }
        ui.onNodeWithText(notice).assertIsDisplayed()
        ui.onNodeWithContentDescription("Check previous action").performScrollTo().assertIsDisplayed()
        val list = ui.onNode(hasScrollToIndexAction())
        list.assertHeightIsAtLeast(32.dp).performScrollToNode(hasText("Help"))
        ui.onNode(hasText("Help") and hasClickAction()).assertIsDisplayed()

        ui.runOnIdle { model.screenGate = ScreenGate.BACKGROUND }
        ui.onNodeWithText("App paused").assertIsDisplayed()
        ui.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "App paused")).assertExists()
        ui.onNodeWithText(notice).assertDoesNotExist()
        ui.onNodeWithText(error).assertDoesNotExist()
        ui.onNodeWithText("Offline · read only", substring=true).assertDoesNotExist()
        ui.onNodeWithContentDescription("Check previous action").assertDoesNotExist()
        ui.runOnIdle { model.screenGate = ScreenGate.CHECKING }
        ui.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Checking access")).assertExists()
        ui.onNodeWithText(notice).assertDoesNotExist()
        ui.onNodeWithText("Offline · read only", substring=true).assertDoesNotExist()
        ui.runOnIdle { model.screenGate = ScreenGate.STALE }
        ui.onNodeWithText("These records have expired. Reconnect and refresh before continuing.").assertExists()
        ui.onNodeWithText("Updating records").assertDoesNotExist()
        ui.runOnIdle { model.screenGate = ScreenGate.OPEN }
        ui.onNodeWithText(notice).performScrollTo().assertIsDisplayed()
    }

    @Test fun bothSessionRecoveryActionsAreReachableAtDoubleTypeInAShortWindow() {
        var retries = 0
        var signOuts = 0
        ui.setContent {
            BuriContent(reduceMotion=true) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, 2f)) {
                    Box(Modifier.fillMaxSize()) {
                        Box(Modifier.width(300.dp).height(160.dp)) {
                            BuriSplash("Check your connection", { retries++ }, { signOuts++ })
                        }
                    }
                }
            }
        }
        ui.onNodeWithText("Retry").performScrollTo().assertIsDisplayed().performClick()
        ui.onNodeWithText("Sign out").performScrollTo().assertIsDisplayed().performClick()
        ui.runOnIdle { check(retries == 1 && signOuts == 1) }
    }

    @Test fun shortSheetKeepsItsFieldsAndBothFooterActionsReachable() {
        var applies = 0
        var resets = 0
        ui.setContent {
            BuriContent(reduceMotion=true) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.width(320.dp).height(128.dp)) {
                        Panel(footer={
                            Column {
                                Primary("Apply", { applies++ })
                                Primary("Reset all", { resets++ }, secondary=true)
                            }
                        }) {
                            item { Text("Date range", Modifier.height(72.dp)) }
                            item { Text("Amount", Modifier.height(72.dp)) }
                        }
                    }
                }
            }
        }
        val list = ui.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasText("Date range"))
        ui.onNodeWithText("Date range").assertIsDisplayed()
        list.performScrollToNode(hasText("Amount"))
        ui.onNodeWithText("Amount").assertIsDisplayed()
        for (action in listOf("Apply", "Reset all")) {
            list.performScrollToNode(hasText(action))
            ui.onNodeWithText(action).assertIsDisplayed().performClick()
        }
        ui.runOnIdle { check(applies == 1 && resets == 1) }
    }
}
