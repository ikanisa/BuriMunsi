package rw.ikanisa.burimunsi.ui

import android.os.SystemClock
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.ui.semantics.Role as SemanticRole
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.cool.mobile.R
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.core.export.ExportFormat

// Keep the scrollable route viewport above the floating navigation bar.
private val BottomNavBottomGap=18.dp
private val BottomNavVerticalPadding=6.dp

private fun iconFor(route:Route)=when(route){Route.HOME->R.drawable.ic_home;Route.PAYMENTS->R.drawable.ic_activity;Route.MEMBERS->R.drawable.ic_members;else->R.drawable.ic_settings}
private fun titleFor(route:Route)=when(route){Route.LOGIN->"Sign in";Route.HOME->"Home";Route.PAYMENTS->"Payments";Route.PAYMENT->"Payment";Route.MEMBERS->"Members";Route.MEMBER->"Member";Route.SMS->"SMS";Route.SETTINGS->"Account"}

@Composable
fun BuriApp(model:BuriController,onSupport:()->Unit,onPermissions:()->Unit,onExport:(ExportFormat)->Unit,onPhoneSettings:()->Unit,
    onPickMemberFile:()->Unit={},onPreviewMemberFile:(requestId:String)->Unit={},onNotifications:()->Unit={},onBatteryOptimization:()->Unit={},
    onTakeMemberPhoto:()->Unit={},onPickMemberPhoto:()->Unit={}){
    val state=model.state
    val memory=remember(state.operator?.id){UiFocusMemory()}
    val scope="${state.route}:${state.routeId.orEmpty()}:${state.sheet}:${state.sheetId.orEmpty()}"
    CompositionLocalProvider(LocalUiFocusMemory provides memory,LocalUiFocusScope provides scope,LocalBuriRouteColors provides BuriTheme.colors(state.route),LocalBuriRoute provides state.route){
        FocusReturnEffect(scope)
        BuriAppBody(model,onSupport,onPermissions,onExport,onPhoneSettings,onPickMemberFile,onPreviewMemberFile,onNotifications,onBatteryOptimization,onTakeMemberPhoto,onPickMemberPhoto)
    }
}

