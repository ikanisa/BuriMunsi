package rw.ikanisa.burimunsi.crosslayertests

import android.app.Application
import androidx.lifecycle.onFixtureMain
import androidx.lifecycle.viewModelScope
import app.cool.mobile.BuildConfig
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.data.ApiClient
import rw.ikanisa.burimunsi.data.ApiFailure
import rw.ikanisa.burimunsi.data.NativeRepository
import rw.ikanisa.burimunsi.data.NativeRecordCache
import rw.ikanisa.burimunsi.data.Transport
import rw.ikanisa.burimunsi.gateway.GatewayFixture
import rw.ikanisa.burimunsi.storage.SecureStore
import rw.ikanisa.burimunsi.ui.BuriViewModel
import rw.ikanisa.burimunsi.ui.Sheet

private val flavor = if (BuildConfig.IS_GATEWAY) "internal_receiver" else "staff"

private class HeldCheckpoint(private val bookmark: NavigationCheckpoint) : NavigationCheckpointStore {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    override fun read(): String {
        entered.countDown()
        check(release.await(10, TimeUnit.SECONDS))
        return bookmark.encode()
    }
    override fun write(value: String) = Unit
    override fun clear() = Unit
}

internal class SessionScenario {
    val app = Application()
    var owner = "operator-a"
    var group = "group-a"
    var role = if (BuildConfig.IS_GATEWAY) "admin" else "staff"
    var capabilities = listOf(Capability.READ)
    var token = "a".repeat(64)
    var profileUnavailable = false
    var sessionDeadline: Long? = null
    private val profile get() = JSONObject().put("id", owner).put("name", "Synthetic Operator")
        .put("phone", "+250780000001").put("role", role)
        .put("capabilities", JSONArray().also { array -> capabilities.forEach { array.put(it.key) } })

    init {
        SecureStore.reset()
        Transport.calls.clear()
        Transport.handler = { request ->
            when {
                request.path.endsWith("/session/logout") -> JSONObject().put("signedOut", true).toString()
                profileUnavailable && request.path.endsWith("/session") -> throw ApiFailure("connection_unavailable", 0)
                request.path.endsWith("/session/login") || request.path.endsWith("/session") ->
                    JSONObject().put("profile", profile).put("token", token).put("groupId", group)
                        .put("expiresAt", sessionDeadline ?: (System.currentTimeMillis() + 3_600_000)).toString()
                request.path.endsWith("/home?include=savings") -> throw ApiFailure("contract_query", 400)
                request.path.endsWith("/home") -> JSONObject().put("paymentCount", 0)
                    .put("memberCount", 0).put("unallocatedCount", 0).put("recentPayments", JSONArray())
                    .put("asOf", "2026-11-20T00:00:00Z").toString()
                request.path.contains("/staff?") -> JSONObject().put("items", JSONArray()).put("totalCount", 0)
                    .put("revision", "fixture-1").put("asOf", "2026-11-20T00:00:00Z")
                    .put("nextCursor", JSONObject.NULL).toString()
                else -> error("Unexpected synthetic session request")
            }
        }
    }

    fun repository() = NativeRepository(app, ApiClient.phonePin("https://offline.test", "fixture-device", flavor, "") { "fixture" })
    fun signIn(repository: NativeRepository) = repository.login("0780000001", "2468")
}

private const val SAVINGS_HOME_PATH="/v1/burimunsi/home?include=savings"
private const val SAVINGS_SESSION_PATH="/v1/burimunsi/session?include=home_savings"
private const val LEGACY_HOME_SESSION_PATH="/v1/burimunsi/session?include=home"

private fun memberFixture(group:String)=JSONObject().put("id","member-1").put("groupId",group)
    .put("name","Synthetic Member").put("phone","+250780000816").put("active",true).put("version",1)

private fun paymentFixture(id:String,group:String)=JSONObject().put("id",id).put("groupId",group)
    .put("memberId",JSONObject.NULL).put("memberPhone",JSONObject.NULL).put("sourceId",JSONObject.NULL)
    .put("payerNameRaw","Synthetic").put("payerPhoneRaw","+250780000816")
    .put("amountRwf",137L).put("atRaw","2026-11-20 08:00:00").put("ftId",id)
    .put("state","unallocated").put("version",1)

private fun pageFixture(row:JSONObject)=JSONObject().put("items",JSONArray().put(row)).put("totalCount",1)
    .put("revision","fresh").put("asOf","2026-11-20T00:00:00Z").put("nextCursor",JSONObject.NULL).toString()

private fun SessionScenario.held() = HeldCheckpoint(NavigationCheckpoint(owner, group, System.currentTimeMillis(), Route.SETTINGS))

private suspend fun idle(model: BuriViewModel) {
    withTimeout(10_000) { while (model.state.starting || model.state.busy) delay(2) }
    model.viewModelScope.launch {}.join()
}

private suspend fun stop(model: BuriViewModel) = model.viewModelScope.coroutineContext[Job]!!.cancelAndJoin()

private enum class Replacement { NONE, SAME_OWNER, OTHER_GROUP }

