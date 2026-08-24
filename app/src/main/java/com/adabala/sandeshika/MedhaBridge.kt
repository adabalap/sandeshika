package com.adabala.sandeshika

import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL

/**
 * The native half of the transport contract.
 *
 * In a browser, `static/js/data/transport.js` reaches Medha through the Flask
 * reverse proxy. Inside this APK there is no Flask server at all, so the same
 * module detects `window.AndroidMedha` and calls the methods here instead. The
 * two paths are interchangeable by design; `tests/transport.test.js` exercises
 * both and asserts that nothing falls through to `fetch()` when the bridge is
 * present.
 *
 * WHY MOST OF THIS IS ASYNCHRONOUS
 *
 * A `@JavascriptInterface` method returns a value to JavaScript synchronously,
 * which means the JS thread BLOCKS until Kotlin returns. That is fine for
 * reading a preference. It is unacceptable for a network call: a first-time
 * model load on the phone genuinely takes minutes, and a synchronous bridge
 * would freeze the entire interface for the duration — no scrolling, no
 * cancel button, and eventually an ANR.
 *
 * So anything that touches the network hands back immediately and delivers its
 * result later by calling `window.__medhaResolve(callId, json)` in the page.
 * The three instant, purely-local operations stay synchronous because a promise
 * round-trip for a SharedPreferences read is complexity with nothing to show
 * for it.
 *
 * THREADING
 *
 * Bridge methods are invoked on a private WebView binder thread, never the UI
 * thread. Network work is dispatched to IO from there; the resolve call is
 * marshalled back onto the UI thread, because `evaluateJavascript` must be
 * called from the thread that owns the WebView.
 */