@Composable private fun BuriAppBody(model:BuriController,onSupport:()->Unit,onPermissions:()->Unit,onExport:(ExportFormat)->Unit,onPhoneSettings:()->Unit,
    onPickMemberFile:()->Unit,onPreviewMemberFile:(requestId:String)->Unit,onNotifications:()->Unit,onBatteryOptimization:()->Unit,
    onTakeMemberPhoto:()->Unit,onPickMemberPhoto:()->Unit){
    val t=LocalUiText.current
    val s=model.state
    if(s.starting||s.savedSessionPending){
        BuriSplash(s.error,if(s.savedSessionPending&&!s.busy)model::refresh else null,
            if(s.savedSessionPending&&!s.busy)model::logout else null,loading=s.busy||s.starting,
            loadingLabel=model.operationLabel?:"Getting things ready")
        return
    }
    val gate=model.screenGate
    val presentation=model.presentation
    val read=s.operator!=null
    val requestedRoute=model.requestedRoute?.takeIf{read&&gate==ScreenGate.OPEN}
    val displayedRoute=requestedRoute?:s.route
    val sheetOpen=s.sheet!=null && ((gate==ScreenGate.OPEN && presentation.showRecords) ||
        (s.sheet==Sheet.REPLACE_DEVICE && s.receiverRetirementPending && gate!=ScreenGate.BACKGROUND))
    val waitingForRoute=requestedRoute!=null && requestedRoute!=s.route
    val loadingRoute=displayedRoute.takeUnless{it==Route.SMS && !model.allows(Capability.SMS)}
    val showRouteProgress=s.showsRouteProgress(model.operation,gate,presentation,sheetOpen,waitingForRoute,model.exportFeedback)
    val keyboard=LocalSoftwareKeyboardController.current
    var exportVisible by remember(s.operator?.id,s.route,s.routeId,s.sheet,s.sheetId){mutableStateOf(false)}
    val openExport:()->Unit={if(model.canExportListing&&!s.busy&&!s.offline&&gate==ScreenGate.OPEN){keyboard?.hide();exportVisible=true}}
    LaunchedEffect(read,gate,model.canExportListing){if(!read||gate!=ScreenGate.OPEN||!model.canExportListing)exportVisible=false}
    val focus=LocalFocusManager.current
    val imeVisible=WindowInsets.ime.getBottom(LocalDensity.current)>0
    val navItemHeight=if(LocalDensity.current.fontScale>=1.5f)72.dp else 54.dp
    val navClearance=navItemHeight+BottomNavVerticalPadding*2+BottomNavBottomGap
    val canBack=read&&(s.route!=Route.HOME||s.sheet!=null)
    val back:()->Unit={if(imeVisible){keyboard?.hide();focus.clearFocus()}else if(canBack)model.back()}
    BackHandler(enabled=imeVisible||canBack,onBack=back)
    Box(Modifier.fillMaxSize().background(BuriTheme.wash(displayedRoute)).onPreviewKeyEvent{
        if(it.key==Key.Escape&&(imeVisible||canBack)){if(it.type==KeyEventType.KeyUp)back();true}else false
    }){
        Box(Modifier.matchParentSize().background(Color.Black.copy(alpha=BuriTheme.WashScrimAlpha)))
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()){
            Header(if(gate==ScreenGate.OPEN)s.copy(route=displayedRoute) else s.copy(operator=null),model,onSupport)
                if(showRouteProgress) BuriOperationFeedback(model.operation,model.operationLabel)
                s.commandNotice?.takeIf{read && !sheetOpen}?.let{notice->
                    BuriStatusMessage(notice,warning=true)
                }
                s.error?.takeUnless{sheetOpen}?.let{error->
                    BuriStatusMessage(error,error=true)
                }
                model.exportFeedback?.takeIf{s.sheet==null&&read&&gate==ScreenGate.OPEN&&presentation.showRecords}?.let{BuriExportFeedback(it,model::cancelExport,model::dismissExportFeedback)}
                if(s.passcodeChangePending||s.savedSessionPending){
                    Row(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=4.dp),verticalAlignment=Alignment.CenterVertically){
                        RoundAction(R.drawable.ic_out,t("Sign out"),model::logout,enabled=!s.busy,size=48)
                    }
                }
                if(s.offline&&read){
                    Row(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=6.dp),verticalAlignment=Alignment.CenterVertically){
                        Glyph(R.drawable.ic_alert,t("Offline"),BuriTheme.Warn,18)
                        Spacer(Modifier.width(10.dp));Text(s.savedAt?.let{t("%1\$s · saved %2\$s",t("Offline · read only"),historyTime(java.time.Instant.ofEpochMilli(it).toString(),t.locale))}?:t("Offline · read only"),fontSize=14.sp,color=BuriTheme.Warn,lineHeight=22.sp)
                    }
                }
                if(read)PagedRestoration.label(s.listRestoration)?.let{notice->
                    Text(t(notice),Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=6.dp)
                        .semantics{liveRegion=LiveRegionMode.Polite},fontSize=14.sp,color=BuriTheme.Warn,lineHeight=22.sp)
                }
                if(presentation.unresolvedWarning){
                    Row(Modifier.fillMaxWidth().padding(horizontal=24.dp,vertical=6.dp),verticalAlignment=Alignment.CenterVertically){
                        Text(t("Previous action needs confirmation"),Modifier.weight(1f),fontSize=14.sp,color=BuriTheme.Warn,lineHeight=22.sp)
                        if(read)RoundAction(R.drawable.ic_sync,t("Check previous action"),model::retry,enabled=presentation.mayCheckOutcome,size=48)
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth().padding(bottom=if(read)navClearance else 0.dp).semantics{
                    stateDescription=t(if(requestedRoute!=null&&requestedRoute!=s.route)"Loading records"else PresentationState.label(presentation.state))
                }){
                    CompositionLocalProvider(LocalProgressPresented provides (showRouteProgress || sheetOpen)) {
                    if(gate!=ScreenGate.OPEN){
                        // Preserve the existing route shell while disposing all private records/forms.
                        if(gate in setOf(ScreenGate.CHECKING,ScreenGate.STALE)&&(s.busy||model.operation!=UiOperation.NONE))BuriLoadingPanel(if(gate==ScreenGate.CHECKING)"Checking access"else "Updating records")
                        else Column(Modifier.fillMaxWidth().padding(20.dp)){
                            Text(t(when(gate){ScreenGate.BACKGROUND->"App paused";ScreenGate.CHECKING->"Checking access";ScreenGate.STALE->"Updating records";else->"Check your connection"}),fontSize=17.sp,lineHeight=25.sp)
                            if(gate!=ScreenGate.BACKGROUND&&!s.busy)Primary(t("Refresh"),model::refresh)
                        }
                    }else if(waitingForRoute){
                        BuriLoadingPanel("Loading records",loadingRoute)
                    }else if(read&&!presentation.showRecords){
                        if(s.busy||model.operation in setOf(UiOperation.INITIAL_READ,UiOperation.REFRESH))BuriLoadingPanel("Loading records",loadingRoute)
                        else Column(Modifier.fillMaxWidth().padding(24.dp)){
                            Text(t(PresentationState.label(presentation.state)),fontSize=17.sp,lineHeight=25.sp)
                            if(presentation.mayRetryRead){Spacer(Modifier.height(16.dp));Primary(t("Refresh"),model::refresh)}
                        }
                    }else key(s.route,s.routeId){
                        val records = when(s.route){
                            Route.HOME -> s.home
                            Route.PAYMENTS -> s.payments
                            else -> null
                        }
                        val onFullyDrawn: (() -> Unit)? = records?.takeUnless { s.busy || s.sheet != null || exportVisible }?.let { payload ->
                            {
                                if(model.consumeFreshDraw(s.route,payload)){
                                    val event=if(s.route==Route.HOME)"home_fresh_draw" else "payments_fresh_draw"
                                    Log.i("BuriMunsiPerf","event=$event t_ns=${SystemClock.elapsedRealtimeNanos()}")
                                }
                            }
                        }
                        RouteEntrance(t(titleFor(s.route)),onFullyDrawn){when(s.route){
                        Route.LOGIN->Login(s.busy||s.configurationRequired||s.passcodeChangePending||s.savedSessionPending,
                            s.busy&&model.operation==UiOperation.SIGN_IN,model::login,onSupport,!s.busy)
                        Route.HOME->HomeScreen(s,model)
                        Route.PAYMENTS->PaymentsScreen(s,model,openExport)
                        Route.PAYMENT->PaymentScreen(s,model)
                        Route.MEMBERS->MembersScreen(s,model,openExport)
                        Route.MEMBER->MemberScreen(s,model)
                        Route.SMS->SmsScreen(s,model,openExport)
                        Route.SETTINGS->SettingsScreen(s,model,onPermissions,onPhoneSettings,onNotifications,onBatteryOptimization)
                    }}}
                    }
                }
        }
        if(read)BottomNav(displayedRoute,model::navigate,model.navigationBlocked||gate!=ScreenGate.OPEN,navItemHeight,
            Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom=BottomNavBottomGap))
    }
    if(sheetOpen)Sheets(s,model,onSupport,onPermissions,onPickMemberFile,onPreviewMemberFile,onTakeMemberPhoto,onPickMemberPhoto,onExport=openExport)
    if(exportVisible&&read&&gate==ScreenGate.OPEN&&presentation.showRecords&&model.canExportListing){
        ListingExportSheet(model,onPick={format->exportVisible=false;onExport(format)},onDismiss={exportVisible=false})
    }
}

