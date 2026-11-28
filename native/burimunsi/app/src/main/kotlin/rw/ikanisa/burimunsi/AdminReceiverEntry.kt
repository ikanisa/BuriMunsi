package rw.ikanisa.burimunsi

import android.content.Context
import android.content.Intent
import rw.ikanisa.burimunsi.core.Role

/** A Staff-app Admin opens the matching signed receiver with its own Android sandbox and sign-in. */
internal object AdminReceiverEntry {
    fun intent(context: Context): Intent? {
        val target = BuriRolePackages.adminForStaff(context.packageName) ?: return null
        val packages = context.packageManager
        if (BuriRolePackages.verifiedPair(packages, context.packageName, target) == null) return null
        return packages.getLaunchIntentForPackage(target)?.takeIf { it.component?.packageName == target }
    }

    fun open(context: Context, role: Role?): Boolean {
        if (role != Role.ADMIN) return false
        return intent(context)?.let { runCatching { context.startActivity(it) }.isSuccess } ?: false
    }
}
