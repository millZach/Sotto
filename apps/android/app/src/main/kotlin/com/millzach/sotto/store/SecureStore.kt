package com.millzach.sotto.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.millzach.sotto.core.ClientError
import com.millzach.sotto.core.SottoJson
import kotlinx.serialization.KSerializer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Byte storage the app model reads and writes through; replaceable in tests.
interface ItemStore {
    fun read(account: String): String?
    fun write(account: String, value: String)
    fun remove(account: String)
    fun accounts(): List<String>
}

// Each saved item is encrypted with an AES key that lives in the Android Keystore and never leaves this
// device; the app's preferences hold only ciphertext and are excluded from backup and device transfer.
class KeystoreItems(context: Context) : ItemStore {
    private val prefs = context.getSharedPreferences("sotto.secure", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun read(account: String): String? {
        val stored = prefs.getString(account, null) ?: return null
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
            String(cipher.doFinal(bytes, 12, bytes.size - 12), Charsets.UTF_8)
        } catch (_: Exception) {
            throw SecureStore.Undecodable(account)
        }
    }

    override fun write(account: String, value: String) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            if (!prefs.edit().putString(account, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()) throw SecureStore.failure
        } catch (error: ClientError) {
            throw error
        } catch (_: Exception) {
            throw SecureStore.failure
        }
    }

    override fun remove(account: String) {
        if (!prefs.edit().remove(account).commit()) throw SecureStore.failure
    }

    override fun accounts(): List<String> = prefs.all.keys.toList()

    private companion object {
        const val ALIAS = "sotto.host-client"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}

// JSON on top of the item bytes, shared by the app and its tests.
class SecureStore(private val items: ItemStore) {
    // An item that is there but cannot be read back, as against one that is missing.
    class Undecodable(val account: String) : Exception("undecodable $account")

    fun <T> read(serializer: KSerializer<T>, account: String): T? {
        val text = items.read(account) ?: return null
        return try { SottoJson.decodeFromString(serializer, text) } catch (_: Exception) { throw Undecodable(account) }
    }

    fun <T> write(serializer: KSerializer<T>, value: T, account: String) = items.write(account, SottoJson.encodeToString(serializer, value))
    fun remove(account: String) = items.remove(account)
    fun accounts(): List<String> = items.accounts()

    // Verify writes before spending a one-use pairing code.
    fun checkWritable() {
        items.write("pairing-storage-check", "true")
        items.remove("pairing-storage-check")
    }

    companion object {
        const val INDEX = "computers"
        const val RECOVERED_INDEX = "computers.recovered"
        const val PENDING = "pending"
        const val NOTICES = "recovery-notices"
        fun account(hostID: String) = "computer.$hostID"

        val failure = ClientError.Rejected("Sotto could not open secure storage on this phone. Unlock it and return to Sotto.")
    }
}