/** Initial restoration is an opaque branded surface, never a disabled login
 * form or private records. The real signed-out login renders after resolution. */
@Composable internal fun BuriSplash(error:String?=null,retry:(()->Unit)?=null,signOut:(()->Unit)?=null,loading:Boolean=false,loadingLabel:String="Getting things ready"){
    val t=LocalUiText.current
    Box(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding().testTag("burimunsi-splash"),contentAlignment=Alignment.Center){
        Column(Modifier.fillMaxWidth().padding(32.dp),horizontalAlignment=Alignment.CenterHorizontally){
            Image(painterResource(R.drawable.burimunsi_brand_logo),"BuriMunsi",Modifier.widthIn(max=280.dp).fillMaxWidth().aspectRatio(3f))
            if(loading){Spacer(Modifier.height(24.dp));BuriInlineLoading(loadingLabel,Modifier.widthIn(max=280.dp))}
            if(error!=null){Spacer(Modifier.height(28.dp));Text(t(error),color=BuriTheme.Muted,fontSize=16.sp,textAlign=TextAlign.Center)}
            if(retry!=null){Spacer(Modifier.height(18.dp));TextButton(retry){CompactLabel(t("Retry"))}}
            if(signOut!=null)TextButton(signOut){CompactLabel(t("Sign out"))}
        }
    }
}