private suspend fun interruptedRestore(replacement: Replacement) {
    val scenario = SessionScenario()
    val original = scenario.repository()
    scenario.signIn(original)
    val checkpoint = scenario.held()
    val receiverStarts = GatewayFixture.uploadStarts
    val model = BuriViewModel(scenario.app, checkpoint, System::currentTimeMillis)
    try {
        check(checkpoint.entered.await(10, TimeUnit.SECONDS))
        if (replacement == Replacement.SAME_OWNER) {
            model.onFixtureMain { onForeground() }
            // The receiver's independent foreground permission check may
            // schedule one start before the checkpoint returns.
            if (BuildConfig.IS_GATEWAY) withTimeout(5_000) {
                while (GatewayFixture.uploadStarts == receiverStarts) delay(2)
            }
        }
        val startsBeforeRestore = GatewayFixture.uploadStarts
        original.logout()
        if (replacement != Replacement.NONE) {
            scenario.role = "staff"
            if (replacement == Replacement.OTHER_GROUP) scenario.group = "group-b"
            scenario.signIn(original)
        }
        model.viewModelScope.launch {}.join()
        checkpoint.release.countDown()
        idle(model)
        check(model.state.route != Route.SETTINGS) { "A superseded restore displayed the old Settings route" }
        check(GatewayFixture.uploadStarts == startsBeforeRestore) { "An interrupted restore started Sync" }
        check(Transport.calls.none { it.method != "GET" && !it.path.contains("/session/") })
        if (replacement == Replacement.SAME_OWNER) {
            // Identical subject, group and token still need a new server profile and records request.
            check(original.current()?.role == Role.STAFF)
            check(model.state.operator?.role == Role.STAFF && model.state.route == Route.HOME && model.state.home != null)
            check(model.screenGate==ScreenGate.OPEN&&model.presentation.showRecords)
            check(model.onFixtureMain { consumeFreshDraw(Route.HOME,checkNotNull(state.home)) })
            check(!model.allows(Capability.GATEWAY))
            check(Transport.calls.count { it.method == "GET" && it.path.endsWith("/session") } == 1)
        } else {
            check(model.state.route == Route.LOGIN && model.state.operator == null &&
                model.state.gateway == null && !model.presentation.showRecords)
            if (replacement == Replacement.OTHER_GROUP) {
                check(original.current()?.id == scenario.owner && original.boundCollectionId == scenario.group)
                check(Transport.calls.none { it.path.endsWith("/home") })
                return
            }
            scenario.owner = "operator-b"
            scenario.group = "group-b"
            scenario.token = "b".repeat(64)
            model.login("0780000002", "1357")
            idle(model)
            check(model.state.operator?.id == scenario.owner && model.state.home != null)
            val home = Transport.calls.last { it.path.endsWith("/home") }
            check(home.context["groupId"] == scenario.group && home.context["actorId"] == scenario.owner)
        }
    } finally {
        checkpoint.release.countDown()
        stop(model)
    }
}

private suspend fun grantsNarrowed() {
    val scenario = SessionScenario()
    scenario.role = "admin"
    scenario.capabilities = listOf(Capability.READ, Capability.STAFF, Capability.GATEWAY)
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        model.login("0780000001", "2468")
        idle(model)
        model.openSheet(Sheet.STAFF)
        idle(model)
        check(model.state.sheet == Sheet.STAFF && model.state.staff != null)
        val staffReads = Transport.calls.count { it.path.contains("/staff?") }
        scenario.role = "staff"
        scenario.capabilities = listOf(Capability.READ)
        model.refreshSession()
        idle(model)
        check(model.state.operator?.role == Role.STAFF && model.state.sheet == null && model.state.staff == null)
        check(model.state.home != null && !model.allows(Capability.STAFF) && !model.allows(Capability.GATEWAY))
        check(Transport.calls.count { it.path.contains("/staff?") } == staffReads)
    } finally { stop(model) }
}

private suspend fun peerNarrowsGrant() {
    val scenario = SessionScenario()
    scenario.role = "admin"
    val peer = scenario.repository()
    scenario.signIn(peer)
    val checkpoint = scenario.held()
    val receiverStarts = GatewayFixture.uploadStarts
    val model = BuriViewModel(scenario.app, checkpoint, System::currentTimeMillis)
    try {
        check(checkpoint.entered.await(10, TimeUnit.SECONDS))
        scenario.role = "staff"
        check(peer.refreshSession().role == Role.STAFF)
        model.viewModelScope.launch {}.join()
        checkpoint.release.countDown()
        idle(model)
        check(model.state.operator?.role == Role.STAFF && model.state.route == Route.HOME && model.state.home != null &&
            !model.allows(Capability.GATEWAY) && GatewayFixture.uploadStarts == receiverStarts) {
            "A previous role survived another activity's grant refresh"
        }
        check(peer.current()?.role == Role.STAFF)
    } finally {
        checkpoint.release.countDown()
        stop(model)
    }
}

private suspend fun retrySavedSession() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    scenario.profileUnavailable = true
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        check(model.state.operator == null && model.state.savedSessionPending)
        val reads = Transport.calls.count { it.path.endsWith("/session") }
        scenario.profileUnavailable = false
        model.refresh() // The saved-session splash Retry action.
        idle(model)
        check(model.state.operator?.id == scenario.owner && model.state.home != null && !model.state.savedSessionPending)
        check(Transport.calls.count { it.path.endsWith("/session") } == reads + 1)
        check(Transport.calls.count { it.path.endsWith("/session/login") } == 1)
    } finally { stop(model) }
}

private suspend fun cancelBootstrap() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    val checkpoint = scenario.held()
    val receiverStarts = GatewayFixture.uploadStarts
    val model = BuriViewModel(scenario.app, checkpoint, System::currentTimeMillis)
    try {
        check(checkpoint.entered.await(10, TimeUnit.SECONDS))
        model.viewModelScope.coroutineContext[Job]!!.cancel()
        checkpoint.release.countDown()
        stop(model)
        check(model.state.operator == null && GatewayFixture.uploadStarts == receiverStarts)
        check(Transport.calls.none { it.path.endsWith("/home") || it.path.contains("/operations/") })
    } finally {
        checkpoint.release.countDown()
        stop(model)
    }
}

private suspend fun renewedDeadlineKeepsScope() {
    val scenario = SessionScenario()
    val peer = scenario.repository()
    scenario.signIn(peer)
    val revision = peer.sessionRevision
    val checkpoint = scenario.held()
    val model = BuriViewModel(scenario.app, checkpoint, System::currentTimeMillis)
    try {
        check(checkpoint.entered.await(10, TimeUnit.SECONDS))
        peer.refreshSession()
        check(peer.sessionRevision == revision)
        model.viewModelScope.launch {}.join()
        checkpoint.release.countDown()
        idle(model)
        check(model.state.operator?.id == scenario.owner && model.state.route == Route.SETTINGS)
        check(Transport.calls.count { it.path.endsWith("/session") } == 2)
    } finally {
        checkpoint.release.countDown()
        stop(model)
    }
}

