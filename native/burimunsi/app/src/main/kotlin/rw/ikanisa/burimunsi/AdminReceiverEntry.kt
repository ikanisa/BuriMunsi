package rw.ikanisa.burimunsi

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import rw.ikanisa.burimunsi.core.Role

/** A Staff-app Admin opens the matching signed receiver with its own Android sandbox and sign-in. */
internal object AdminReceiverEntry {
    private const val STAFF = "rw.ikanisa.burimunsi.staff.cloud"
    private const val ADMIN = "rw.ikanisa.burimunsi.gateway.cloud"

    fun intent(context: Context): Intent? {
        if (!context.packageName.startsWith(STAFF)) return null
        val suffix = context.packageName.removePrefix(STAFF)
        if (suffix !in setOf("", ".debug", ".qualification", ".nativeTest")) return null
        val target = ADMIN + suffix
        val packages = context.packageManager
        if (packages.checkSignatures(context.packageName, target) != PackageManager.SIGNATURE_MATCH) return null
        return packages.getLaunchIntentForPackage(target)?.takeIf { it.component?.packageName == target }
    }

    fun open(context: Context, role: Role?): Boolean {
        if (role != Role.ADMIN) return false
        return intent(context)?.let { runCatching { context.startActivity(it) }.isSuccess } ?: false
    }
}
