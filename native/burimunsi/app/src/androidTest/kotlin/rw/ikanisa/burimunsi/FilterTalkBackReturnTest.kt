package rw.ikanisa.burimunsi

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.core.Role
import rw.ikanisa.burimunsi.core.Route
import rw.ikanisa.burimunsi.ui.Sheet
import rw.ikanisa.burimunsi.ui.BuriApp
import rw.ikanisa.burimunsi.ui.BuriContent
import java.util.ArrayDeque

/** Opt-in on a disposable device with TalkBack enabled. All records come from FakeController. */
@RunWith(AndroidJUnit4::class)
class FilterTalkBackReturnTest {
    @get:Rule val ui = createComposeRule()

    @Test fun paymentsHeader() = verifyReturn(Route.PAYMENTS)
    @Test fun memberStatement() = verifyReturn(Route.PAYMENTS, "member-1")
    @Test fun memberDirectory() = verifyReturn(Route.MEMBERS)
    @Test fun filteredMemberDirectory() = verifyReturn(Route.MEMBERS, applyActive = true)

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.packageName
    private val observer get() = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)

    private fun verifyReturn(route: Route, memberId: String? = null, applyActive: Boolean = false) {
        val manager = instrumentation.targetContext.getSystemService(AccessibilityManager::class.java)
        check(manager.isTouchExplorationEnabled && manager.getEnabledAccessibilityServiceList(
            AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            it.resolveInfo.serviceInfo.packageName == "com.google.android.marvin.talkback"
        }) { "Enable TalkBack with touch exploration on the disposable test device" }
        val info = observer.serviceInfo
        val originalFlags = info.flags
        info.flags = originalFlags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        observer.serviceInfo = info
        try {
            val model = FakeController(route, Role.STAFF).apply {
                seedStatementReview()
                if (memberId != null) navigate(route, memberId)
            }
            ui.setContent { BuriContent(reduceMotion = true) { BuriApp(model, {}, {}, {}, {}) } }
            val label = if (route == Route.PAYMENTS && memberId == null) "Payment filters" else "Filters"
            if (label == "Filters") {
                ui.onNode(hasScrollToIndexAction()).performScrollToNode(
                    (hasText(label) or hasContentDescription(label)) and hasClickAction())
            }
            val opener = await("one visible Filters button") {
                buttons(label).singleOrNull()?.takeIf { it.className == "android.widget.Button" }
            }
            exploreAndActivate(opener, "Open")
            if (applyActive) {
                val selector = await("membership selector") { buttons("Membership status").singleOrNull() }
                check(selector.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                val active = await("active membership option") { buttons("Active").singleOrNull() }
                check(active.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            }
            val dismissLabel = if (applyActive) "Apply" else "Close"
            var previous = Rect()
            var stable = 0
            val close = await("settled $dismissLabel button in the Filters sheet") {
                val node = buttons(dismissLabel).singleOrNull()?.takeIf { model.state.sheet == Sheet.FILTERS }
                val bounds = Rect().also { node?.getBoundsInScreen(it) }
                val screenHeight = instrumentation.targetContext.resources.displayMetrics.heightPixels
                stable = if (!bounds.isEmpty && bounds == previous && (applyActive || bounds.centerY() < screenHeight / 2)) stable + 1 else 0
                previous = bounds
                node?.takeIf { stable >= 3 }
            }
            exploreAndActivate(close, "Close")
            var focusedSince = 0L
            await("persistent accessibility focus on the original Filters button") {
                val focused = observer.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
                val returning = if (applyActive) buttons("Filters (1)").singleOrNull() else opener
                val correct = model.state.sheet == null && model.state.route == route && model.state.routeId == memberId &&
                    returning != null && focused == returning && focused?.isAccessibilityFocused == true &&
                    (!applyActive || model.listingQuery.active == "active")
                if (!correct) focusedSince = 0L else if (focusedSince == 0L) focusedSince = SystemClock.uptimeMillis()
                true.takeIf { correct && SystemClock.uptimeMillis() - focusedSince >= 650L }
            }
        } finally {
            info.flags = originalFlags
            observer.serviceInfo = info
        }
    }

    private fun buttons(label: String): Set<AccessibilityNodeInfo> {
        val result = mutableSetOf<AccessibilityNodeInfo>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        observer.windows.mapNotNull { it.root }.filter { it.packageName == app }.forEach(queue::addLast)
        var remaining = 400
        while (queue.isNotEmpty() && remaining-- > 0) {
            val node = queue.removeFirst()
            if (node.isPassword || node.isEditable) continue
            if (node.isVisibleToUser && (node.contentDescription?.toString() == label || node.text?.toString() == label)) {
                var parent: AccessibilityNodeInfo? = node
                while (parent != null && !parent.isClickable) parent = parent.parent
                if (parent != null && parent.isEnabled && parent.isVisibleToUser) result.add(parent)
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let(queue::addLast)
        }
        return result
    }

    private fun exploreAndActivate(node: AccessibilityNodeInfo, phase: String) {
        val externalTouch = InstrumentationRegistry.getArguments().getString("hardwareGesture") == "true"
        val bounds = Rect().also(node::getBoundsInScreen)
        if (externalTouch) Log.i("BuriFilterGesture", "explore$phase ${bounds.centerX()} ${bounds.centerY()}")
        else if (!node.isAccessibilityFocused) check(node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS))
        await("accessibility focus before $phase") {
            true.takeIf { observer.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY) == node }
        }
        if (externalTouch) Log.i("BuriFilterGesture", "activate$phase ${bounds.centerX()} ${bounds.centerY()}")
        else check(node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }

    private fun <T> await(condition: String, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + 20_000L
        while (SystemClock.uptimeMillis() < deadline) {
            ui.mainClock.advanceTimeBy(40L)
            read()?.let { return it }
            SystemClock.sleep(55L)
        }
        error("Timed out waiting for $condition")
    }
}
