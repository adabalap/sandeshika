package com.adabala.sandeshika.config

import android.content.Context
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import com.adabala.sandeshika.BuildConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

private val Context.settingsStore by preferencesDataStore(name = "sandeshika_settings")

/**
 * Resolved configuration = BuildConfig (.env at compile time) with a DataStore
 * override layered on top.
 *
 * Why both. Baking .env into BuildConfig gives a build that works with no
 * setup and no first-run wizard. But Medha's port is chosen by the user in
 * *another app*, and can change any time — so anything a user might need to
 * change after install must also be editable at runtime. Build-time-only
 * config would mean "recompile to change a port", which is not a real product.
 *
 * The token is deliberately NOT here: it lives in [SecureStore], because
 * DataStore Preferences is plaintext on disk.
 */
class AppConfig private constructor(private val ctx: Context) {

    // ── Medha ──────────────────────────────────────────────────────────
    val medhaHost: Flow<String> = str(Keys.MEDHA_HOST, BuildConfig.MEDHA_HOST)
    val medhaPort: Flow<Int> = int(Keys.MEDHA_PORT, BuildConfig.MEDHA_PORT)
    val medhaEnabled: Flow<Boolean> = bool(Keys.MEDHA_ENABLED, BuildConfig.MEDHA_ENABLED)

    val medhaBaseUrl: Flow<String> =
        ctx.settingsStore.data.map { p ->
            val h = p[Keys.MEDHA_HOST] ?: BuildConfig.MEDHA_HOST
            val port = p[Keys.MEDHA_PORT] ?: BuildConfig.MEDHA_PORT
            "http://$h:$port"
        }

    // ── Ingestion ──────────────────────────────────────────────────────
    val sweepMinutes: Flow<Int> = int(Keys.SWEEP_MINUTES, BuildConfig.INGEST_SWEEP_MINUTES)
    val historyDays: Flow<Int> = int(Keys.HISTORY_DAYS, BuildConfig.INGEST_HISTORY_DAYS)

    // ── Privacy ────────────────────────────────────────────────────────
    val requireBiometric: Flow<Boolean> = bool(Keys.REQUIRE_BIOMETRIC, BuildConfig.REQUIRE_BIOMETRIC)
    val otpRetentionHours: Flow<Int> = int(Keys.OTP_RETENTION_HOURS, BuildConfig.OTP_RETENTION_HOURS)

    suspend fun set(key: Preferences.Key<Int>, v: Int) { ctx.settingsStore.edit { it[key] = v } }
    suspend fun set(key: Preferences.Key<String>, v: String) { ctx.settingsStore.edit { it[key] = v } }
    suspend fun set(key: Preferences.Key<Boolean>, v: Boolean) { ctx.settingsStore.edit { it[key] = v } }
    suspend fun reset(key: Preferences.Key<*>) { ctx.settingsStore.edit { it.remove(key) } }

    /** Workers run off the main thread and need a value, not a Flow. */
    suspend fun snapshot(): Snapshot {
        val p = ctx.settingsStore.data.first()
        return Snapshot(
            medhaBaseUrl = "http://${p[Keys.MEDHA_HOST] ?: BuildConfig.MEDHA_HOST}:" +
                    "${p[Keys.MEDHA_PORT] ?: BuildConfig.MEDHA_PORT}",
            medhaEnabled = p[Keys.MEDHA_ENABLED] ?: BuildConfig.MEDHA_ENABLED,
            backfillPageSize = BuildConfig.INGEST_BACKFILL_PAGE_SIZE,
            backfillMaxMessages = BuildConfig.INGEST_BACKFILL_MAX_MESSAGES,
            historyDays = p[Keys.HISTORY_DAYS] ?: BuildConfig.INGEST_HISTORY_DAYS,
            observerDebounceMs = BuildConfig.INGEST_OBSERVER_DEBOUNCE_MS.toLong(),
            otpRetentionHours = p[Keys.OTP_RETENTION_HOURS] ?: BuildConfig.OTP_RETENTION_HOURS,
            templateMergeRatio = BuildConfig.TEMPLATE_MERGE_RATIO,
            templatePrefixTokens = BuildConfig.TEMPLATE_PREFIX_TOKENS,
            batchSize = BuildConfig.MEDHA_BATCH_SIZE,
            maxRetries = BuildConfig.MEDHA_MAX_RETRIES,
            retryBaseSeconds = BuildConfig.MEDHA_RETRY_BASE_SECONDS,
            connectTimeoutSeconds = BuildConfig.MEDHA_CONNECT_TIMEOUT_SECONDS.toLong(),
            readTimeoutSeconds = BuildConfig.MEDHA_READ_TIMEOUT_SECONDS.toLong()
        )
    }

    data class Snapshot(
        val medhaBaseUrl: String,
        val medhaEnabled: Boolean,
        val backfillPageSize: Int,
        val backfillMaxMessages: Int,
        val historyDays: Int,
        val observerDebounceMs: Long,
        val otpRetentionHours: Int,
        val templateMergeRatio: Float,
        val templatePrefixTokens: Int,
        val batchSize: Int,
        val maxRetries: Int,
        val retryBaseSeconds: Int,
        val connectTimeoutSeconds: Long,
        val readTimeoutSeconds: Long
    )

    private fun str(k: Preferences.Key<String>, d: String) =
        ctx.settingsStore.data.map { it[k] ?: d }
    private fun int(k: Preferences.Key<Int>, d: Int) =
        ctx.settingsStore.data.map { it[k] ?: d }
    private fun bool(k: Preferences.Key<Boolean>, d: Boolean) =
        ctx.settingsStore.data.map { it[k] ?: d }

    object Keys {
        val MEDHA_HOST = stringPreferencesKey("medha_host")
        val MEDHA_PORT = intPreferencesKey("medha_port")
        val MEDHA_ENABLED = booleanPreferencesKey("medha_enabled")
        val SWEEP_MINUTES = intPreferencesKey("sweep_minutes")
        val HISTORY_DAYS = intPreferencesKey("history_days")
        val REQUIRE_BIOMETRIC = booleanPreferencesKey("require_biometric")
        val OTP_RETENTION_HOURS = intPreferencesKey("otp_retention_hours")
    }

    companion object {
        @Volatile private var inst: AppConfig? = null
        fun get(ctx: Context): AppConfig = inst ?: synchronized(this) {
            inst ?: AppConfig(ctx.applicationContext).also { inst = it }
        }
    }
}
