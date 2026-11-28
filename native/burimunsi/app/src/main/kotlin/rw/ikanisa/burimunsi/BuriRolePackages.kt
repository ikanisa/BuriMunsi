package rw.ikanisa.burimunsi

import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/** Google Play assigns independent app-signing lineages to the two production package names. */
internal object BuriRolePackages {
    const val STAFF = "rw.ikanisa.burimunsi.staff.cloud"
    const val ADMIN = "rw.ikanisa.burimunsi.gateway.cloud"

    private const val DIRECT = "a9003fa58bf2be62b61fc1f1d76a7691bbb0f18a3c43f60b81785bbe990e2b51"
    private const val PLAY_STAFF = "0a52db15104416597082b6057c10f0fca154ab9bfec70e9fd2fd442bbd2cb77a"
    private const val PLAY_ADMIN = "9346eab67afe7eb25fac3b30c0a8680cf1b4090636d141cbec57d526037080b7"
    private val suffixes = setOf("", ".debug", ".qualification", ".nativeTest")

    fun adminForStaff(staff: String): String? = counterpart(staff, STAFF, ADMIN)
    fun staffForAdmin(admin: String): String? = counterpart(admin, ADMIN, STAFF)

    private fun counterpart(name: String, from: String, to: String): String? {
        if (!name.startsWith(from)) return null
        return name.removePrefix(from).takeIf { it in suffixes }?.let { to + it }
    }

    enum class Signers { SAME, DISTINCT }

    fun verifiedPair(packages: PackageManager, staff: String, admin: String): Signers? {
        if (adminForStaff(staff) != admin) return null
        val same = packages.checkSignatures(staff, admin) == PackageManager.SIGNATURE_MATCH
        if (staff != STAFF) return if (same) Signers.SAME else null
        if (!trustedRelease(packages, staff) || !trustedRelease(packages, admin)) return null
        return if (same) Signers.SAME else Signers.DISTINCT
    }

    @Suppress("DEPRECATION")
    private fun trustedRelease(packages: PackageManager, name: String): Boolean {
        val signatures = try {
            if (Build.VERSION.SDK_INT >= 28) {
                val signing = packages.getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
                if (signing == null || signing.hasMultipleSigners()) return false
                // PackageManager verifies the rotation proof before exposing this history.
                signing.signingCertificateHistory
            } else {
                val active = packages.getPackageInfo(name, PackageManager.GET_SIGNATURES).signatures
                if (active?.size != 1) return false
                active
            }
        } catch (_: PackageManager.NameNotFoundException) {
            return false
        }
        return signatures.orEmpty().any { signature ->
            val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHexString()
            acceptsReleaseDigest(name, digest)
        }
    }

    internal fun acceptsReleaseDigest(name: String, digest: String): Boolean = when (name) {
        STAFF -> digest == PLAY_STAFF || digest == DIRECT
        ADMIN -> digest == PLAY_ADMIN || digest == DIRECT
        else -> false
    }
}
