package app.cool.mobile.receiver_sms

import android.content.Context
import android.database.Cursor
import android.net.Uri
import rw.ikanisa.burimunsi.core.ObservationCandidate
import rw.ikanisa.burimunsi.core.ObservationSessionOwner
import rw.ikanisa.burimunsi.core.ReceiptProfile
import rw.ikanisa.burimunsi.core.checkContract
import rw.ikanisa.burimunsi.data.NativeRepository

internal enum class ObservationInboxOrder(val sort: String) {
    ROW_ID("_id ASC"),
    NEWEST("date DESC, _id DESC"),
}

private const val INBOX = "content://sms/inbox"
private val inboxUri = Uri.parse(INBOX)
private val metadataColumns = arrayOf("_id", "address", "date")
private val optionalColumns = arrayOf("date_sent", "sub_id")
private const val BODY = -2

internal data class PolicyLease(val revision: Long, val expiresAt: Long)
private fun capturePolicyLease(app: Context, owner: ObservationSessionOwner, profile: ReceiptProfile): PolicyLease? {
    val revision = ObservationInboxPolicyRevision.stable() ?: return null
    return NativeRepository.withObservationOwner(app, owner) { _, _ ->
        val config = ObservationConfigStore(app)
        val now = System.currentTimeMillis()
        val current = config.profile(owner.owner, now)
        val consent = config.consent(owner.owner)
        if (current?.receipt == profile && !config.paused(owner.owner) &&
            consent?.canCapture(observationInboxPermitted(app)) == true) PolicyLease(revision, current.expiresAt)
        else null
    }?.takeIf { ObservationInboxPolicyRevision.stable() == it.revision }
}

/** A scan cursor never projects body. An allowlisted row may request it by exact item URI. */
internal class ObservationInboxCursor(
    private val metadata: Cursor,
    private val app: Context,
    private val profile: ReceiptProfile,
    private val after: Long,
    private val through: Long?,
    private val bodyOwner: ObservationSessionOwner?,
    private val authorityRevision: Long?,
    private val policy: PolicyLease?,
    private val stopped: () -> Boolean,
) : java.io.Closeable {
    private data class ReadBody(val value: String?)
    private var bodyLoaded = false
    private var body: String? = null

    fun moveToNext(): Boolean {
        bodyLoaded = false
        body = null
        return metadata.moveToNext()
    }

    fun getColumnIndex(name: String): Int =
        if (name == "body") { if (bodyOwner != null) BODY else -1 } else metadata.getColumnIndex(name)
    fun getColumnIndexOrThrow(name: String): Int = getColumnIndex(name).also { checkContract(it != -1, "observation_cursor_unavailable") }
    fun getLong(column: Int): Long = metadata.getLong(column)
    fun getInt(column: Int): Int = metadata.getInt(column)
    fun isNull(column: Int): Boolean = if (column == BODY) scopedBody() == null else metadata.isNull(column)
    fun getString(column: Int): String = if (column == BODY) checkNotNull(scopedBody()) else metadata.getString(column)

    private fun scopedBody(): String? {
        if (bodyLoaded) return body
        val owner = checkNotNull(bodyOwner)
        val senderColumn = metadata.getColumnIndexOrThrow("address")
        val sender = if (metadata.isNull(senderColumn)) "" else metadata.getString(senderColumn)
        if (!ObservationCandidate.senderAllowed(sender, profile)) {
            bodyLoaded = true
            return null
        }
        val lease = checkNotNull(policy) { "observation_cursor_unavailable" }
        fun currentLocalAuthority(): Boolean = !stopped() && observationInboxPermitted(app) &&
            System.currentTimeMillis() < lease.expiresAt && ObservationInboxPolicyRevision.stable() == lease.revision &&
            authorityRevision != null && ObservationAuthorityRevision.stable() == authorityRevision
        fun authorized(): Boolean = currentLocalAuthority() && NativeRepository.observationOwner(app) == owner
        checkContract(authorized(), "observation_cursor_unavailable")
        val id = metadata.nullableLong("_id")
        val date = metadata.nullableLong("date")
        checkContract(id != null && date != null && id > after && (through == null || id <= through) && date > 0,
            "observation_cursor_unavailable")
        val optional = optionalColumns.filter { metadata.getColumnIndex(it) >= 0 }
        checkContract(authorized(), "observation_cursor_unavailable")
        val exact = app.contentResolver.query(Uri.parse("$INBOX/$id"),
            metadataColumns + optional + "body", null, null, null)
        checkContract(exact != null, "observation_cursor_unavailable")
        body = checkNotNull(exact).use { row ->
            // Probe at most two results. A provider ignoring the item URI must
            // not expose any unrelated body, even if its first result matches.
            checkContract(row.moveToNext() && !row.moveToNext() && row.moveToFirst(), "observation_cursor_unavailable")
            val exactSender = row.getColumnIndexOrThrow("address")
            checkContract(row.nullableLong("_id") == id && row.nullableLong("date") == date &&
                !row.isNull(exactSender) && row.getString(exactSender) == sender &&
                optional.all { row.getColumnIndex(it) >= 0 && row.nullableLong(it) == metadata.nullableLong(it) },
                "observation_cursor_unavailable")
            val column = row.getColumnIndexOrThrow("body")
            val held = NativeRepository.withObservationOwner(app, owner) { _, _ ->
                ObservationInboxPolicyRevision.whileCurrent(lease.revision) {
                    checkContract(currentLocalAuthority(), "observation_cursor_unavailable")
                    // Container distinguishes a legitimate null body from lost authority.
                    ReadBody(if (row.isNull(column)) null else row.getString(column))
                }
            }
            checkContract(held != null, "observation_cursor_unavailable")
            checkNotNull(held).value
        }
        bodyLoaded = true
        return body
    }

    private fun Cursor.nullableLong(name: String): Long? =
        getColumnIndex(name).takeIf { it >= 0 && !isNull(it) }?.let(::getLong)

    override fun close() = metadata.close()
}

