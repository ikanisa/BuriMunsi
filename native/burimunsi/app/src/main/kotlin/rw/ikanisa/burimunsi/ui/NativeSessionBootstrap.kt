package rw.ikanisa.burimunsi.ui

import kotlinx.coroutines.CancellationException
import rw.ikanisa.burimunsi.core.*
import rw.ikanisa.burimunsi.data.NativeRepository

/** Shared by Staff and Admin Sync. Callers run storage and repository operations on IO. */
internal class NativeSessionBootstrap(
    private val repository: NativeRepository,
    private val checkpoints: NavigationCheckpointStore,
    private val receiver: Boolean,
    private val clock: () -> Long,
    private val readJournal: () -> JournalKnowledge,
) {
    class Grant(val operator: Operator, val group: String, val revision: Long,
        val home: Home? = null, val homeSavedAt: Long? = null)
    class Restored(val grant: Grant?, val navigation: RestorationDecision, val home: Home? = null, val homeSavedAt: Long? = null)

    sealed interface Recovery {
        data object PasscodePending : Recovery
        data object Offline : Recovery
        data object SignedOut : Recovery
        class Attached(val grant: Grant) : Recovery
    }

    private enum class Startup { IDLE, RESTORING, FOREGROUND_SHARED }
    private var startup = Startup.IDLE

    fun beginInitialRestore() { startup = Startup.RESTORING }

    fun shareInitialForeground(): Boolean {
        if (startup == Startup.IDLE) return false
        startup = Startup.FOREGROUND_SHARED
        return true
    }

    fun finishInitialRestore(completed: Boolean): Boolean {
        val retryForeground = startup == Startup.FOREGROUND_SHARED && !completed
        startup = Startup.IDLE
        return retryForeground
    }

    private fun bind(profile: Operator, home: Home? = null, homeSavedAt: Long? = null): Grant =
        repository.withCurrentProfile(profile) { group, revision -> Grant(profile, group, revision, home, homeSavedAt) }

    /** The validated group, role and generation must still own the UI publication after any suspension. */
    fun <T> withCurrent(grant: Grant, publish: () -> T): T =
        repository.withCurrentProfile(grant.operator) { group, revision ->
            checkContract(grant.group == group && grant.revision == revision, "session_changed")
            checkContract(clock() < grant.operator.expiresAt, "session_unavailable")
            publish()
        }

    fun requireCurrent(grant: Grant) = withCurrent(grant) {}

    fun restore(): Restored {
        // Bind the verified session before opening the potentially blocking
        // navigation checkpoint. It belongs to this restore, even if another
        // activity replaces the session while the checkpoint is being read.
        val combined = repository.restoreForHome(allowRecentCache = readJournal() == JournalKnowledge.CLEAR)
        val grant = combined?.operator?.let { bind(it) }
        val bookmark = if (grant == null) null else try {
            NavigationCheckpoint.decode(checkpoints.read())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        val navigation = ScreenRestoration.decide(bookmark, grant?.operator, grant?.group.orEmpty(),
            clock(), receiver, readJournal())
        val acceptHome = navigation.route == Route.HOME && (combined?.reusedHome != true || !navigation.pending)
        return Restored(grant?.takeIf { navigation.route != Route.LOGIN }, navigation,
            combined?.home?.takeIf { acceptHome }, combined?.homeSavedAt)
    }

    fun login(phone: String, pin: String): Grant = bind(repository.login(phone, pin))
    fun refresh(): Grant = bind(repository.refreshSession())
    fun refreshHome(): Grant = repository.refreshHome().let { bind(it.operator, it.home, it.homeSavedAt) }

    fun recover(owner: String, group: String?): Recovery {
        if (repository.hasPendingPasscode()) return Recovery.PasscodePending
        if (group == null) return Recovery.SignedOut
        return try {
            val profile = repository.reattachSameOwner(owner, group) ?: return Recovery.SignedOut
            val grant = bind(profile)
            if (profile.id == owner && grant.group == group) Recovery.Attached(grant) else Recovery.SignedOut
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (repository.hasSavedSession()) Recovery.Offline else Recovery.SignedOut
        }
    }
}
