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
    class Restored(val grant: Grant?, val navigation: RestorationDecision, val home: Home? = null,
        val homeSavedAt: Long? = null, val reusedHome: Boolean = false, val recovery: Recovery? = null)

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

    private fun readCheckpoint(): NavigationCheckpoint? = try {
        NavigationCheckpoint.decode(checkpoints.read())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    fun restore(): Restored {
        var savedScope: Pair<String?, String>? = null
        var bookmark: NavigationCheckpoint? = null
        val combined = try {
            repository.restoreForHome(allowRecentCache = readJournal() == JournalKnowledge.CLEAR) { owner, group ->
                savedScope = owner to group
                bookmark = readCheckpoint()
                bookmark?.let { it.route == Route.HOME || owner == null || !it.validFor(owner, group, clock()) } ?: true
            }
        } catch (changed: ContractFailure) {
            val (owner, group) = savedScope ?: throw changed
            if (changed.code != "session_changed" || owner == null) throw changed
            return Restored(null, ScreenRestoration.decide(null, null, "", clock(), receiver, readJournal()),
                recovery = recover(owner, group))
        }
        val grant = combined?.operator?.let { bind(it) }
        if (grant != null && savedScope == null) bookmark = readCheckpoint()
        val navigation = ScreenRestoration.decide(bookmark, grant?.operator, grant?.group.orEmpty(),
            clock(), receiver, readJournal())
        val acceptHome = navigation.route == Route.HOME && (combined?.reusedHome != true || !navigation.pending)
        return Restored(grant?.takeIf { navigation.route != Route.LOGIN }, navigation,
            combined?.home?.takeIf { acceptHome }, combined?.homeSavedAt, combined?.reusedHome == true)
    }

    fun login(phone: String, pin: String): Grant =
        repository.loginForHome(phone,pin).let{bind(it.operator,it.home,it.homeSavedAt)}
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
