package rw.ikanisa.burimunsi

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.cool.mobile.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import rw.ikanisa.burimunsi.ui.BuriContent
import rw.ikanisa.burimunsi.ui.NativeReceiverStatus
import rw.ikanisa.burimunsi.ui.SmsPermissionDisclosure

@RunWith(AndroidJUnit4::class)
class SmsPermissionOfferTest {
    @get:Rule val ui = createComposeRule()

    @Test fun staleOriginalOfferCannotBeReusedEvenIfSessionBecomesValidAgain() {
        var active = true
        var dispatches = 0
        val offer = NativeReceiverStatus.PermissionOffer(listOf("fixture"), { active }) { dispatch ->
            dispatches++
            dispatch(listOf("fixture"))
        }
        assertTrue(offer.isCurrent())
        active = false
        offer.confirm { error("Expired offer dispatched") }
        active = true
        assertFalse(offer.isCurrent())
        offer.confirm { error("Consumed offer dispatched") }
        assertEquals(0, dispatches)
    }

    @Test fun currentOfferCanOnlyDispatchOnce() {
        var dispatches = 0
        val offer = NativeReceiverStatus.PermissionOffer(listOf("fixture"), { true }) { dispatch ->
            dispatches++
            dispatch(listOf("fixture"))
        }
        offer.confirm { assertEquals(listOf("fixture"), it) }
        offer.confirm { error("Offer replayed") }
        assertEquals(1, dispatches)
    }

    @Test fun disclosureContinuesToTheRealAndroidPromptAndDenialStaysDenied() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        check(BuildConfig.IS_QUALIFICATION && BuildConfig.IS_GATEWAY &&
            context.packageName.endsWith(".gateway.cloud.nativeTest"))
        // The offline app has the exact receiver manifest. No granting through ADB,
        // injecting messages, signing into a profile, or touching an approved device.
        val permissions = listOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS,
            Manifest.permission.READ_PHONE_STATE)
        assertTrue(permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_DENIED })
        val showing = mutableStateOf(true)
        val result = mutableStateOf<Map<String, Boolean>?>(null)
        ui.setContent {
            val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
                result.value = it
            }
            BuriContent(reduceMotion = true) {
                if (showing.value) SmsPermissionDisclosure(
                    onContinue = { showing.value = false; launcher.launch(permissions.toTypedArray()) },
                    onDismiss = { showing.value = false },
                )
            }
        }
        ui.onNodeWithTag("sms-permission-notice").assertIsDisplayed()
        ui.runOnIdle { assertEquals(null, result.value) }
        ui.onNodeWithText("Continue").performClick()

        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        var deniedScreens = 0
        val observed = linkedSetOf<String>()
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline && result.value == null) {
            val roots = listOfNotNull(automation.rootInActiveWindow) + automation.windows.mapNotNull { it.root }
            for (root in roots) {
                val controller = root.packageName?.toString() ?: continue
                observed.add(controller)
                if (controller != "com.google.android.permissioncontroller" &&
                    controller != "com.android.permissioncontroller") continue
                // Android versions and permission groups can use different view IDs.
                val candidates = root.findAccessibilityNodeInfosByText("Don’t allow") +
                    root.findAccessibilityNodeInfosByText("Don't allow") +
                    root.findAccessibilityNodeInfosByText("Deny") +
                    root.findAccessibilityNodeInfosByViewId("$controller:id/permission_deny_button")
                for (deny in candidates) {
                    if (!deny.isVisibleToUser || !deny.isClickable) continue
                    if (deny.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) {
                        deniedScreens++
                        break
                    }
                }
            }
            SystemClock.sleep(200)
        }
        assertTrue("No native denial performed; window packages=$observed, result=${result.value}", deniedScreens > 0)
        val denied = checkNotNull(result.value) { "No Android permission result" }
        assertEquals(permissions.toSet(), denied.keys)
        assertTrue(denied.values.none { it })
        assertTrue(permissions.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_DENIED })
    }
}