private suspend fun equalProfileRefresh() {
    val scenario = SessionScenario()
    scenario.sessionDeadline = System.currentTimeMillis() + 3_600_000
    scenario.capabilities = listOf(Capability.READ)
    scenario.signIn(scenario.repository())
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        val before = checkNotNull(model.state.operator)
        model.onFixtureMain { refreshSession() }
        idle(model)
        val refreshed = checkNotNull(model.state.operator)
        check(before == refreshed && before !== refreshed) { "The screen kept an obsolete profile instance" }
        check(model.state.home != null && model.allows(Capability.READ))
        if (BuildConfig.IS_GATEWAY) {
            val permissions = kotlinx.coroutines.CompletableDeferred<Array<String>>()
            model.onFixtureMain { requestReceivingPermissions { permissions.complete(it) } }
            check(withTimeout(5_000) { permissions.await() }.contains(android.Manifest.permission.READ_SMS))
        } else {
            check(!model.allows(Capability.GATEWAY))
        }
    } finally { stop(model) }
}

private suspend fun legacyProfileRestores() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    val saved = JSONObject(SecureStore.records.getValue("session"))
    saved.put("profile", JSONObject().put("id", scenario.owner))
    SecureStore.records["session"] = saved.toString()
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        check(model.state.operator?.id == scenario.owner && model.state.home != null)
        check(JSONObject(SecureStore.records.getValue("session")).getJSONObject("profile").getString("role") == scenario.role)
    } finally { stop(model) }
}

private suspend fun bundledHomeRestores() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    Transport.sessionHome = { request ->
        val session = Transport.handler(request.copy(path = "/v1/burimunsi/session"))
        val home = Transport.handler(request.copy(path = "/v1/burimunsi/home"))
        JSONObject(session).put("home", JSONObject(home).put("paymentCount", 250L)).toString()
    }
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        check(model.state.operator?.id == scenario.owner && model.state.home?.paymentCount == 250)
        check(Transport.calls.count { it.path.endsWith("/session?include=home") } == 1)
        check(Transport.calls.count { it.path == SAVINGS_SESSION_PATH } == 1)
        check(Transport.calls.none { it.path.endsWith("/home") || it.path.endsWith("/session") })
        val saved = checkNotNull(NativeRecordCache(scenario.app).read("/home")).getJSONObject("entries").getJSONObject("/home")
        check(JSONObject(saved.getString("payload")).getLong("paymentCount") == 250L)
        model.onFixtureMain{onForeground()}
        idle(model)
        check(Transport.calls.count{it.path==SAVINGS_SESSION_PATH}==1)
        check(Transport.calls.count{it.path==LEGACY_HOME_SESSION_PATH}==2)
    } finally {
        stop(model)
        Transport.sessionHome = null
    }
}

private suspend fun savingsBundleRestoresInOneRead(includesSavings:Boolean) {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    Transport.calls.clear()
    val normal = Transport.handler
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val savings = HomeSavings(8400L,0L,null,"unavailable")
    Transport.sessionHomeSavings = { request ->
        entered.countDown()
        check(release.await(5,TimeUnit.SECONDS))
        val home = JSONObject(normal(request.copy(path="/v1/burimunsi/home")))
        if(includesSavings)home.put("savings",JSONObject().put("lifetimeContributionsRwf",8400L)
            .put("outgoingPaymentsRwf",0L).put("latestWalletBalanceRwf",JSONObject.NULL)
            .put("reconciliationStatus","unavailable"))
        JSONObject(normal(request.copy(path="/v1/burimunsi/session"))).put("home",home).toString()
    }
    val model = BuriViewModel(scenario.app)
    try {
        check(entered.await(5,TimeUnit.SECONDS))
        model.onFixtureMain{onForeground()}
        check(model.state.operator==null&&!model.presentation.showRecords)
        release.countDown()
        idle(model)
        check(model.state.home?.paymentCount==0&&model.state.home?.savings==savings.takeIf{includesSavings})
        check(model.presentation.showRecords&&!model.state.homeSavingsLoading)
        check(Transport.calls.map{it.path}==listOf(SAVINGS_SESSION_PATH))
        val before=Transport.calls.size
        model.onFixtureMain{onBackground();onForeground()}
        idle(model)
        check(Transport.calls.drop(before).map{it.path}==listOf(SAVINGS_SESSION_PATH))
    } finally {
        release.countDown()
        stop(model)
        Transport.sessionHomeSavings=null
    }
}

