package rw.ikanisa.burimunsi.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.util.UUID
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStoreRecordTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val name = "synthetic-gcm-" + UUID.randomUUID()
    private val store = SecureStore(context, name)
    private val file = context.noBackupFilesDir.resolve("buri-$name.v1")

    // Independent reader/writer for the original version byte, 12-byte IV and
    // ciphertext with its 128-bit tag. Exercise older valid records on each OS.
    private fun v1Cipher(mode: Int, iv: ByteArray? = null): Cipher {
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = keys.getKey(context.packageName + ".burimunsi.operator.v1", null) as SecretKey
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
            updateAAD("burimunsi:$name:1".toByteArray(Charsets.UTF_8))
        }
    }

    private fun transform(cipher: Cipher, bytes: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        var offset = 0
        while (offset < bytes.size) {
            val count = minOf(8192, bytes.size - offset)
            cipher.update(bytes, offset, count)?.let(output::write)
            offset += count
        }
        output.write(cipher.doFinal())
        return output.toByteArray()
    }

    @Test fun validV1RecordsAndCurrentWritesAgreeThroughTheMaximumSize() {
        try {
            store.write("create the synthetic installation key")
            val originalText = """{"payer":"Élodie Uwase","note":"RWF · 7,500"}"""
            val originalCipher = v1Cipher(Cipher.ENCRYPT_MODE)
            val originalFile = byteArrayOf(1) + originalCipher.iv +
                originalCipher.doFinal(originalText.toByteArray(Charsets.UTF_8))
            file.writeBytes(originalFile)
            assertEquals(originalText, store.read())
            assertArrayEquals(originalFile, file.readBytes())

            for (size in listOf(0, 32_767, 32_768, 32_769, 200_003, 2_000_000)) {
                val bytes = ByteArray(size) { (32 + (it + it / 8192) % 95).toByte() }
                val text = bytes.toString(Charsets.UTF_8)
                val oldCipher = v1Cipher(Cipher.ENCRYPT_MODE)
                val legacy = byteArrayOf(1) + oldCipher.iv + transform(oldCipher, bytes)
                assertEquals(size + 29, legacy.size)
                file.writeBytes(legacy)
                assertEquals(text, SecureStore(context, name).read())
                assertEquals(text, store.readWithoutRepair())
                assertArrayEquals(legacy, file.readBytes())

                store.write(text)
                val current = file.readBytes()
                assertEquals(size + 29, current.size)
                assertEquals(1, current[0].toInt())
                val reader = v1Cipher(Cipher.DECRYPT_MODE, current.copyOfRange(1, 13))
                assertArrayEquals(bytes, transform(reader, current.copyOfRange(13, current.size)))
            }
        } finally {
            store.clear()
        }
    }

    @Test fun failedAuthenticationAndRejectedWritesKeepTheOriginalFileBytes() {
        try {
            store.write("Retained synthetic receipt ".repeat(10_000))
            val original = file.readBytes()
            assertTrue(runCatching { store.write("x".repeat(2_000_001)) }.exceptionOrNull() is IllegalArgumentException)
            assertArrayEquals(original, file.readBytes())

            val incomplete = original.copyOf(original.size - 1)
            file.writeBytes(incomplete)
            assertTrue(runCatching { store.read() }.exceptionOrNull() is BadPaddingException)
            assertTrue(runCatching { store.readWithoutRepair() }.exceptionOrNull() is BadPaddingException)
            assertArrayEquals(incomplete, file.readBytes())
        } finally {
            store.clear()
        }
    }
}
