package rw.ikanisa.burimunsi

import android.os.Bundle
import android.content.Intent
import android.net.Uri
import android.net.ConnectivityManager
import android.provider.Settings
import android.Manifest
import android.app.NotificationManager
import android.os.Build
import android.os.PowerManager
import android.content.pm.PackageManager
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.ReportDrawnWhen
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.lifecycleScope
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.activity.viewModels
import kotlinx.coroutines.launch
import app.cool.mobile.BuildConfig
import app.cool.mobile.R
import rw.ikanisa.burimunsi.ui.*
import rw.ikanisa.burimunsi.core.export.ExportFormat
import rw.ikanisa.burimunsi.core.Capability
import rw.ikanisa.burimunsi.core.BuriMunsiSupport
import rw.ikanisa.burimunsi.core.ScreenGate
import rw.ikanisa.burimunsi.core.Role
import rw.ikanisa.burimunsi.core.Route

class MainActivity:ComponentActivity(){
    private val model:BuriViewModel by viewModels()
    private val permissions=registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()){
        model.permissionsChanged();refreshSystemPolicy()
    }
    private val receivingPrompt by lazy { getSharedPreferences("receiver-permission-prompt", MODE_PRIVATE) }

    // Do not persist this UI approval: it applies to the current foreground
    // Admin only, and cannot itself grant Android access or enable capture.
    private data class SmsPermissionNotice(
        val actorId: String, val foreground: Long, val automatic: Boolean,
        val offer: NativeReceiverStatus.PermissionOffer,
    )
    private var smsPermissionNotice by mutableStateOf<SmsPermissionNotice?>(null)
    private var smsNoticeShownFor: String? = null
    private var smsForeground = 0L
    private var smsVisible = false

    private fun currentSmsOwner(actorId: String, foreground: Long): Boolean =
        BuildConfig.IS_GATEWAY && smsVisible && smsForeground == foreground &&
            model.screenGate == ScreenGate.OPEN && model.state.operator?.let {
                it.id == actorId && it.role == Role.ADMIN
            } == true

    private fun offerReceivingPermissions(automatic: Boolean) {
        val id = model.state.operator?.id ?: return
        val foreground = smsForeground
        if (!currentSmsOwner(id, foreground) || smsPermissionNotice != null) return
        model.prepareReceivingPermissions(automatic) { offer ->
            if (!currentSmsOwner(id, foreground) || !offer.isCurrent() || smsPermissionNotice != null)
                return@prepareReceivingPermissions
            val missing = offer.names.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) {
                if (automatic) offerSyncNotificationPermission()
                return@prepareReceivingPermissions
            }
            if (automatic && (smsNoticeShownFor == id || receivingPrompt.getBoolean("asked", false) ||
                    missing.any(::shouldShowRequestPermissionRationale))) return@prepareReceivingPermissions
            smsNoticeShownFor = id
            smsPermissionNotice = SmsPermissionNotice(id, foreground, automatic, offer)
        }
    }

    private fun continueReceivingPermissions(notice: SmsPermissionNotice) {
        if (smsPermissionNotice !== notice) return
        smsPermissionNotice = null
        if (!currentSmsOwner(notice.actorId, notice.foreground)) return
        notice.offer.confirm { required ->
            if (!currentSmsOwner(notice.actorId, notice.foreground)) return@confirm
            val missing = required.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            if (missing.isEmpty()) return@confirm
            val previouslyAsked = receivingPrompt.getBoolean("asked", false)
            val previouslyDenied = missing.any(::shouldShowRequestPermissionRationale)
            if (!notice.automatic && previouslyAsked && !previouslyDenied) {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            } else {
                receivingPrompt.edit().putBoolean("asked", true).apply()
                permissions.launch(missing.toTypedArray())
            }
        }
    }
    private val notifications=registerForActivityResult(ActivityResultContracts.RequestPermission()){
        refreshSystemPolicy();model.permissionsChanged()
    }
    private fun offerSyncNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || receivingPrompt.getBoolean("notification-asked",false) ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ||
            shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) return
        receivingPrompt.edit().putBoolean("notification-asked",true).apply()
        notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    // Keep the v33 CSV slot registered solely to drain an unbound legacy result.
    // It must never read, write, delete, or change the current download binding.
    private val legacyCsvDownload=registerForActivityResult(ActivityResultContracts.CreateDocument(ExportFormat.CSV.mimeType)){ _ -> }
    // Drain any result issued by the older unbound launcher without inspecting its URI.
    private val legacyMemberImport = registerForActivityResult(ActivityResultContracts.OpenDocument()) { _ -> }
    private val memberInputs = AndroidMemberInputs(this) { model }
    private val listingDocuments = AndroidListingDocuments(this) { model }

    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState)
        memberInputs.restore(savedInstanceState)
        listingDocuments.restore(savedInstanceState)
        // The app uses the selected dark family regardless of the phone's day mode.
        enableEdgeToEdge(
            statusBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle=SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        if(!BuildConfig.DEBUG)window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            var visible by remember{mutableStateOf(false)}
            var adminEntryOffered by rememberSaveable { mutableStateOf(false) }
            ReportDrawnWhen {
                visible && !model.state.starting && !model.state.busy &&
                    model.screenGate == ScreenGate.OPEN
            }
            LaunchedEffect(model.state.sheet, model.state.operator?.id, model.state.onboarding.step,
                model.state.onboarding.documentUri, memberInputs.selectedCapture) {
                memberInputs.reconcileSelection()
            }
            // A successful camera capture is queued by the ViewModel until the
            // original operator's foreground session and enrollment access are fresh.
            LaunchedEffect(visible,model.screenGate,model.state.busy,model.state.offline,model.state.pending,
                model.state.onboarding.photoPreviewPending,model.state.onboarding.documentRequestId){
                if(visible&&model.state.onboarding.photoPreviewPending&&!model.state.busy&&!model.state.offline&&!model.state.pending&&model.allows(Capability.ENROLL))
                    model.state.onboarding.documentRequestId?.let(memberInputs::previewCapturedPhoto)
            }
            val actor = model.state.operator
            LaunchedEffect(actor, model.screenGate, model.state.route, model.state.routeId, model.state.sheet, model.state.sheetId) {
                val notice = smsPermissionNotice
                if (notice != null && (!currentSmsOwner(notice.actorId, notice.foreground) || !notice.offer.isCurrent()))
                    smsPermissionNotice = null
            }
            LaunchedEffect(visible, actor?.id, actor?.role, model.state.busy, model.screenGate, model.smsAccessGranted) {
                if (actor?.role != Role.ADMIN) {
                    adminEntryOffered = false
                } else if (visible && !model.state.busy && model.screenGate == ScreenGate.OPEN) {
                    if (BuildConfig.IS_GATEWAY) {
                        offerReceivingPermissions(automatic = true)
                    } else if (!adminEntryOffered) {
                        adminEntryOffered = true
                        if (!AdminReceiverEntry.open(this@MainActivity,actor.role)) model.navigate(Route.SETTINGS)
                    }
                }
            }
            val download=model.downloadRequest
            LaunchedEffect(download?.id,visible,model.state.busy){
                if(visible&&download!=null&&!model.state.busy)listingDocuments.launchNext()
            }
            // The original phone/passcode route is the application entry point.
            // Repository authentication owns installation and collection bootstrap.
            LifecycleResumeEffect(model){
                visible=true
                smsVisible=true
                refreshSystemPolicy()
                model.onForeground()
                val stopNetworkObservation=SessionNetworkObserver.observe(getSystemService(ConnectivityManager::class.java)){
                    lifecycleScope.launch{model.onNetworkAvailable()}
                }
                val stopRecordObservation = BuriRecordChanges.observe(this@MainActivity, model::onRecordsChanged)
                onPauseOrDispose {
                    visible=false
                    smsVisible=false
                    smsForeground++
                    smsPermissionNotice=null
                    model.onBackground()
                    stopRecordObservation()
                    stopNetworkObservation()
                }
            }
            BuriContent {
                if(visible)BuriApp(model,onSupport=::support,
                    onPermissions={offerReceivingPermissions(automatic = false)},
                    onExport=model::prepareDownload,
                    onPhoneSettings={startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:$packageName")))},
                    onPickMemberFile=memberInputs::pickDocument,
                    onPreviewMemberFile=memberInputs::previewDocument,
                    onNotifications=::notificationAccess,onBatteryOptimization=::batteryOptimization,
                    onTakeMemberPhoto=memberInputs::takePhoto,onPickMemberPhoto=memberInputs::pickPhoto)
                else BuriSplash()
                val notice = smsPermissionNotice
                if (visible && notice != null && currentSmsOwner(notice.actorId, notice.foreground)) {
                    SmsPermissionDisclosure(
                        onContinue = { continueReceivingPermissions(notice) },
                        onDismiss = { smsPermissionNotice = null },
                    )
                }
            }
        }
    }
    override fun onSaveInstanceState(outState:Bundle){
        listingDocuments.save(outState)
        memberInputs.save(outState)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        if (isFinishing && !isChangingConfigurations) memberInputs.finish()
        super.onDestroy()
    }

    private fun refreshSystemPolicy(){
        val manager=getSystemService(NotificationManager::class.java)
        val channel=manager?.getNotificationChannel(getString(R.string.burimunsi_sync_channel_id))
        val allowed=manager?.areNotificationsEnabled()==true&&channel?.importance!=NotificationManager.IMPORTANCE_NONE&&
            (Build.VERSION.SDK_INT<33||checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED)
        val exempt=getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName)==true
        model.systemPolicyChanged(allowed,exempt)
    }
    private fun notificationAccess(){
        if(!BuildConfig.IS_GATEWAY || model.screenGate != ScreenGate.OPEN || model.state.operator?.role != Role.ADMIN) return
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED&&
            (!receivingPrompt.getBoolean("notification-asked",false)||shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))){
            receivingPrompt.edit().putBoolean("notification-asked",true).apply()
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }else{
            val manager=getSystemService(NotificationManager::class.java)
            val channel=manager?.getNotificationChannel(getString(R.string.burimunsi_sync_channel_id))
            val intent=if(channel?.importance==NotificationManager.IMPORTANCE_NONE)
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,packageName).putExtra(Settings.EXTRA_CHANNEL_ID,getString(R.string.burimunsi_sync_channel_id))
                else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,packageName)
            runCatching{startActivity(intent)}
        }
    }
    private fun batteryOptimization(){
        if(!BuildConfig.IS_GATEWAY || model.screenGate != ScreenGate.OPEN || model.state.operator?.role != Role.ADMIN) return
        val exempt=getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName)==true
        val target=if(exempt)Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            else Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:$packageName"))
        if(runCatching{startActivity(target)}.isFailure)
            runCatching{startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:$packageName")))}
    }
    private fun support(){
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuriMunsiSupport.whatsappUrl))) }
        catch (_: android.content.ActivityNotFoundException) {
            android.widget.Toast.makeText(this, BuriMunsiSupport.phone, android.widget.Toast.LENGTH_LONG).show()
        }
    }
}