private suspend fun warmRoutesReuseVerifiedAuthority() {
    val scenario=SessionScenario()
    scenario.signIn(scenario.repository())
    val normal=Transport.handler
    val profileEntered=CountDownLatch(1)
    val profileRelease=CountDownLatch(1)
    val paymentEntered=CountDownLatch(1)
    val paymentRelease=CountDownLatch(1)
    val holdProfile=java.util.concurrent.atomic.AtomicBoolean()
    Transport.handler={ request ->
        when {
            request.path=="/v1/burimunsi/session"&&holdProfile.get() -> {
                profileEntered.countDown()
                check(profileRelease.await(5,TimeUnit.SECONDS))
                normal(request)
            }
            request.path.contains("/payments?") -> pageFixture(paymentFixture("payment-1",scenario.group))
            request.path.endsWith("/payments/payment-1") -> paymentFixture("payment-1",scenario.group).toString()
            request.path.endsWith("/payments/payment-2") -> {
                paymentEntered.countDown()
                check(paymentRelease.await(5,TimeUnit.SECONDS))
                paymentFixture("payment-2",scenario.group).toString()
            }
            request.path.contains("/members?") -> pageFixture(memberFixture(scenario.group))
            request.path.endsWith("/members/member-1") -> memberFixture(scenario.group).toString()
            else -> normal(request)
        }
    }
    val model=BuriViewModel(scenario.app)
    suspend fun go(route:Route,id:String?=null) {model.onFixtureMain{navigate(route,id)};idle(model)}
    suspend fun back() {model.onFixtureMain{this.back()};idle(model)}
    try {
        idle(model)
        model.onFixtureMain{onForeground()}
        idle(model)
        val initialHome=Transport.calls.size
        go(Route.HOME)
        check(Transport.calls.size==initialHome)
        go(Route.PAYMENTS);go(Route.PAYMENT,"payment-1");back()
        go(Route.MEMBERS);go(Route.MEMBER,"member-1");back()
        go(Route.PAYMENTS)
        check(model.state.payments?.items?.size==1)

        val first=Transport.calls.size
        holdProfile.set(true)
        model.onFixtureMain{onBackground();onForeground()}
        check(profileEntered.await(5,TimeUnit.SECONDS))
        check(model.screenGate!=ScreenGate.OPEN&&!model.presentation.showRecords)
        model.onFixtureMain{navigate(Route.MEMBERS)}
        check(model.state.route==Route.PAYMENTS)
        profileRelease.countDown()
        idle(model)
        go(Route.PAYMENT,"payment-1")
        check(model.state.payment?.id=="payment-1"&&model.presentation.showRecords)
        back();go(Route.MEMBERS);go(Route.MEMBER,"member-1")
        check(model.state.member?.id=="member-1"&&model.presentation.showRecords)
        val paths=Transport.calls.drop(first).map{it.path}
        check(paths==listOf("/v1/burimunsi/session")){"warm flow issued ${paths.size} requests"}

        model.onFixtureMain{navigate(Route.PAYMENT,"payment-2")}
        check(paymentEntered.await(5,TimeUnit.SECONDS))
        check(model.state.busy&&!model.navigationBlocked)
        model.onFixtureMain{navigate(Route.PAYMENTS)}
        check(model.requestedRoute==Route.PAYMENTS)
        paymentRelease.countDown()
        idle(model)
        check(model.state.route==Route.PAYMENTS&&model.state.payment==null&&model.requestedRoute==null)
    } finally { profileRelease.countDown();paymentRelease.countDown();stop(model) }
}

private suspend fun freshRowsPublishWhileRecordCacheIsBlocked() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    Transport.calls.clear()
    val normal = Transport.handler
    Transport.sessionHome = { request ->
        JSONObject(normal(request.copy(path="/v1/burimunsi/session")))
            .put("home",JSONObject(normal(request.copy(path="/v1/burimunsi/home")))).toString()
    }
    Transport.handler = { request ->
        when {
            request.path.contains("/payments?") -> pageFixture(paymentFixture("payment-1",scenario.group))
            request.path.endsWith("/payments/payment-1") -> paymentFixture("payment-1",scenario.group).toString()
            request.path.contains("/members?") -> pageFixture(memberFixture(scenario.group))
            request.path.endsWith("/members/member-1") -> memberFixture(scenario.group).toString()
            else -> normal(request)
        }
    }
    val entered=CountDownLatch(1)
    val release=CountDownLatch(1)
    SecureStore.beforeWrite={ name ->
        if(name=="records"){entered.countDown();check(release.await(10,TimeUnit.SECONDS))}
    }
    val model=BuriViewModel(scenario.app)
    try {
        check(entered.await(5,TimeUnit.SECONDS))
        withTimeout(2_000){while(model.state.busy || model.state.home==null)delay(2)}
        check(Transport.calls.filterNot { it.path==SAVINGS_HOME_PATH }.map { it.path }==
            listOf(SAVINGS_SESSION_PATH, LEGACY_HOME_SESSION_PATH))
        val lookup=java.util.concurrent.CompletableFuture.supplyAsync { NativeRecordCache(scenario.app).read("/home") }
        check(runCatching { lookup.get(250,TimeUnit.MILLISECONDS) }.exceptionOrNull() is java.util.concurrent.TimeoutException)
        for((route,id) in listOf(Route.PAYMENTS to null,Route.PAYMENT to "payment-1",
            Route.MEMBERS to null,Route.MEMBER to "member-1")) {
            val requests=Transport.calls.size
            model.onFixtureMain{navigate(route,id)}
            withTimeout(2_000){while(model.state.busy||model.state.route!=route||!model.presentation.showRecords)delay(2)}
            check(Transport.calls.size==requests+1&&!model.state.offline)
        }
        release.countDown()
        check(lookup.get(5,TimeUnit.SECONDS)!=null)
    } finally {
        release.countDown()
        SecureStore.beforeWrite=null
        Transport.sessionHome=null
        stop(model)
    }
}

/** Pause after the old session's request has gone out, then retire its
 * grant before releasing a syntactically valid (but no longer owned) reply. */
