package rw.ikanisa.burimunsi.permissiontests
import android.app.Application
import kotlinx.coroutines.*
import rw.ikanisa.burimunsi.ui.BuriViewModel
import rw.ikanisa.burimunsi.ui.Sheet
import rw.ikanisa.burimunsi.gateway.GatewayFixture
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.data.Fixture
import androidx.lifecycle.onFixtureMain
import androidx.lifecycle.viewModelScope
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val watchdogMillis = 60_000L

fun main()=runBlocking {
    val app = Application()
    val now = System.currentTimeMillis()
    // Periodic record refresh has its own tests and must not change the permission callback's read count.
    Fixture.recordSavedAt = now
    val model = BuriViewModel(app) { now }
    suspend fun awaitUi(stage: String, acknowledged: BuriViewModel.() -> Boolean) {
        val observed = withTimeoutOrNull(watchdogMillis) {
            while (!model.onFixtureMain(acknowledged)) delay(20)
            true
        }
        check(observed == true) { model.onFixtureMain {
            "Timed out waiting for $stage: gate=$screenGate starting=${state.starting} busy=${state.busy}" +
                " route=${state.route} panel=${state.sheet} gateway=${state.gateway} failure=${state.failure}" +
                " reads=${GatewayFixture.statusReads} starts=${GatewayFixture.uploadStarts}"
        } }
    }
    // The Activity delivers its initial foreground callback before a permission can be revoked.
    model.onFixtureMain { onForeground() }
    awaitUi("initial Home and receiver start") {
        screenGate == ScreenGate.OPEN && !state.starting && !state.busy && state.gateway != null &&
            GatewayFixture.uploadStarts > 0
    }
    check(model.smsAccessGranted)
    val callerThread = model.onFixtureMain { Thread.currentThread().id }
    val starts = GatewayFixture.uploadStarts
    val readsBeforeRevocation = GatewayFixture.statusReads
    val initialStatus = GatewayFixture.snapshot
    model.onFixtureMain {
        app.permissionResults[android.Manifest.permission.READ_SMS] = -1
        GatewayFixture.snapshot = initialStatus.copy(problem = "permission_required")
        permissionsChanged()
    }
    awaitUi("read permission revocation") {
        GatewayFixture.uploadStarts > starts && GatewayFixture.statusReads > readsBeforeRevocation &&
            state.gateway?.problem == "permission_required" && !state.busy
    }
    check(GatewayFixture.lastStartThreadId != callerThread)
    check(!model.smsAccessGranted)
    model.onFixtureMain {
        app.permissionResults[android.Manifest.permission.READ_SMS] = 0
        app.permissionResults[android.Manifest.permission.RECEIVE_SMS] = -1
        permissionsChanged()
        check(!smsAccessGranted)
        onBackground()
        app.permissionResults[android.Manifest.permission.RECEIVE_SMS] = 0
        GatewayFixture.snapshot = initialStatus
        onForeground()
    }
    awaitUi("Home after foreground permission grant") {
        screenGate == ScreenGate.OPEN && !state.busy && state.gateway == initialStatus
    }
    check(model.smsAccessGranted && model.state.sheet == null)
    println("PASS SMS permission reflects both permissions and refreshes on return without opening a sheet")
    model.onFixtureMain {
        app.permissionResults[android.Manifest.permission.READ_SMS] = -1
        GatewayFixture.snapshot = GatewayStatus(true,false,1,0,null,null,null,"permission_required")
        permissionsChanged()
    }
    awaitUi("denial on Home") { state.gateway?.problem == "permission_required" && !state.busy }
    model.onFixtureMain { openSheet(Sheet.GATEWAY) }
    awaitUi("gateway sheet after denial") { state.sheet == Sheet.GATEWAY && !state.busy }
    check(model.state.gateway?.problem == "permission_required")
    val changes = GatewayFixture.changes
    model.onFixtureMain {
        app.permissionResults[android.Manifest.permission.READ_SMS] = 0
        GatewayFixture.snapshot = GatewayStatus(true,false,1,0,null,null,null,null)
        permissionsChanged()
    }
    awaitUi("grant on gateway sheet") { state.gateway != null && state.gateway?.problem == null && !state.busy }
    check(model.state.sheet == Sheet.GATEWAY && GatewayHealth.describe(model.state.gateway).canResume)
    check(GatewayFixture.changes == changes)
    println("PASS permission return refreshes the current gateway diagnosis without resuming it")
    val reads = GatewayFixture.statusReads
    val startsAgain = GatewayFixture.uploadStarts
    val callback = model.onFixtureMain {
        val owner = viewModelScope.coroutineContext[Job]!!
        val existing = owner.children.toSet()
        permissionsChanged()
        owner.children.filterNot { it in existing }.toList().also { check(it.isNotEmpty()) }
    }
    withTimeout(watchdogMillis) { callback.joinAll() }
    awaitUi("unchanged permission callback") { !state.busy }
    check(GatewayFixture.uploadStarts > startsAgain && GatewayFixture.statusReads == reads)
    println("PASS unchanged permissions do not trigger an extra gateway status refresh")
    val readEntered = CountDownLatch(1)
    val releaseRead = CountDownLatch(1)
    GatewayFixture.statusEntered = readEntered
    GatewayFixture.statusRelease = releaseRead
    val jobsBeforeRevocation = model.onFixtureMain {
        val existing = viewModelScope.coroutineContext[Job]!!.children.toSet()
        app.permissionResults[android.Manifest.permission.RECEIVE_SMS] = -1
        permissionsChanged()
        existing
    }
    val interruptedRead = try {
        check(withContext(Dispatchers.IO) { readEntered.await(watchdogMillis, TimeUnit.MILLISECONDS) }) {
            "Revoking receive permission did not start a gateway read"
        }
        model.onFixtureMain {
            val jobs = viewModelScope.coroutineContext[Job]!!.children.filterNot { it in jobsBeforeRevocation }.toList()
            check(jobs.isNotEmpty())
            onBackground()
            jobs
        }
    } finally {
        releaseRead.countDown()
    }
    withTimeout(watchdogMillis) { interruptedRead.joinAll() }
    awaitUi("background read completion") { !state.busy }
    check(model.state.gateway == null)
    model.viewModelScope.coroutineContext[Job]!!.cancelAndJoin()
    GatewayFixture.statusEntered = null
    GatewayFixture.statusRelease = null
    println("PASS permission refresh cannot publish after the app leaves the foreground")
}
