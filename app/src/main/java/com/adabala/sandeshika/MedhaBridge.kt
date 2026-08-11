package com.adabala.sandeshika

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The bridge that replaces the Flask proxy.
 *
 * ## Why a native bridge and not fetch() straight to Medha
 *
 * The WebView loads from `https://appassets.androidplatform.net/`, which is a
 * different origin from `http://127.0.0.1:8080`. A direct fetch would be a
 * cross-origin request to a plaintext origin: Medha's CORS policy would reject
 * it, and mixed-content rules would block it before that. Routing through
 * native sidesteps both — and keeps the API token out of JavaScript entirely,
 * which is the same property the Flask proxy existed to preserve.
 *
 * ## Threading
 *
 * `@JavascriptInterface` methods are invoked on a WebView worker thread, and
 * anything slow there stalls JS. So calls are fire-and-forget: JS passes a
 * request id, the work happens on a coroutine, and the result is delivered by
 * evaluating a resolver function back on the UI thread. The JS side wraps that
 * in a Promise, so callers just `await`.
 */
class MedhaBridge(
    private val context: Context,
    private val webView: WebView,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val prefs: SharedPreferences by lazy {
        // The token grants access to everything this client can reach in Medha,
        // so it is encrypted at rest rather than sitting in plain prefs.
        runCatching {
            val key = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context, "sandeshika_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ) as SharedPreferences
        }.getOrElse {
            // Keystore failures happen on a few OEM builds. Degrade to plain
            // prefs rather than leaving the app unusable; the file is still
            // inside the app sandbox.
            Log.w(TAG, "EncryptedSharedPreferences unavailable; falling back", it)
            context.getSharedPreferences("sandeshika", Context.MODE_PRIVATE)
        }
    }

    private var medhaUrl: String
        get() = prefs.getString(KEY_URL, DEFAULT_URL) ?: DEFAULT_URL
        set(v) = prefs.edit().putString(KEY_URL, v).apply()

    private var token: String
        get() = prefs.getString(KEY_TOKEN, "") ?: ""
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    // ------------------------------ config ------------------------------

    /** Cheap and synchronous: read from prefs, no network. */
    @JavascriptInterface
    fun getConfig(): String = JSONObject().apply {
        put("app", "Sandeshika")
        put("native", true)
        put("mock", false)
        put("medhaUrl", medhaUrl)
        put("defaultMedhaUrl", DEFAULT_URL)
        put("tokenConfigured", token.isNotEmpty())
        put("tokenPreview", mask(token))
        put("tokenSource", if (token.isEmpty()) "none" else "saved")
        put("urlSource", "saved")
        put("envTokenPresent", false)
        put("installable", false)   // already installed; hide the PWA prompt
    }.toString()

    /**
     * Validates before saving. Storing a token that does not work just moves
     * the failure somewhere less obvious.
     */
    @JavascriptInterface
    fun saveSettings(id: String, url: String, newToken: String) {
        scope.launch {
            val cleanUrl = url.trim().trimEnd('/')
            if (!Regex("^https?://[\\w.\\-]+(:\\d{1,5})?$").matches(cleanUrl)) {
                resolve(id, 400, err("'$cleanUrl' is not a valid address, e.g. http://127.0.0.1:8001"))
                return@launch
            }
            // Blank means "keep the saved one" so the port can be changed
            // without re-pasting a credential that cannot be read back.
            val useToken = newToken.trim().ifEmpty { token }
            if (useToken.isEmpty()) {
                resolve(id, 400, err("A Medha API token is required"))
                return@launch
            }

            val health = call("GET", "$cleanUrl/health", null, null, null)
            if (health.first != 200) {
                resolve(id, 502, err(
                    "Nothing answered at $cleanUrl. Check Medha is running and the port matches."
                ))
                return@launch
            }
            val probe = call("GET", "$cleanUrl/store?prefix=meta/&limit=1", null, useToken, null)
            if (probe.first == 401 || probe.first == 403) {
                resolve(id, 401, err(
                    "Medha rejected that token. Check it was copied in full, and that the client " +
                        "has the store capability."
                ))
                return@launch
            }

            medhaUrl = cleanUrl
            token = useToken
            val loaded = runCatching { JSONObject(health.second).optBoolean("modelLoaded") }
                .getOrDefault(false)
            resolve(id, 200, JSONObject().apply {
                put("ok", true)
                put("medhaUrl", cleanUrl)
                put("tokenPreview", mask(useToken))
                put("modelLoaded", loaded)
            }.toString())
        }
    }

    @JavascriptInterface
    fun clearSettings(id: String) {
        prefs.edit().remove(KEY_TOKEN).apply()
        resolve(id, 200, JSONObject().put("cleared", true).toString())
    }

    // ------------------------------ requests ------------------------------

    /**
     * Proxies one call to Medha. [path] is the API path without a leading
     * slash, e.g. "connectors/sms/messages?limit=50".
     */
    @JavascriptInterface
    fun request(id: String, method: String, path: String, body: String?, priority: String?) {
        scope.launch {
            if (!ALLOWED.matches(path.substringBefore('?'))) {
                resolve(id, 403, err("endpoint not permitted: $path"))
                return@launch
            }
            if (token.isEmpty()) {
                resolve(id, 401, err("No Medha token saved yet — add one in Setup."))
                return@launch
            }
            val (status, text) = call(method, "$medhaUrl/$path", body, token, priority)
            resolve(id, status, text)
        }
    }

    private suspend fun call(
        method: String,
        url: String,
        body: String?,
        bearer: String?,
        priority: String?,
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        runCatching {
            val c = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 8000
                // Generation on a phone can legitimately take minutes; a short
                // read timeout would abort work that was progressing fine.
                readTimeout = 180_000
                setRequestProperty("Content-Type", "application/json")
                bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
                // Carries Medha's thermal gating for bulk imports.
                priority?.takeIf { it.isNotEmpty() }
                    ?.let { setRequestProperty("X-Medha-Priority", it) }
                if (body != null && method != "GET") {
                    doOutput = true
                    outputStream.use { it.write(body.toByteArray()) }
                }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            c.disconnect()
            code to text
        }.getOrElse { e ->
            502 to err(
                "Cannot reach Medha at $medhaUrl — is the service running? (${e.javaClass.simpleName})"
            )
        }
    }

    // ------------------------------ plumbing ------------------------------

    private fun resolve(id: String, status: Int, text: String) {
        val payload = JSONObject().apply {
            put("status", status)
            put("body", text)
        }.toString()
        webView.post {
            // Passing through a JSON string literal avoids any quoting problems
            // with response bodies that contain quotes or newlines.
            webView.evaluateJavascript(
                "window.__medhaResolve(${JSONObject.quote(id)}, ${JSONObject.quote(payload)});",
                null,
            )
        }
    }

    private fun err(msg: String) = JSONObject().put("error", msg).put("code", "bridge").toString()

    private fun mask(t: String) = when {
        t.isEmpty() -> ""
        t.length > 12 -> t.take(6) + "…" + t.takeLast(4)
        else -> "set"
    }

    companion object {
        private const val TAG = "MedhaBridge"
        private const val DEFAULT_URL = "http://127.0.0.1:8080"
        private const val KEY_URL = "medha_url"
        private const val KEY_TOKEN = "medha_token"

        /** Same allowlist the Flask proxy enforced. */
        private val ALLOWED = Regex(
            "^(health|system|metrics|scheduler" +
                "|generate|generate/stream|chat" +
                "|store(/.*)?|sessions(/.*)?" +
                "|connectors/sms/(status|conversations|messages|messages/\\d+|contacts/.+|mark-read|events)" +
                "|notify(/.*)?|rag/(ingest|query|collections|reindex))$"
        )
    }
}
