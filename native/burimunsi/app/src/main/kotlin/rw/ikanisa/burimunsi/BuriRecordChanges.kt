package rw.ikanisa.burimunsi

import android.app.BroadcastOptions
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.os.Build
import android.os.PatternMatcher
import androidx.core.content.ContextCompat

/** Hints contain no data. Each foreground app reads its own records under its current session. */
internal object BuriRecordChanges {
    private const val ACTION = "rw.ikanisa.burimunsi.RECORDS_CHANGED"
    private fun permission(target: String) = "$target.permission.RECORDS_CHANGED"

    fun observe(context: Context, changed: () -> Unit): () -> Unit {
        val target = context.packageName
        val admin = BuriRolePackages.adminForStaff(target) ?: return observeHints(context, null, changed)
        var stopHints: (() -> Unit)? = null
        fun bind() {
            stopHints?.invoke()
            stopHints = observeHints(context, admin, changed)
        }
        val peerChanged = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.data?.schemeSpecificPart == admin) bind()
            }
        }
        val packages = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addDataScheme("package")
            addDataSchemeSpecificPart(admin, PatternMatcher.PATTERN_LITERAL)
        }
        // These system-protected package events also cover installation after Staff opened.
        ContextCompat.registerReceiver(context, peerChanged, packages, ContextCompat.RECEIVER_EXPORTED)
        bind()
        return { context.unregisterReceiver(peerChanged); stopHints?.invoke() }
    }

    private fun observeHints(context: Context, admin: String?, changed: () -> Unit): () -> Unit {
        val target = context.packageName
        val packages = context.packageManager
        val pair = if (admin != null) BuriRolePackages.verifiedPair(packages, target, admin) else null
        if (admin != null && pair == null) return {}
        val separateAdmin = admin.takeIf { pair == BuriRolePackages.Signers.DISTINCT }
        // Android 8–13 does not identify the original broadcast sender. Across distinct
        // keys, use the existing authenticated foreground refresh and freshness timer.
        if (separateAdmin != null && Build.VERSION.SDK_INT < 34) return {}
        val senderPermission = permission(separateAdmin ?: target)
        if (separateAdmin != null && !ownsSignaturePermission(packages, separateAdmin, senderPermission)) return {}
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != ACTION || intent.`package` != target) return
                if (separateAdmin != null) {
                    if (Build.VERSION.SDK_INT < 34 || sentFromPackage != separateAdmin ||
                        packages.getPackagesForUid(sentFromUid)?.contains(separateAdmin) != true ||
                        BuriRolePackages.verifiedPair(packages, target, separateAdmin) != BuriRolePackages.Signers.DISTINCT) return
                }
                changed()
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION), senderPermission, null,
            ContextCompat.RECEIVER_EXPORTED)
        return { context.unregisterReceiver(receiver) }
    }

    @Suppress("DEPRECATION")
    private fun ownsSignaturePermission(packages: PackageManager, owner: String, name: String): Boolean {
        val info = try { packages.getPermissionInfo(name, 0) }
            catch (_: PackageManager.NameNotFoundException) { return false }
        return info.packageName == owner &&
            info.protectionLevel and PermissionInfo.PROTECTION_MASK_BASE == PermissionInfo.PROTECTION_SIGNATURE
    }

    fun publishFromReceiver(context: Context) {
        val admin = context.packageName
        val staff = BuriRolePackages.staffForAdmin(admin) ?: return
        fun hint(target: String) = Intent(ACTION).setPackage(target).addFlags(Intent.FLAG_RECEIVER_REGISTERED_ONLY)
        context.sendBroadcast(hint(admin), permission(admin))
        val pair = BuriRolePackages.verifiedPair(context.packageManager, staff, admin) ?: return
        // The receive-side permission below belongs to Staff. Only Staff receives the
        // explicit hint. A differently signed sender separately proves its Android identity.
        if (Build.VERSION.SDK_INT >= 34) {
            val identity = BroadcastOptions.makeBasic().setShareIdentityEnabled(true)
            context.sendBroadcast(hint(staff), permission(staff), identity.toBundle())
        } else if (pair == BuriRolePackages.Signers.SAME) {
            context.sendBroadcast(hint(staff), permission(staff))
        }
    }
}
