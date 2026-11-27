package rw.ikanisa.burimunsi

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.core.Route
import rw.ikanisa.burimunsi.core.SmartOnboardingState
import rw.ikanisa.burimunsi.core.SmartOnboardingStep
import rw.ikanisa.burimunsi.ui.BuriContent
import rw.ikanisa.burimunsi.ui.Sheet
import rw.ikanisa.burimunsi.ui.SmartEnrollPanel

@RunWith(AndroidJUnit4::class)
class MemberEnrollmentInputTest {
    @get:Rule val ui = createComposeRule()

    private fun openForm(fontScale: Float = 1f, height: Int = 500): FakeController {
        val model = FakeController(Route.MEMBERS)
        model.state = model.state.copy(sheet = Sheet.ENROLL, onboarding = SmartOnboardingState(step = SmartOnboardingStep.MEMBER))
        ui.setContent {
            BuriContent(reduceMotion = true) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                    Box(Modifier.size(width = 320.dp, height = height.dp)) {
                        SmartEnrollPanel(model.state, model, {}, {}, {}, {})
                    }
                }
            }
        }
        return model
    }

    private fun field(label: String) = ui.onNode(hasContentDescription(label) and hasSetTextAction())
    private fun pressBack() {
        val back = hasText("Back") and hasClickAction()
        ui.onNode(hasScrollToIndexAction()).performScrollToNode(back)
        ui.onNode(back).performClick()
    }

    @Test fun compactEditorValidatesIdentityAndKeepsTheNextFieldAttached() {
        openForm(fontScale = 2f, height = 250)
        val name = field("MoMo name")
        name.performTextInput("X")
        ui.onNodeWithText("Use a name of 2–100 characters without control characters.").assertExists()
        name.performImeAction()
        val number = field("MoMo number")
        number.assertIsFocused().performTextInput("123")
        ui.onNodeWithText("Enter a valid phone number.").assertExists()
        number.performTextReplacement("0780000001")
        ui.onNodeWithText("Enter a valid phone number.").assertDoesNotExist()
        ui.onNode(hasText("Save member") and hasClickAction()).assertIsNotEnabled()
    }

    @Test fun backingOutOfAnEditedMemberFormOffersKeepEditingAndDiscard() {
        val model = openForm()
        field("MoMo name").performTextInput("Example Member")
        pressBack()
        ui.onNodeWithText("Keep editing").performClick()
        ui.runOnIdle { check(model.state.draft["name"] == "Example Member") }
        pressBack()
        ui.onNodeWithText("Discard changes").performClick()
        ui.runOnIdle {
            check(model.state.onboarding.step == SmartOnboardingStep.OPTIONS && model.state.draft.isEmpty())
        }
    }
}