@Composable private fun Header(s:UiState,m:BuriController,onSupport:()->Unit){
    val t=LocalUiText.current
    val enabled=!s.busy&&m.screenGate==ScreenGate.OPEN
    Row(Modifier.fillMaxWidth().heightIn(min=62.dp).padding(horizontal=16.dp,vertical=6.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){
        when(s.route){
            Route.LOGIN->{Spacer(Modifier.weight(1f));RoundAction(R.drawable.ic_help,t("Contact admin on WhatsApp"),onSupport,enabled,size=48,tonal=false)}
            Route.PAYMENT,Route.MEMBER->{
                RoundAction(R.drawable.ic_back,t("Back"),m::back,enabled,size=48,tonal=false)
                CompactLabel(t(titleFor(s.route)),Modifier.weight(1f),fontSize=16.sp,color=BuriTheme.Muted,textAlign=TextAlign.Center)
                Spacer(Modifier.width(48.dp))
            }
            else->{
                when(s.route){
                    Route.HOME->{Brand();Spacer(Modifier.weight(1f))}
                    Route.SMS->{RoundAction(R.drawable.ic_back,t("Back to Home"),{m.navigate(Route.HOME)},enabled,size=48,tonal=false);Spacer(Modifier.weight(1f))}
                    else->CompactLabel(t(titleFor(s.route)),Modifier.weight(1f).semantics{heading()},style=MaterialTheme.typography.headlineMedium)
                }
                if(s.route==Route.HOME&&s.operator!=null)RoundAction(R.drawable.ic_sync,t("Refresh"),m::refresh,enabled,size=48,tonal=false)
                if(s.route==Route.MEMBERS&&m.allows(Capability.ENROLL))RoundAction(R.drawable.ic_plus,t("Add member"),{m.openSheet(Sheet.ENROLL)},enabled&&!s.offline,size=48)
                if(s.route==Route.PAYMENTS)RoundAction(R.drawable.ic_filter,t("Payment filters"),{m.openSheet(Sheet.FILTERS)},enabled,size=48)
                when(s.route){
                    Route.SETTINGS->RoundAction(R.drawable.ic_out,t("Sign out"),m::logout,enabled,size=48,tonal=false)
                    Route.SMS->RoundAction(R.drawable.ic_device,t("Gateway status"),{m.openSheet(Sheet.GATEWAY)},enabled,size=48)
                    else->IconButton({m.openSheet(Sheet.PROFILE)},enabled=enabled,modifier=Modifier.size(48.dp).semantics{contentDescription=t("Your profile")}){Avatar(s.operator?.name.orEmpty(),42)}
                }
            }
        }
    }
}
@Composable private fun BottomNav(current:Route,onNavigate:(Route,String?)->Unit,busy:Boolean,itemHeight:Dp,modifier:Modifier=Modifier){
    val t=LocalUiText.current
    val active=when(current){Route.PAYMENT->Route.PAYMENTS;Route.MEMBER->Route.MEMBERS;Route.SMS->Route.HOME;else->current}
    Row(modifier.widthIn(max=520.dp).fillMaxWidth().padding(horizontal=16.dp)
        .background(BuriTheme.NavigationSurface,RoundedCornerShape(34.dp)).padding(BottomNavVerticalPadding),horizontalArrangement=Arrangement.spacedBy(4.dp)){
        for(route in listOf(Route.HOME,Route.MEMBERS,Route.PAYMENTS,Route.SETTINGS)){
            val chosen=active==route
            val label=t(titleFor(route))
            val color=if(chosen)BuriTheme.Text else BuriTheme.NavigationMuted
            val action=focusAction("navigation:${route.name}"){onNavigate(route,null)}
            IconButton(onClick=action.click,enabled=!busy,modifier=action.modifier.weight(1f).height(itemHeight)
                .background(if(chosen)BuriTheme.NavigationSelected else Color.Transparent,RoundedCornerShape(28.dp))
                .semantics{selected=chosen;role=SemanticRole.Tab;contentDescription=label}){
                Column(horizontalAlignment=Alignment.CenterHorizontally){
                    Glyph(iconFor(route),null,color,24)
                    CompactLabel(label,Modifier.clearAndSetSemantics{},fontSize=11.sp,lineHeight=14.sp,color=color)
                }
            }
        }
    }
}