class MedhaBridge(
    private val webView: WebView,
    private val settings: SettingsStore,
    private val scope: CoroutineScope,
) {

    companion object {
        const val NAME = "AndroidMedha"

        /** Ports Medha is commonly on, in the order they are worth trying. */
        private val DETECT_PORTS = intArrayOf(8001, 8080, 8000, 8081, 5001, 9090)

        /** Matches the browser build's default. */
        const val DEFAULT_URL = "http://127.0.0.1:8001"

        private const val CONNECT_TIMEOUT_MS = 5_000

        /**
         * Generation is slow on-device and a cold model load is slower still.
         * A shorter ceiling here turns a slow success into a failed import that
         * the user then re-runs, which makes the phone hotter and the next
         * attempt slower again.
         */
        private const val SLOW_READ_TIMEOUT_MS = 180_000
        private const val READ_TIMEOUT_MS = 20_000
        private val SLOW_PATHS = listOf("/generate", "/chat", "/rag/")

        /**
         * The proxy allowlist, mirroring ALLOWED in app.py.
         *
         * The APK has no Flask server to enforce it, so it is enforced here.
         * Without this the bridge is an open proxy onto Medha's entire API for
         * any script that reaches the page — and the page renders text taken
         * from SMS, which is attacker-controlled input by definition.
         */
        private val ALLOWED = Regex(
            "^/(health|generate(/stream)?|chat|store(/.*)?|connectors/sms/(status|messages|events))$"
        )
    }

    // ---------------------------------------------------------------------
    // Instant, local-only: synchronous is correct here
    // ---------------------------------------------------------------------

    @JavascriptInterface
    fun getConfig(): String {
        val token = settings.token()
        return JSONObject()
            .put("app", "Sandeshika")
            .put("version", BuildConfig.VERSION_NAME)
            .put("mock", false)
            .put("medhaUrl", settings.url() ?: DEFAULT_URL)
            .put("defaultMedhaUrl", DEFAULT_URL)
            .put("tokenConfigured", !token.isNullOrBlank())
            .put("tokenPreview", mask(token))
            .put("tokenSource", if (token.isNullOrBlank()) "none" else "saved")
            .put("urlSource", if (settings.url() == null) "default" else "saved")
            .put("envTokenPresent", false)
            // Asset-loader pages are served over https, so the app is always in
            // a secure context here and every PWA capability is available.
            .put("installable", true)
            .put("smsEnabled", BuildConfig.SMS_ENABLED)
            .toString()
    }

    @JavascriptInterface
    fun clearSettings(): String {
        settings.clear()
        return JSONObject().put("cleared", true).toString()
    }

    // ---------------------------------------------------------------------
    // Network-bound: hand back immediately, resolve later
    // ---------------------------------------------------------------------

    /**
     * One API call to Medha.
     *
     * Failures are reported IN BAND — `{status, error}` — rather than thrown,
     * because an exception cannot cross the JNI boundary into JavaScript in any
     * useful form. `transport.js` re-raises anything with a status of 400 or
     * above as a real error, so the rest of the app handles it exactly as it
     * handles an HTTP failure in the browser.
     */
    @JavascriptInterface
    fun requestAsync(method: String, path: String, body: String?, headersJson: String?, callId: String) {
        scope.launch(Dispatchers.IO) {
            resolve(callId, performRequest(method, path, body, headersJson))
        }
    }

    /**
     * Verifies the address and token against a live Medha before saving.
     *
     * Saving first and discovering later is how someone ends up with a wrong
     * token persisted and a confusing 401 on the next screen. If it does not
     * work, it is not written.
     */
    @JavascriptInterface
    fun saveSettingsAsync(medhaUrl: String, token: String, callId: String) {
        scope.launch(Dispatchers.IO) {
            resolve(callId, performSave(medhaUrl, token))
        }
    }

    /** Scans the usual ports. Removes the commonest setup failure: right token, wrong port. */
    @JavascriptInterface
    fun detectAsync(callId: String) {
        scope.launch(Dispatchers.IO) {
            resolve(callId, performDetect())
        }
    }

    // ---------------------------------------------------------------------
    // Synchronous fallbacks
    //
    // Kept so an older bundle — a cached page from before the async bridge
    // existed — still works rather than silently doing nothing. They block the
    // calling thread, which is exactly why the async variants exist and why
    // transport.js prefers them whenever they are present.
    // ---------------------------------------------------------------------

    @JavascriptInterface
    fun request(method: String, path: String, body: String?, headersJson: String?): String =
        performRequest(method, path, body, headersJson).toString()

    @JavascriptInterface
    fun saveSettings(medhaUrl: String, token: String): String =
        performSave(medhaUrl, token).toString()

    @JavascriptInterface
    fun detect(): String = performDetect().toString()

    // ---------------------------------------------------------------------
    // Implementation
    // ---------------------------------------------------------------------

    private fun performRequest(
        method: String,
        path: String,
        body: String?,
        headersJson: String?,
    ): JSONObject {
        val clean = path.substringBefore('?')
        if (!ALLOWED.matches(clean)) {
            return err(403, "This client may not call $clean.")
        }

        val base = settings.url() ?: DEFAULT_URL
        val token = settings.token()
        val slow = SLOW_PATHS.any { clean.startsWith(it) }

        return try {
            val conn = (URL(base + path).openConnection() as HttpURLConnection).apply {
                requestMethod = method.uppercase()
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = if (slow) SLOW_READ_TIMEOUT_MS else READ_TIMEOUT_MS
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                if (!token.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $token")
                applyHeaders(headersJson, this)
                if (!body.isNullOrEmpty()) {
                    doOutput = true
                    outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
            }

            val status = conn.responseCode
            val text = (if (status >= 400) conn.errorStream else conn.inputStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val retryAfter = conn.getHeaderField("Retry-After")?.toIntOrNull() ?: 0
            conn.disconnect()

            if (status >= 400) {
                // Prefer Medha's own wording: it names the missing capability,
                // which a generic status code cannot.
                err(status, extractError(text) ?: "HTTP $status", retryAfter)
            } else {
                JSONObject().put("status", status).put("body", parseLoose(text))
            }
        } catch (e: SocketTimeoutException) {
            err(504, "Medha did not respond in time. If a model is loading for the first " +
                "time this can take a few minutes — try again shortly.")
        } catch (e: IOException) {
            err(502, "Cannot reach Medha at $base. Check it is running and that the " +
                "address in Setup matches the port it shows.")
        } catch (e: Exception) {
            err(500, "The bridge failed: ${e.javaClass.simpleName}")
        }
    }

    private fun performSave(medhaUrl: String, token: String): JSONObject {
        val url = medhaUrl.trim().trimEnd('/')

        val why = validateUrl(url)
        if (why != null) return JSONObject().put("error", why)

        /*
         * The Setup screen shows a masked preview like "ac03…e4b4". Pasting
         * that back is a mistake people make constantly, and saving it produces
         * a 401 whose cause is invisible. Catch it by shape.
         */
        if (token.contains('…') || token.contains("...")) {
            return JSONObject().put("error",
                "That looks like the masked preview rather than the token itself. " +
                "Copy the full value from Medha → API clients.")
        }

        val existing = settings.token()
        val effective = if (token.isBlank() && !existing.isNullOrBlank()) existing else token
        if (effective.isBlank()) {
            return JSONObject().put("error", "No token yet — paste one from Medha → API clients.")
        }

        val probe = probe(url, effective)
        if (!probe.optBoolean("reachable")) {
            return JSONObject().put("error",
                "Nothing answered at $url. Check Medha is running and the port matches.")
        }
        if (!probe.optBoolean("tokenOk")) {
            return JSONObject().put("error", "Medha rejected that token.")
        }

        settings.save(url, effective)
        return JSONObject()
            .put("ok", true)
            .put("medhaUrl", url)
            .put("tokenPreview", mask(effective))
            .put("modelLoaded", probe.optBoolean("modelLoaded"))
    }

    private fun performDetect(): JSONObject {
        val found = JSONArray()
        val tried = JSONArray()
        val token = settings.token().orEmpty()

        for (port in DETECT_PORTS) {
            val url = "http://127.0.0.1:$port"
            tried.put(port)
            val p = probe(url, token)
            if (p.optBoolean("reachable")) {
                found.put(
                    JSONObject()
                        .put("url", url)
                        .put("modelLoaded", p.optBoolean("modelLoaded"))
                        // null, not false, when there is no token to test with:
                        // "rejected" and "not tried" are different states and the
                        // Setup screen says different things about them.
                        .put("tokenOk", if (token.isBlank()) JSONObject.NULL else p.optBoolean("tokenOk"))
                )
            }
        }
        return JSONObject()
            .put("found", found)
            .put("tried", tried)
            .put("current", settings.url() ?: DEFAULT_URL)
    }

    /** Is something answering here, and does it accept our token? */
    private fun probe(url: String, token: String): JSONObject {
        val out = JSONObject().put("reachable", false)
        try {
            val conn = (URL("$url/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 2_500
                readTimeout = 2_500
            }
            if (conn.responseCode !in 200..299) {
                conn.disconnect()
                return out
            }
            val health = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            conn.disconnect()
            out.put("reachable", true).put("modelLoaded", health.optBoolean("modelLoaded"))
        } catch (e: Exception) {
            return out
        }

        if (token.isBlank()) return out.put("tokenOk", false)

        return try {
            val conn = (URL("$url/store?prefix=meta/&limit=1").openConnection() as HttpURLConnection)
                .apply {
                    connectTimeout = 3_000
                    readTimeout = 3_000
                    setRequestProperty("Authorization", "Bearer $token")
                }
            val ok = conn.responseCode in 200..299
            conn.disconnect()
            out.put("tokenOk", ok)
        } catch (e: Exception) {
            out.put("tokenOk", false)
        }
    }

    /**
     * Loopback only, and a port is required.
     *
     * Mirrors `validate_url` in app.py. Medha listens on 127.0.0.1 and nowhere
     * else; anything beyond loopback is either a typo or an attempt to point
     * the app's stored token at a host that should never see it.
     */
    private fun validateUrl(url: String): String? {
        val m = Regex("^http://([0-9.]+|localhost)(?::(\\d+))?$").find(url)
            ?: return "The address should look like http://127.0.0.1:8001"
        val host = m.groupValues[1]
        val port = m.groupValues[2]

        if (host != "localhost" && host != "127.0.0.1") {
            return "Medha only listens on 127.0.0.1. Use http://127.0.0.1:<port>."
        }
        if (port.isEmpty()) return "Include the port, for example http://127.0.0.1:8001"
        val p = port.toIntOrNull() ?: return "That port is not a number."
        if (p !in 1..65535) return "That port is out of range."
        return null
    }

    private fun applyHeaders(headersJson: String?, conn: HttpURLConnection) {
        if (headersJson.isNullOrBlank()) return
        try {
            val h = JSONObject(headersJson)
            for (key in h.keys()) {
                // Authorization is set from stored settings above. Letting the
                // page override it would let any script on the page substitute
                // a token of its choosing.
                if (key.equals("Authorization", ignoreCase = true)) continue
                conn.setRequestProperty(key, h.optString(key))
            }
        } catch (e: Exception) {
            // Malformed headers are not worth failing a request over.
        }
    }

    /** A body may be JSON, an array, or empty. Returning it raw keeps the page in charge. */
    private fun parseLoose(text: String): Any = when {
        text.isBlank() -> JSONObject()
        text.startsWith("[") -> try { JSONArray(text) } catch (e: Exception) { text }
        text.startsWith("{") -> try { JSONObject(text) } catch (e: Exception) { text }
        else -> text
    }

    private fun extractError(text: String): String? = try {
        JSONObject(text).optString("error").ifBlank { null }
    } catch (e: Exception) {
        null
    }

    private fun err(status: Int, message: String, retryAfter: Int = 0): JSONObject =
        JSONObject().put("status", status).put("error", message).put("retryAfter", retryAfter)

    private fun mask(token: String?): String {
        if (token.isNullOrBlank()) return ""
        return if (token.length <= 12) "set" else "${token.take(4)}…${token.takeLast(4)}"
    }

    /**
     * Delivers an async result back into the page.
     *
     * The payload is passed as a JSON string literal rather than interpolated
     * as code: a Medha error message can contain quotes and newlines, and
     * splicing that into a JavaScript expression would break the call at best
     * and execute it at worst.
     */
    private fun resolve(callId: String, payload: JSONObject) {
        val encoded = JSONObject.quote(payload.toString())
        val script = "window.__medhaResolve && window.__medhaResolve(" +
            "${JSONObject.quote(callId)}, $encoded);"
        webView.post {
            try {
                webView.evaluateJavascript(script, null)
            } catch (e: Exception) {
                // The page was torn down mid-flight; the caller is gone too.
            }
        }
    }
}