private suspend fun delayedRecordReadCannotCrossBoundary(route: Route, replacement: Replacement) {
    val scenario = SessionScenario()
    if(replacement==Replacement.SAME_OWNER)scenario.capabilities=listOf(Capability.READ,Capability.ALLOCATE)
    val previous = scenario.repository()
    scenario.signIn(previous)
    val oldToken = scenario.token
    val newToken = "b".repeat(64)
    val oldGroup = scenario.group
    val newGroup = if(replacement==Replacement.OTHER_GROUP)"group-b" else oldGroup
    val oldOwner = scenario.owner
    val oldPayment = "old-unique-payment"
    val newPayment = "new-unique-payment"
    val requestEntered = CountDownLatch(1)
    val responseReleased = CountDownLatch(1)
    val arm = java.util.concurrent.atomic.AtomicBoolean(false)
    val normal = Transport.handler
    fun payment(id:String, group:String) = JSONObject().put("id",id).put("groupId",group)
        .put("memberId",JSONObject.NULL).put("memberPhone",JSONObject.NULL).put("sourceId",JSONObject.NULL)
        .put("payerNameRaw","Synthetic").put("payerPhoneRaw","+250780000816")
        .put("amountRwf",137L).put("atRaw","2026-11-20 08:00:00").put("ftId",id)
        .put("state","unallocated").put("version",1)
    fun paymentPage(id:String, group:String) = JSONObject()
        .put("items",JSONArray().put(payment(id,group))).put("totalCount",1)
        .put("revision",id).put("nextCursor",JSONObject.NULL).put("asOf","2026-11-20T00:00:00Z").toString()
    Transport.handler = { req ->
        val home = req.path.endsWith("/home")
        val payments = req.path.contains("/payments?")
        if (arm.get() && req.token == oldToken && ((route == Route.HOME && home) || (route == Route.PAYMENTS && payments))) {
            requestEntered.countDown()
            check(responseReleased.await(10,TimeUnit.SECONDS))
            if(home) JSONObject(normal(req)).put("paymentCount",271L).toString()
            else paymentPage(oldPayment,oldGroup)
        } else if(req.token == newToken && home)
            JSONObject(normal(req)).put("paymentCount",31L).toString()
        else if(req.token == newToken && payments) paymentPage(newPayment,newGroup)
        else normal(req)
    }
    Transport.sessionHome = null
    val model = BuriViewModel(scenario.app)
    var newModel:BuriViewModel?=null
    val publishedStale=java.util.concurrent.atomic.AtomicBoolean(false)
    fun containsStale(state:rw.ikanisa.burimunsi.ui.UiState) =
        state.home?.paymentCount==271 || state.payments?.items.orEmpty().any{it.id==oldPayment}
    try {
        idle(model)
        val originalOwner=checkNotNull(model.state.operator)
        check(originalOwner.id==oldOwner && model.state.home?.paymentCount==0)
        androidx.compose.runtime.snapshots.Snapshot.onCommittedValue={value->
            if(value is rw.ikanisa.burimunsi.ui.UiState && containsStale(value))publishedStale.set(true)
        }
        arm.set(true)
        model.onFixtureMain { if(route==Route.HOME)refresh()else navigate(route) }
        check(requestEntered.await(5,TimeUnit.SECONDS))
        check(model.state.operator?.id==oldOwner && Transport.calls.any { it.token==oldToken })
        previous.logout()
        if(replacement!=Replacement.NONE) {
            if(replacement==Replacement.OTHER_GROUP)scenario.owner="operator-b"
            scenario.group=newGroup; scenario.token=newToken
            scenario.capabilities=listOf(Capability.READ)
            scenario.signIn(scenario.repository())
            val latest=BuriViewModel(scenario.app); newModel=latest
            idle(latest)
            val authorized=checkNotNull(latest.state.operator)
            check(authorized.id==scenario.owner && latest.state.home?.paymentCount==31)
            check(authorized.capabilities==setOf(Capability.READ.key) && authorized!==originalOwner)
            if(route==Route.PAYMENTS) {
                latest.onFixtureMain { navigate(Route.PAYMENTS) }
                idle(latest)
                check(latest.state.payments?.items?.map{it.id}==listOf(newPayment))
            }
        }
        responseReleased.countDown()
        idle(model)
        check(model.state.operator!==originalOwner && !containsStale(model.state) && !publishedStale.get())
        newModel?.let { survivor ->
            check(survivor.state.operator?.id==scenario.owner)
            if(route==Route.PAYMENTS) check(survivor.state.payments?.items?.map{it.id}==listOf(newPayment))
            else check(survivor.state.home?.paymentCount==31)
        }
        val cache=NativeRecordCache(scenario.app)
        val path = if(route==Route.HOME) "/home" else Transport.calls.last { it.token==oldToken && it.path.contains("/payments?") }.path.removePrefix("/v1/burimunsi")
        val cached=cache.read(path)?.optJSONObject("entries")?.optJSONObject(path)?.getString("payload")?.let(::JSONObject)
        if(cached!=null) {
            if(route==Route.HOME)check(cached.getLong("paymentCount")!=271L)
            else {
                val rows=cached.getJSONArray("items")
                check((0 until rows.length()).none { rows.getJSONObject(it).getString("id")==oldPayment })
            }
        }
        if(replacement==Replacement.NONE) check(model.state.operator==null)
    } finally {
        androidx.compose.runtime.snapshots.Snapshot.onCommittedValue=null
        responseReleased.countDown()
        newModel?.let { stop(it) }
        stop(model)
    }
}

private suspend fun settingsRestoreSkipsUnusedHome() {
    val scenario = SessionScenario()
    scenario.signIn(scenario.repository())
    Transport.calls.clear()
    val checkpoint = scenario.held()
    checkpoint.release.countDown()
    val model = BuriViewModel(scenario.app, checkpoint, System::currentTimeMillis)
    try {
        idle(model)
        check(model.state.route == Route.SETTINGS && model.state.operator?.id == scenario.owner)
        check(Transport.calls.map { it.path } == listOf("/v1/burimunsi/session"))
    } finally { stop(model) }
}

private suspend fun loginHomeRequests(include: Boolean, oldServer: Boolean = false, uncertain: Boolean = false) {
    val scenario = SessionScenario()
    Transport.loginHome = { request ->
        if(uncertain)throw ApiFailure("connection_unavailable",0,true)
        if(oldServer)throw ApiFailure("invalid_query",400)
        val login = Transport.handler(request.copy(path = "/v1/burimunsi/session/login"))
        val home = if(include)JSONObject(Transport.handler(request.copy(path = "/v1/burimunsi/home")))
            .put("paymentCount",300L) else JSONObject.NULL
        JSONObject(login).put("home",home).toString()
    }
    val model=BuriViewModel(scenario.app)
    try {
        idle(model)
        model.onFixtureMain { login("0780000001","2468") }
        idle(model)
        val bundled="/v1/burimunsi/session/login?include=home"
        val expected=when {
            uncertain||include->listOf(bundled)
            oldServer->listOf(bundled,"/v1/burimunsi/session/login","/v1/burimunsi/home")
            else->listOf(bundled,"/v1/burimunsi/home")
        }
        check(Transport.calls.filterNot{it.path==SAVINGS_HOME_PATH}.map{it.path}==expected)
        if(uncertain)check(model.state.operator==null&&model.state.home==null)
        else check(model.state.operator?.id==scenario.owner&&model.state.home?.paymentCount==(if(include)300 else 0))
    } finally {
        stop(model)
        Transport.loginHome=null
    }
}

