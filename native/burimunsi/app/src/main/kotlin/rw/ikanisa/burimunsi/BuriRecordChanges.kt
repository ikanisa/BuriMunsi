package rw.ikanisa.burimunsi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat

/** Hints contain no data. Each foreground app reads its own records under its current session. */
internal object BuriRecordChanges {
    private const val ACTION = "rw.ikanisa.burimunsi.RECORDS_CHANGED"
    private const val RECEIVER = "rw.ikanisa.burimunsi.gateway.cloud"
    private const val STAFF = "rw.ikanisa.burimunsi.staff.cloud"
    private fun permission(target: String) = "$target.permission.RECORDS_CHANGED"

    fun observe(context: Context, changed: () -> Unit): () -> Unit {
        val target = context.packageName
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == ACTION && intent.`package` == target) changed()
            }
        }
        // The receiving package owns this signature permission. Unrelated applications
        // cannot make its live Staff or Admin screen issue authenticated reads.
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION), permission(target), null,
            ContextCompat.RECEIVER_EXPORTED)
        return { context.unregisterReceiver(receiver) }
    }

    fun publishFromReceiver(context: Context) {
        val self = context.packageName
        if (!self.startsWith(RECEIVER)) return
        val suffix = self.removePrefix(RECEIVER)
        if (suffix !in setOf("", ".nativeTest", ".qualification", ".debug")) return
        for (target in listOf(self, STAFF + suffix)) {
            val hint = Intent(ACTION).setPackage(target).addFlags(Intent.FLAG_RECEIVER_REGISTERED_ONLY)
            context.sendBroadcast(hint, permission(target))
        }
    }
}
