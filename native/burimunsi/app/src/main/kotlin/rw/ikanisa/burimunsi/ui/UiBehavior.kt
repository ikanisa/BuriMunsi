package rw.ikanisa.burimunsi.ui

import android.view.View
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import java.lang.ref.WeakReference
import kotlinx.coroutines.flow.first

/** Focus keys are session-memory only. No names, raw receipts or credentials are persisted. */
class UiFocusMemory {
    val origins=mutableMapOf<String,String>()
    val targets=mutableMapOf<String,FocusRequester>()
    val scrollPositions=mutableMapOf<String,Pair<Int,Int>>()
    internal var filterOrigin: FilterOrigin? = null
}
val LocalUiFocusMemory=staticCompositionLocalOf { UiFocusMemory() }
val LocalUiFocusScope=staticCompositionLocalOf { "root" }
data class FocusAction(val modifier:Modifier,val click:()->Unit)
@Composable fun focusAction(key:String,click:()->Unit):FocusAction {
    val memory=LocalUiFocusMemory.current
    val scope=LocalUiFocusScope.current
    // The composition key distinguishes repeated controls with the same accessible label.
    val position=currentCompositeKeyHashCode
    val targetKey="$scope/$key/$position"
    val target=remember(targetKey){FocusRequester()}
    DisposableEffect(memory,targetKey,target){
        memory.targets[targetKey]=target
        onDispose{if(memory.targets[targetKey]===target)memory.targets.remove(targetKey)}
    }
    return FocusAction(Modifier.focusRequester(target)){
        memory.origins[scope]=targetKey
        click()
    }
}
internal class FilterHandle {
    val keyboard = FocusRequester()
    var button: WeakReference<View>? = null
}
internal class FilterOrigin(val scope: String, val handle: FilterHandle, val screenReader: Boolean)

@Composable fun FocusReturnEffect(scope: String, sheetOpen: Boolean) {
    val memory = LocalUiFocusMemory.current
    val window = LocalWindowInfo.current
    val focus = LocalFocusManager.current
    LaunchedEffect(scope, sheetOpen) {
        val origin = if (sheetOpen) null else memory.filterOrigin.also { memory.filterOrigin = null }
        val returning = origin?.scope == scope
        if (returning) {
            // The destination can recompose while the modal still owns the Android window.
            snapshotFlow { window.isWindowFocused }.first { it }
            withFrameNanos { }
            focus.clearFocus(force = true)
        }
        // A returning lazy row may not be attached on the first frame.
        repeat(3) {
            withFrameNanos { }
            val target = if (returning) origin?.handle?.keyboard else memory.origins[scope]?.let { memory.targets[it] }
            if (target != null && runCatching { target.requestFocus() }.getOrDefault(false)) {
                if (returning && origin?.screenReader == true) {
                    withFrameNanos { }
                    val button = origin.handle.button?.get()
                    if (button != null && button.isAttachedToWindow && button.isShown && button.isEnabled && button.hasWindowFocus() &&
                        button.context.getSystemService(AccessibilityManager::class.java).isTouchExplorationEnabled) {
                        button.performAccessibilityAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)
                    }
                }
                return@LaunchedEffect
            }
        }
    }
}

/** Keep one real Android button for the screen reader to refocus after the modal closes. */
@Composable internal fun FilterReturnButton(
    handle: FilterHandle, label: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier,
    content: @Composable (Modifier, () -> Unit) -> Unit,
) {
    val memory = LocalUiFocusMemory.current
    val scope = LocalUiFocusScope.current
    val focusModifier = Modifier.focusRequester(handle.keyboard).focusProperties { canFocus = true }
    val activate: (Boolean) -> Unit = { screenReader ->
        memory.filterOrigin = FilterOrigin(scope, handle, screenReader)
        onClick()
    }
    val manager = LocalContext.current.getSystemService(AccessibilityManager::class.java)
    var exploring by remember(manager) { mutableStateOf(manager.isTouchExplorationEnabled) }
    DisposableEffect(manager) {
        val listener = AccessibilityManager.TouchExplorationStateChangeListener { exploring = it }
        manager.addTouchExplorationStateChangeListener(listener)
        exploring = manager.isTouchExplorationEnabled
        onDispose { manager.removeTouchExplorationStateChangeListener(listener) }
    }
    if (!exploring) {
        content(modifier.then(focusModifier)) { activate(false) }
        return
    }
    Box(modifier, propagateMinConstraints = true) {
        content(Modifier.semantics { hideFromAccessibility() }.then(focusModifier)) { activate(false) }
        AndroidView(
            modifier = Modifier.matchParentSize(),
            factory = { context -> Button(context).apply {
                background = null
                minWidth = 0
                minHeight = 0
                minimumWidth = 0
                minimumHeight = 0
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            } },
            update = { button ->
                if (handle.button?.get() !== button) handle.button = WeakReference(button)
                button.contentDescription = label
                button.isEnabled = enabled
                button.setOnClickListener { activate(true) }
            },
        )
    }
}

/** Show new feedback immediately and settle it without retaining the previous message. */
@Composable internal fun Modifier.feedbackEntrance(key:Any):Modifier {
    if(!LocalBuriMotionAllowed.current)return this
    val progress=remember(key){Animatable(0f)}
    val distance=with(LocalDensity.current){3.dp.toPx()}
    LaunchedEffect(progress){progress.animateTo(1f,tween(140))}
    return graphicsLayer{
        alpha=.82f+progress.value*.18f
        translationY=(1f-progress.value)*distance
    }
}

/** Entry-only motion: outgoing financial records are disposed, never cross-faded underneath. */
@Composable fun RouteEntrance(title:String,onFullyDrawn:(()->Unit)?=null,content:@Composable ()->Unit){
    val reduced=!LocalBuriMotionAllowed.current
    val progress=remember{Animatable(if(reduced)1f else 0f)}
    val distance=with(LocalDensity.current){6.dp.toPx()}
    LaunchedEffect(reduced){
        if(reduced)progress.snapTo(1f) else progress.animateTo(1f,tween(160))
    }
    // Animatable also respects Android's system MotionDurationScale.
    val finished by remember { derivedStateOf { progress.value == 1f } }
    val drawSignal = if(onFullyDrawn==null) Modifier else Modifier.drawWithContent {
        drawContent()
        if(finished) onFullyDrawn()
    }
    Box(Modifier.fillMaxSize().semantics{paneTitle=title}.graphicsLayer{
        alpha=progress.value;translationY=(1f-progress.value)*distance
    }.then(drawSignal)){content()}
}