private suspend fun bundledHomeEnhancementCannotBlockOrCrossSignOut(signOut:Boolean) {
    val scenario = SessionScenario()
    val normal = Transport.handler
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    Transport.loginHome = { request ->
        val base = normal(request.copy(path="/v1/burimunsi/home"))
        val login = normal(request.copy(path="/v1/burimunsi/session/login"))
        JSONObject(login).put("home",JSONObject(base)).toString()
    }
    Transport.handler = { request ->
        if(request.path != SAVINGS_HOME_PATH) normal(request)
        else {
            entered.countDown()
            check(release.await(5,TimeUnit.SECONDS))
            val base = normal(request.copy(path="/v1/burimunsi/home"))
            JSONObject(base).put("savings",JSONObject().put("lifetimeContributionsRwf",8425L)
                .put("outgoingPaymentsRwf",JSONObject.NULL).put("latestWalletBalanceRwf",JSONObject.NULL)
                .put("reconciliationStatus","unavailable")).toString()
        }
    }
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        model.onFixtureMain { login("0780000001","2468") }
        check(entered.await(4,TimeUnit.SECONDS))
        idle(model)
        check(model.state.operator?.id == scenario.owner && model.state.home?.paymentCount == 0 &&
            model.state.home?.savings == null)
        val originalSavedAt = model.state.savedAt
        if(signOut) {
            model.onFixtureMain { logout() }
            idle(model)
            check(model.state.operator == null && model.state.home == null)
        }
        release.countDown()
        if(signOut) {
            stop(model)
            check(model.state.operator==null && model.state.home==null && "records" !in SecureStore.records)
        } else {
            withTimeout(4_000) { while(model.state.home?.savings==null) delay(2) }
            check(model.state.home?.savings==HomeSavings(8425L,null,null,"unavailable"))
            check(model.state.savedAt==originalSavedAt)
        }
        check(Transport.calls.count{it.path==SAVINGS_HOME_PATH}==1)
        check(Transport.calls.none{it.path=="/v1/burimunsi/home"})
    } finally {
        release.countDown()
        stop(model)
        Transport.loginHome=null
    }
}

private suspend fun bundledHomeEnhancementOnlyRedactsConfirmedDenial(confirmed:Boolean) {
    val scenario=SessionScenario()
    val original=Transport.handler
    Transport.loginHome = { request ->
        val home=original(request.copy(path="/v1/burimunsi/home"))
        val login=original(request.copy(path="/v1/burimunsi/session/login"))
        JSONObject(login).put("home",JSONObject(home)).toString()
    }
    Transport.handler={ request ->
        if(request.path==SAVINGS_HOME_PATH) throw ApiFailure(
            if(confirmed) "invalid_session" else "gateway_temporarily_unavailable",401)
        original(request)
    }
    val model=BuriViewModel(scenario.app)
    try {
        idle(model)
        model.onFixtureMain {login("0780000001","2468")}
        idle(model)
        withTimeout(4_000){while(Transport.calls.none{it.path==SAVINGS_HOME_PATH})delay(2)}
        if(confirmed){
            withTimeout(4_000){while(model.state.operator!=null)delay(2)}
            check(model.state.home==null && model.state.error=="Sign in again.")
        } else {
            stop(model)
            check(model.state.operator?.id==scenario.owner && model.state.home?.savings==null)
        }
    } finally {stop(model);Transport.loginHome=null}
}

private suspend fun bundledHomeDenialRevalidatesOnlyWhenConfirmed(confirmed:Boolean) {
    val scenario=SessionScenario()
    val original=Transport.handler
    val revalidationEntered=CountDownLatch(1)
    val revalidationRelease=CountDownLatch(1)
    Transport.loginHome = { request ->
        val home=original(request.copy(path="/v1/burimunsi/home"))
        val login=original(request.copy(path="/v1/burimunsi/session/login"))
        JSONObject(login).put("home",JSONObject(home)).toString()
    }
    Transport.handler={ request ->
        if(request.path==SAVINGS_HOME_PATH) throw ApiFailure(
            if(confirmed) "access_denied" else "gateway_temporarily_unavailable",403)
        if(request.path=="/v1/burimunsi/session"){
            revalidationEntered.countDown()
            check(revalidationRelease.await(5,TimeUnit.SECONDS))
            throw ApiFailure("session_revalidation_unavailable",503)
        }
        original(request)
    }
    val model=BuriViewModel(scenario.app)
    try {
        idle(model)
        model.onFixtureMain {login("0780000001","2468")}
        withTimeout(4_000){while(Transport.calls.none{it.path==SAVINGS_HOME_PATH})delay(2)}
        if(confirmed){
            check(revalidationEntered.await(4,TimeUnit.SECONDS))
            check(model.state.operator?.id==scenario.owner && model.state.home==null && model.state.readbackRequired)
            check("records" !in SecureStore.records)
            check(Transport.calls.map{it.path}==
                listOf("/v1/burimunsi/session/login?include=home",SAVINGS_HOME_PATH,"/v1/burimunsi/session"))
            revalidationRelease.countDown()
            idle(model)
            check(model.state.operator?.id==scenario.owner && model.state.home==null)
        } else {
            idle(model)
            stop(model)
            check(model.state.operator?.id==scenario.owner && model.state.home?.paymentCount==0)
            check(Transport.calls.none{it.path.startsWith("/v1/burimunsi/session?")||it.path=="/v1/burimunsi/session"})
        }
    } finally {revalidationRelease.countDown();stop(model);Transport.loginHome=null}
}

