package rw.ikanisa.burimunsi.data

import org.json.JSONObject
import rw.ikanisa.burimunsi.core.ContractFailure
import rw.ikanisa.burimunsi.core.Operator
import rw.ikanisa.burimunsi.core.Values
import rw.ikanisa.burimunsi.core.checkContract

private val nativeBearer = Regex("[a-f0-9]{64}")

internal fun isNativeBearer(value: String): Boolean = nativeBearer.matches(value)

internal enum class PasscodeStage(val wireName: String) {
    PREPARED("prepared"),
    INFLIGHT("inflight"),
}

internal class SavedPasscode(val token: String, val stage: PasscodeStage) {
    override fun toString() = "SavedPasscode(redacted)"
}

internal class NativeRevocationProof(
    val token: String,
    val groupId: String,
    val owner: String?,
    val candidate: String?,
) {
    override fun toString() = "NativeRevocationProof(redacted)"
}

/** Read the encrypted v1 record once. Legacy records may hold only an actor ID. */
internal class SavedNativeSession private constructor(
    private val value: JSONObject,
    val token: String,
    val groupId: String,
    val expiresAt: Long,
    val profile: JSONObject?,
    val owner: String?,
    val pendingPasscode: SavedPasscode?,
) {
    override fun toString() = "SavedNativeSession(redacted)"

    fun operatorOrNull(): Operator? = profile?.let {
        try { operator(it, expiresAt) } catch (_: Exception) { null }
    }

    fun withConfirmedProfile(profile: JSONObject, expiresAt: Long): String = rewrite {
        put("profile", profile)
        put("expiresAt", expiresAt)
    }

    fun withoutPasscode(): String = rewrite { remove("pendingPasscode") }

    fun withPreparedPasscode(candidate: String): String = rewrite {
        put("pendingPasscode", JSONObject().put("token", candidate).put("state", PasscodeStage.PREPARED.wireName))
    }

    fun withInflightPasscode(): String = rewrite {
        getJSONObject("pendingPasscode").put("state", PasscodeStage.INFLIGHT.wireName)
    }

    fun withReplacement(candidate: String, profile: JSONObject, expiresAt: Long): String = rewrite {
        remove("pendingPasscode")
        put("token", candidate)
        put("profile", profile)
        put("expiresAt", expiresAt)
    }

    private fun rewrite(change: JSONObject.() -> Unit): String =
        JSONObject(value.toString()).apply(change).toString()

    companion object {
        fun decode(encoded: String): SavedNativeSession = try {
            val value = JSONObject(encoded)
            val token = value.get("token") as String
            val groupId = Values.id(value.get("groupId") as String)
            val expiresAt = when (val raw = value.get("expiresAt")) {
                is Int -> raw.toLong()
                is Long -> raw
                else -> throw ContractFailure("invalid_session")
            }
            checkContract(isNativeBearer(token) && expiresAt > 0, "invalid_session")
            val profile = if (value.isNull("profile")) null else value.getJSONObject("profile")
            val owner = profile?.let { Values.id(it.get("id") as String) }
            val pending = if (!value.has("pendingPasscode")) null else {
                val record = value.getJSONObject("pendingPasscode")
                val candidate = record.get("token") as String
                val state = record.get("state") as String
                val stage = PasscodeStage.entries.firstOrNull { it.wireName == state }
                    ?: throw ContractFailure("invalid_session")
                checkContract(owner != null && isNativeBearer(candidate) && candidate != token, "invalid_session")
                SavedPasscode(candidate, stage)
            }
            SavedNativeSession(value, token, groupId, expiresAt, profile, owner, pending)
        } catch (_: Exception) {
            throw ContractFailure("invalid_session")
        }

        /** A durable sign-out marker allows recovery of revocation proof from an unrestorable record. */
        fun decodeRevocationProof(encoded: String): NativeRevocationProof = try {
            val value = JSONObject(encoded)
            val token = value.get("token") as String
            val groupId = Values.id(value.get("groupId") as String)
            checkContract(isNativeBearer(token), "invalid_session")
            val owner = (value.optJSONObject("profile")?.opt("id") as? String)
                ?.let { runCatching { Values.id(it) }.getOrNull() }
            val candidate = (value.optJSONObject("pendingPasscode")?.opt("token") as? String)
                ?.takeIf { it != token && isNativeBearer(it) }
            NativeRevocationProof(token, groupId, owner, candidate)
        } catch (_: Exception) {
            throw ContractFailure("invalid_session")
        }

        fun encode(token: String, groupId: String, expiresAt: Long, profile: JSONObject): String =
            JSONObject().put("token", token).put("groupId", groupId)
                .put("expiresAt", expiresAt).put("profile", profile).toString()
    }
}
