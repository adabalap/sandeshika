package com.adabala.sandeshika

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Where the Medha address and token live.
 *
 * The token is a bearer credential for an API that can read every SMS on the
 * phone. It is held in EncryptedSharedPreferences, backed by a key in the
 * Android keystore, so it is not readable from a backup, from adb on a rooted
 * device, or by anything that can read the app's data directory.
 *
 * It is deliberately NOT kept in the WebView's localStorage. Anything running
 * in the page could read it there, and the page renders text derived from SMS
 * — attacker-controlled input by definition. The page never sees the token at
 * all: it asks the bridge to make a call, and the bridge attaches the header.
 */
class SettingsStore(context: Context) {

    /**
     * True when the encrypted store could not be opened and plain preferences
     * are in use instead.
     *
     * Declared BEFORE `prefs` on purpose. Kotlin runs initialisers in
     * declaration order, so a `var degraded = false` declared afterwards would
     * execute second and overwrite the `true` set inside the catch below —
     * silently reporting a healthy keystore on exactly the devices where it
     * failed.
     */
    var degraded: Boolean = false
        private set

    private val prefs: SharedPreferences = try {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "sandeshika.secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        /*
         * Keystore initialisation genuinely fails on some devices — a corrupted
         * keystore after an OS upgrade is the usual cause. Falling back to plain
         * preferences keeps the app usable rather than bricking it on the setup
         * screen. It is a real downgrade, so it is recorded and surfaced in
         * diagnostics rather than hidden.
         */
        degraded = true
        context.getSharedPreferences("sandeshika.fallback", Context.MODE_PRIVATE)
    }

    fun url(): String? = prefs.getString(KEY_URL, null)?.ifBlank { null }

    fun token(): String? = prefs.getString(KEY_TOKEN, null)?.ifBlank { null }

    fun save(url: String, token: String) {
        prefs.edit().putString(KEY_URL, url).putString(KEY_TOKEN, token).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).apply()
    }

    private companion object {
        const val KEY_URL = "medha_url"
        const val KEY_TOKEN = "medha_token"
    }
}