private suspend fun recentHomeStillReadsAuthorizedData() {
    val scenario = SessionScenario()
    val repo = scenario.repository()
    scenario.signIn(repo)
    repo.home()
    val normal = Transport.handler
    Transport.sessionHome = { request ->
        val session = normal(request.copy(path = "/v1/burimunsi/session"))
        val home = normal(request.copy(path = "/v1/burimunsi/home"))
        JSONObject(session).put("home", JSONObject(home).put("paymentCount", 50L)).toString()
    }
    Transport.calls.clear()
    val model = BuriViewModel(scenario.app)
    try {
        idle(model)
        check(model.state.home?.paymentCount == 50 && !model.state.offline)
        check(Transport.calls.filterNot { it.path==SAVINGS_HOME_PATH }.map { it.path } ==
            listOf(SAVINGS_SESSION_PATH, LEGACY_HOME_SESSION_PATH))
        model.onFixtureMain { refresh() }
        idle(model)
        check(model.state.home?.paymentCount == 0 && Transport.calls.count { it.path == "/v1/burimunsi/home" } == 1)
    } finally {
        stop(model)
        Transport.sessionHome = null
    }

    val flag = if (BuildConfig.IS_GATEWAY) Capability.GATEWAY else Capability.ALLOCATE
    scenario.capabilities = listOf(Capability.READ,flag)
    Transport.calls.clear()
    val changed = BuriViewModel(scenario.app)
    try {
        idle(changed)
        check(changed.state.home != null && changed.allows(flag))
        check(Transport.calls.filterNot { it.path==SAVINGS_HOME_PATH }.map { it.path } ==
            listOf(SAVINGS_SESSION_PATH, LEGACY_HOME_SESSION_PATH, "/v1/burimunsi/session", "/v1/burimunsi/home"))
    } finally { stop(changed) }
}

private fun appUpgradeDiscardsOnlyDisplaySnapshots() {
    val scenario = SessionScenario()
    val repo = scenario.repository()
    scenario.signIn(repo)
    repo.home()
    val current = JSONObject(SecureStore.records.getValue("records"))
    check(current.optInt("appVersionCode") == BuildConfig.VERSION_CODE)
    SecureStore.records["pending-command"] = "original command"
    SecureStore.records["receiver-retirement"] = "original receiver obligation"
    SecureStore.records["ui-navigation"] = "original navigation"
    val otherStores = SecureStore.records.filterKeys { it != "records" }
    val server = Transport.handler
    Transport.handler = { throw ApiFailure("connection_unavailable", 0) }
    for (version in listOf(BuildConfig.VERSION_CODE - 1, null)) {
        val predecessor = JSONObject(current.toString())
        if (version == null) predecessor.remove("appVersionCode") else predecessor.put("appVersionCode", version)
        SecureStore.records["records"] = predecessor.toString()
        check(runCatching { repo.home() }.exceptionOrNull()?.let { it is ApiFailure && it.code == "connection_unavailable" } == true)
        check(SecureStore.records == otherStores)
    }
    Transport.handler = server
    repo.home()
    check(JSONObject(SecureStore.records.getValue("records")).optInt("appVersionCode") == BuildConfig.VERSION_CODE)
    Transport.handler = { throw ApiFailure("connection_unavailable", 0) }
    check(repo.homeSnapshot().offline)
}

private fun firstPageCacheRequiresExactQuery() {
    val scenario = SessionScenario()
    val repo = scenario.repository()
    scenario.signIn(repo)
    val other = Transport.handler
    Transport.handler = { request ->
        if (request.path.contains("/payments?") || request.path.contains("/members?"))
            JSONObject().put("items",JSONArray()).put("totalCount",0).put("revision","reviewed-generation")
                .put("asOf","2026-11-20T00:00:00Z").put("nextCursor",JSONObject.NULL).toString()
        else other(request)
    }
    val standard=ListingQuery()
    repo.payments(standard)
    val savedAt=repo.lastReadSavedAt
    repo.members(standard)
    val requests=Transport.calls.size
    check(repo.recentPayments(standard)?.second == savedAt && repo.recentMembers(standard) != null)
    check(repo.recentPayments(standard.copy(sort=ListingSort.OLDEST)) == null)
    check(repo.recentMembers(standard.copy(q="different")) == null)
    check(Transport.calls.size == requests)
    repo.payments(standard)
    check(Transport.calls.size == requests+1)
}

private fun olderQueuedHomeCannotOverwriteNewerLiveHome() {
    val scenario=SessionScenario()
    val foreground=NativeRepository(scenario.app,ApiClient.phonePin("https://offline.test","fixture-device",flavor,""){"fixture"},
        deferDisplayCacheWrites=true)
    scenario.signIn(foreground)
    val second=scenario.repository()
    check(second.restore()!=null)
    val original=Transport.handler
    var balance=10L
    Transport.handler={ request ->
        val response=original(request)
        if(request.path.endsWith("/home"))JSONObject(response).put("paymentCount",balance).toString() else response
    }
    val cache=NativeRecordCache(scenario.app)
    val held=CountDownLatch(1);val release=CountDownLatch(1)
    cache.defer("/test-held-writer",cache.revision()){
        held.countDown()
        check(release.await(5,TimeUnit.SECONDS))
    }
    try {
        check(held.await(5,TimeUnit.SECONDS))
        check(foreground.home().paymentCount==10)
        val older=checkNotNull(foreground.lastReadSavedAt)
        while(System.currentTimeMillis()<=older)Thread.sleep(1)
        balance=20L
        check(second.home().paymentCount==20 && checkNotNull(second.lastReadSavedAt)>older)
    } finally { release.countDown() }
    val stored=checkNotNull(cache.read("/home")).getJSONObject("entries").getJSONObject("/home")
    check(JSONObject(stored.getString("payload")).getLong("paymentCount")==20L)
}

