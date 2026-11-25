package rw.ikanisa.burimunsi.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Per-installation Keystore key, never derived from the four-digit passcode.
 * Operator files are separate from Collect's independent receiving queue.
 */
class SecureStore(context: Context, private val name: String) {
    // AtomicFile readers and writers for one path must agree. Unrelated stores
    // can make progress during a records cache fsync or journal read.
    companion object {
        private val fileLocks = Array(64) { Any() }
        private val keyLock = Any()
        private val keyHandles = mutableMapOf<String, SecretKey>()
    }
    private val file = AtomicFile(File(context.noBackupFilesDir, "buri-$name.v1"))
    private val fileLock = fileLocks[(file.baseFile.absolutePath.hashCode() and Int.MAX_VALUE) % fileLocks.size]
    private val alias = context.packageName + ".burimunsi.operator.v1"
    private val aad = ("burimunsi:" + name + ":1").toByteArray(Charsets.UTF_8)
    private fun key(create: Boolean = true): SecretKey = synchronized(keyLock) {
        keyHandles.getOrPut(alias) {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(alias, null) as? SecretKey) ?: if (!create) error("Protected store unavailable") else KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true).build())
            }.generateKey()
        }
    }
    fun read(): String? = synchronized(fileLock) {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@synchronized null
        file.openRead().use { decode(it, file.baseFile.length(), createKey = true) }
    }

    /** Inspection must not repair, replace, or delete an AtomicFile generation or create a key. */
    internal fun readWithoutRepair(): String? = synchronized(fileLock) {
        val backup = File(file.baseFile.path + ".bak")
        val committed = if (backup.exists()) backup else file.baseFile
        if (!committed.exists()) return@synchronized null
        committed.inputStream().use { decode(it, committed.length(), createKey = false) }
    }

    private fun decode(input: java.io.InputStream, length: Long, createKey: Boolean): String {
        val limit = 2_097_152
        val out = java.io.ByteArrayOutputStream(length.coerceIn(0L, limit.toLong()).toInt())
        val buffer = ByteArray(8192)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            check(out.size() + n <= limit)
            out.write(buffer, 0, n)
        }
        val bytes = out.toByteArray()
        check(bytes.size >= 29 && bytes[0].toInt() == 1) { "Protected store unavailable" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(createKey), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val body = cipher.doFinal(bytes, 13, bytes.size - 13)
        return try { body.toString(Charsets.UTF_8) } finally { body.fill(0) }
    }
    fun write(value: String) = synchronized(fileLock) {
        val body = value.toByteArray(Charsets.UTF_8)
        try {
            require(body.size <= 2_000_000)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(aad)
            check(cipher.iv.size == 12)
            val iv = cipher.iv
            val encrypted = cipher.doFinal(body)
            val output = file.startWrite()
            try {
                output.write(1)
                output.write(iv)
                output.write(encrypted)
                output.fd.sync()
                file.finishWrite(output)
            } catch (e: Exception) {
                file.failWrite(output)
                throw e
            }
        } finally {
            body.fill(0)
        }
    }
    fun clear() = synchronized(fileLock) { file.delete() }
}
