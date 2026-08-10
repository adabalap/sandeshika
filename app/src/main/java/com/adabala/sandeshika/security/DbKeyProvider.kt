package com.adabala.sandeshika.security

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.SecureRandom

/**
 * Supplies the SQLCipher passphrase.
 *
 * The passphrase is random, generated once, and stored in
 * EncryptedSharedPreferences whose own master key lives in the Android
 * Keystore -- so the key that protects the message database is itself
 * hardware-backed and never present in the APK or in .env.
 *
 * This is why MEDHA_TOKEN is the only secret .env mentions, and even that is
 * blank by default: baking secrets into a build artefact is how they end up
 * in a git history.
 */
object DbKeyProvider {

    private const val FILE = "sandeshika_keys"
    private const val KEY = "db_passphrase"
    private const val BYTES = 32

    fun passphrase(ctx: Context): ByteArray {
        val prefs = EncryptedSharedPreferences.create(
            ctx,
            FILE,
            MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
        prefs.getString(KEY, null)?.let { return hexToBytes(it) }

        val fresh = ByteArray(BYTES).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(KEY, bytesToHex(fresh)).apply()
        return fresh
    }

    /** Wipes the key, which renders the database permanently unreadable. */
    fun destroy(ctx: Context) {
        EncryptedSharedPreferences.create(
            ctx, FILE,
            MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        ).edit().clear().apply()
    }

    private fun bytesToHex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun hexToBytes(s: String) =
        ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