private fun invalidationRejectsOldRecordWrites() {
    val scenario=SessionScenario()
    val first=NativeRecordCache(scenario.app)
    val second=NativeRecordCache(scenario.app)
    val expired=first.revision()
    second.clear(verify=true)
    first.update(expired){error("The invalidated record cannot write")}
    check(first.read("/home")==null)
    val live=first.revision()
    first.update(live){JSONObject().put("payload", "fresh scoped synthetic snapshot")}
    check(second.read("/home")?.getString("payload")=="fresh scoped synthetic snapshot")
    val entered=CountDownLatch(1);val release=CountDownLatch(1);val finished=CountDownLatch(1)
    val staleWrite=java.util.concurrent.atomic.AtomicBoolean(false)
    first.defer("/home",live) {
        try {
            entered.countDown()
            check(release.await(5,TimeUnit.SECONDS))
            first.update(live) { staleWrite.set(true); JSONObject() }
        } finally { finished.countDown() }
    }
    try {
        check(entered.await(5,TimeUnit.SECONDS))
        second.clear(verify=true)
    } finally { release.countDown() }
    check(finished.await(5,TimeUnit.SECONDS) && !staleWrite.get() && second.read("/home")==null)

    second.clear(verify=true)
}

fun main() = runBlocking {
    val results = listOf(
        "signed-out startup retires Settings and Sync before a new group signs in" to suspend { interruptedRestore(Replacement.NONE) },
        "same-identity replacement revalidates the role and loads Home under a new generation" to suspend { interruptedRestore(Replacement.SAME_OWNER) },
        "a replacement in another group never enters the old activity" to suspend { interruptedRestore(Replacement.OTHER_GROUP) },
        "a narrowed grant removes privileged panels before reading records again" to suspend { grantsNarrowed() },
        "a peer's same-credential role change closes an interrupted bootstrap" to suspend { peerNarrowsGrant() },
        "saved-session Retry rechecks the server without repeating login" to suspend { retrySavedSession() },
        "cancelled startup publishes no session, starts no Sync and replays no command" to suspend { cancelBootstrap() },
        "a renewed deadline with identical grants preserves the current route and generation" to suspend { renewedDeadlineKeepsScope() },
        "an equal-valued foreground profile replaces the authority held by the screen" to suspend { equalProfileRefresh() },
        "an older actor-only saved profile restores through a current server profile" to suspend { legacyProfileRestores() },
        "a delayed Home reply cannot publish after logout" to suspend { delayedRecordReadCannotCrossBoundary(Route.HOME,Replacement.NONE) },
        "a delayed Home reply cannot enter a replacement account and collection" to suspend { delayedRecordReadCannotCrossBoundary(Route.HOME,Replacement.OTHER_GROUP) },
        "a delayed Payments reply cannot publish after logout" to suspend { delayedRecordReadCannotCrossBoundary(Route.PAYMENTS,Replacement.NONE) },
        "a delayed Payments reply cannot enter a replacement account and collection" to suspend { delayedRecordReadCannotCrossBoundary(Route.PAYMENTS,Replacement.OTHER_GROUP) },
        "a delayed Home reply cannot cross a same-actor narrower grant" to suspend { delayedRecordReadCannotCrossBoundary(Route.HOME,Replacement.SAME_OWNER) },
        "a delayed Payments reply cannot cross a same-actor narrower grant" to suspend { delayedRecordReadCannotCrossBoundary(Route.PAYMENTS,Replacement.SAME_OWNER) },
        "Home, lists and details publish while encrypted display writes are blocked" to suspend { freshRowsPublishWhileRecordCacheIsBlocked() },
        "a paired session and Home response restores and caches the authorized snapshot" to suspend { bundledHomeRestores() },
        "cold Home and foreground Home each read profile and savings in one request" to suspend { savingsBundleRestoresInOneRead(true) },
        "a bounded optional savings failure draws Home without issuing duplicate work" to suspend { savingsBundleRestoresInOneRead(false) },
        "warm Payments, Members and details need only one current-profile request after resume" to suspend { warmRoutesReuseVerifiedAuthority() },
        "a restored Settings destination never requests unused Home records" to suspend { settingsRestoreSkipsUnusedHome() },
        "bundled sign-in displays the confirmed base without repeating login or plain Home" to suspend { loginHomeRequests(include=true) },
        "negotiated savings load without blocking bundled sign-in" to suspend { bundledHomeEnhancementCannotBlockOrCrossSignOut(false) },
        "confirmed enhanced Home revocation redacts the visible profile" to suspend { bundledHomeEnhancementOnlyRedactsConfirmedDenial(true) },
        "unconfirmed enhanced Home gateway response retains confirmed base" to suspend { bundledHomeEnhancementOnlyRedactsConfirmedDenial(false) },
        "confirmed records denial suppresses Home and revalidates the existing profile" to suspend { bundledHomeDenialRevalidatesOnlyWhenConfirmed(true) },
        "unrelated HTTP 403 does not suppress confirmed Home or revalidate" to suspend { bundledHomeDenialRevalidatesOnlyWhenConfirmed(false) },
        "delayed negotiated savings cannot cross sign-out" to suspend { bundledHomeEnhancementCannotBlockOrCrossSignOut(true) },
        "a committed sign-in without its optional Home fetches only Home" to suspend { loginHomeRequests(include=false) },
        "an older server can reject the optional sign-in query before authentication" to suspend { loginHomeRequests(include=false,oldServer=true) },
        "an uncertain bundled sign-in never repeats a credential request" to suspend { loginHomeRequests(include=false,uncertain=true) },
        "recent Home cache cannot substitute for a current authorized server read" to suspend { recentHomeStillReadsAuthorizedData() },
        "an APK upgrade deletes incompatible display snapshots and preserves protected work" to suspend { appUpgradeDiscardsOnlyDisplaySnapshots() },
        "recent first pages require an exact query and explicit reads still reach the server" to suspend { firstPageCacheRequiresExactQuery() },
        "an older queued Home cannot overwrite a newer live Home in another repository" to suspend { olderQueuedHomeCannotOverwriteNewerLiveHome() },
        "a cache invalidation fences a late write from another repository instance" to suspend { invalidationRejectsOldRecordWrites() },
    ).map { (label, scenario) ->
        runCatching { scenario() }.also { result ->
            println((if (result.isSuccess) "PASS" else "FAIL") + " $flavor $label")
            result.exceptionOrNull()?.printStackTrace()
        }
    }
    check(results.all { it.isSuccess })
}
