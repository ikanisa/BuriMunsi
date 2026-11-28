package rw.ikanisa.burimunsi

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.ui.BuriContent
import rw.ikanisa.burimunsi.ui.SmsPermissionDisclosure

@RunWith(AndroidJUnit4::class)
class SmsPermissionDisclosureTest {
    @get:Rule val ui = createComposeRule()

    @Test fun declineNeverContinues() = exercise(1f, false)
    @Test fun continueOnlyOnExplicitTapAtDoubleTextSize() = exercise(2f, true)

    private fun exercise(fontScale: Float, confirm: Boolean) {
        var visible by mutableStateOf(true)
        var approvals = 0
        var declines = 0
        ui.setContent {
            BuriContent(reduceMotion = true) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                    if (visible) SmsPermissionDisclosure(
                        onContinue = { approvals++; visible = false },
                        onDismiss = { declines++; visible = false },
                    )
                }
            }
        }
        ui.onNodeWithTag("sms-permission-notice").assertIsDisplayed()
        ui.onNodeWithText("Use SMS to record M-Money payments?").assertIsDisplayed()
        ui.onNodeWithTag("sms-permission-copy").assertIsDisplayed()
        ui.onNodeWithText("Continue").assertIsDisplayed().assertHasClickAction()
        ui.onNodeWithText("Not now").assertIsDisplayed().assertHasClickAction()
        ui.runOnIdle { assertEquals(0, approvals); assertEquals(0, declines) }
        ui.onNodeWithText(if (confirm) "Continue" else "Not now").performClick()
        ui.onNodeWithTag("sms-permission-notice").assertDoesNotExist()
        ui.runOnIdle {
            assertEquals(if (confirm) 1 else 0, approvals)
            assertEquals(if (confirm) 0 else 1, declines)
        }
    }
}