/** Both ordinary provider selection and OEM fallback request metadata only. */
internal fun queryObservationInbox(
    app: Context,
    after: Long,
    profile: ReceiptProfile,
    through: Long? = null,
    order: ObservationInboxOrder = ObservationInboxOrder.ROW_ID,
    bodyOwner: ObservationSessionOwner? = null,
    stopped: () -> Boolean = { false },
): ObservationInboxCursor? = with(app.contentResolver) {
    val authorityRevision = ObservationAuthorityRevision.stable()
    val policy = if (bodyOwner == null) null else capturePolicyLease(app, bodyOwner, profile) ?: return@with null
    val bounds = if (through == null) "_id > ?" else "_id > ? AND _id <= ?"
    val args = listOfNotNull(after.toString(), through?.toString()).toTypedArray()
    val senders = profile.senders.sorted()
    val canFilter = senders.isNotEmpty() && senders.size <= 30 &&
        senders.all { sender -> sender.isNotEmpty() && sender.all { it in ' '..'~' } }
    val plain = bounds to args
    val plans = if (canFilter) {
        val placeholders = senders.joinToString(",") { "?" }
        val filter = "address COLLATE NOCASE IN ($placeholders) OR address GLOB '*[^ -~]*'"
        listOf(("$bounds AND ($filter)" to (args + senders)), plain)
    } else listOf(plain)
    val projections = if (bodyOwner == null) listOf(metadataColumns) else listOf(
        metadataColumns + optionalColumns, metadataColumns + "date_sent", metadataColumns + "sub_id", metadataColumns,
    )
    plans.firstNotNullOfOrNull { (selection, selectionArgs) ->
        projections.firstNotNullOfOrNull { columns ->
            try {
                query(inboxUri, columns, selection, selectionArgs, order.sort)?.let {
                    ObservationInboxCursor(it, app, profile, after, through, bodyOwner, authorityRevision, policy, stopped)
                }
            } catch (_: Exception) {
                null
            }
        }
    }
}
