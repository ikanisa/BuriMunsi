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
        check(Transport.calls.none { it.path.endsWith("/home") || it.path.endsWith("/session") })
        val saved = checkNotNull(NativeRecordCache(scenario.app).read("/home")).getJSONObject("entries").getJSONObject("/home")
        check(JSONObject(saved.getString("payload")).getLong("paymentCount") == 250L)
    } finally {
        stop(model)
        Transport.sessionHome = null
    }
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
        if(request.path.contains("/payments?")) JSONObject().put("items",JSONArray()).put("totalCount",0)
            .put("revision","fresh").put("asOf","2026-11-20T00:00:00Z").put("nextCursor",JSONObject.NULL).toString()
        else normal(request)
    }
    fun blockDisk():Pair<CountDownLatch,CountDownLatch> {
        val entered=CountDownLatch(1)
        val release=CountDownLatch(1)
        SecureStore.beforeWrite={ name ->
            if(name=="records"){entered.countDown();check(release.await(10,TimeUnit.SECONDS))}
        }
        return entered to release
    }
    var (entered,release)=blockDisk()
    val model=BuriViewModel(scenario.app)
    try {
        check(entered.await(5,TimeUnit.SECONDS))
        withTimeout(2_000){while(model.state.busy || model.state.home==null)delay(2)}
        check(Transport.calls.map { it.path }==listOf("/v1/burimunsi/session?include=home"))
        val lookup=java.util.concurrent.CompletableFuture.supplyAsync { NativeRecordCache(scenario.app).read("/home") }
        check(runCatching { lookup.get(250,TimeUnit.MILLISECONDS) }.exceptionOrNull() is java.util.concurrent.TimeoutException)
        release.countDown()
        check(lookup.get(5,TimeUnit.SECONDS)!=null)
        val next=blockDisk()
        entered=next.first;release=next.second
        model.onFixtureMain { navigate(Route.PAYMENTS) }
        check(entered.await(5,TimeUnit.SECONDS))
        withTimeout(2_000){while(model.state.busy || model.state.payments==null)delay(2)}
        check(Transport.calls.count { it.path.contains("/payments?") }==1)
        check(!model.state.offline)
    } finally {
        release.countDown()
        SecureStore.beforeWrite=null
        Transport.sessionHome=null
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
        check(Transport.calls.map{it.path}==expected)
        if(uncertain)check(model.state.operator==null&&model.state.home==null)
        else check(model.state.operator?.id==scenario.owner&&model.state.home?.paymentCount==(if(include)300 else 0))
    } finally {
        stop(model)
        Transport.loginHome=null
    }
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
        check(Transport.calls.map { it.path } == listOf("/v1/burimunsi/session?include=home"))
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
        check(Transport.calls.map { it.path } ==
            listOf("/v1/burimunsi/session?include=home", "/v1/burimunsi/session", "/v1/burimunsi/home"))
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
        "fresh Home and Payments publish while protected record cache writes are blocked" to suspend { freshRowsPublishWhileRecordCacheIsBlocked() },
        "a paired session and Home response restores and caches the authorized snapshot" to suspend { bundledHomeRestores() },
        "a restored Settings destination never requests unused Home records" to suspend { settingsRestoreSkipsUnusedHome() },
        "bundled sign-in displays the confirmed Home without another request" to suspend { loginHomeRequests(include=true) },
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
