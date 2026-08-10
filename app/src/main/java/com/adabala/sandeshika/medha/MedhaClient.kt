package com.adabala.sandeshika.medha

import com.adabala.sandeshika.config.AppConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Client for the Medha inference substrate on loopback.
 *
 * Sandeshika needs no INTERNET permission for this: loopback traffic does not
 * require it. That makes "this app cannot reach the network" a manifest-level
 * fact any user can verify in Settings, rather than a promise in a README.
 *
 * ## Medha is a scarce resource, not a service
 *
 * One native engine behind one mutex. Concurrency is not a lever -- ordering
 * and pacing are, and Medha's InferenceScheduler already implements both:
 * INTERACTIVE ahead of BATCH, thermal hysteresis at 0.85/0.70 headroom, a
 * battery floor, a bounded queue returning 429, and a 120s request ceiling.
 *
 * So this client does NOT reimplement gating. It states its priority honestly
 * and honours backpressure. A 429 or a thermal rejection is the system working
 * correctly, and must surface as "catching up", never as a failure.
 */
class MedhaClient(
    private val baseUrl: String,
    private val token: String,
    connectTimeoutSeconds: Long = 5,
    readTimeoutSeconds: Long = 180
) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(connectTimeoutSeconds, TimeUnit.SECONDS)
        .readTimeout(readTimeoutSeconds, TimeUnit.SECONDS)
        // One engine, one mutex: parallel calls queue on the server anyway and
        // just burn sockets and battery waiting.
        .dispatcher(Dispatcher().apply { maxRequests = 2; maxRequestsPerHost = 2 })
        .retryOnConnectionFailure(false)
        .build()

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    enum class Priority(val header: String?) {
        /** A human is watching a spinner. Never thermally blocked. */
        INTERACTIVE(null),
        /** Backlog work. Gated on thermal + battery; yields to interactive. */
        BATCH("batch")
    }

    sealed interface State {
        data object Ready : State
        data object Warming : State
        data class Throttled(val reason: String) : State
        data object Offline : State
        data object Unauthorised : State
        data object NoEmbedder : State
    }

    sealed interface Outcome<out T> {
        data class Ok<T>(val value: T) : Outcome<T>
        /** Queue full or thermally gated. Retry later; this is not an error. */
        data class Backpressure(val retryAfterSeconds: Int) : Outcome<Nothing>
        data class Failed(val message: String, val code: Int? = null) : Outcome<Nothing>
    }

    // ── status ─────────────────────────────────────────────────────────

    suspend fun health(): State = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url("$baseUrl/health").get().build()).execute().use { r ->
                if (r.code == 401 || r.code == 403) return@use State.Unauthorised
                val body = r.body?.string().orEmpty()
                val o = json.parseToJsonElement(body).jsonObject
                when {
                    o["modelLoaded"]?.jsonPrimitive?.booleanOrNull != true -> State.Warming
                    o["busy"]?.jsonPrimitive?.booleanOrNull == true -> State.Ready
                    else -> State.Ready
                }
            }
        }.getOrElse { State.Offline }
    }

    /** Gate reason when batch work is paused, for honest UI copy. */
    suspend fun schedulerStatus(): JsonObject? = withContext(Dispatchers.IO) {
        runCatching {
            http.newCall(Request.Builder().url("$baseUrl/scheduler").get().build()).execute().use { r ->
                json.parseToJsonElement(r.body?.string().orEmpty()).jsonObject
            }
        }.getOrNull()
    }

    // ── generation ─────────────────────────────────────────────────────

    suspend fun generate(
        prompt: String,
        system: String? = null,
        priority: Priority = Priority.BATCH
    ): Outcome<String> = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("prompt", prompt)
            if (system != null) put("system", system)
        }
        post("/generate", payload, priority) { o ->
            o["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
        }
    }

    /**
     * Extraction with a JSON contract.
     *
     * Medha has no responseFormat parameter yet, so the schema is asserted in
     * the prompt and validated here. Fence-stripping is necessary because a
     * 2B-class model wraps JSON in markdown roughly half the time regardless
     * of instruction.
     *
     * When responseFormat lands in Medha, delete the local repair path: the
     * retry belongs INSIDE one scheduler admission, or it deadlocks behind
     * other queued work.
     */
    suspend fun extractJson(
        prompt: String,
        system: String,
        priority: Priority = Priority.BATCH
    ): Outcome<JsonObject> {
        return when (val r = generate(prompt, system, priority)) {
            is Outcome.Ok -> runCatching {
                Outcome.Ok(json.parseToJsonElement(stripFences(r.value)).jsonObject)
            }.getOrElse { Outcome.Failed("unparseable JSON: ${r.value.take(160)}") }
            is Outcome.Backpressure -> r
            is Outcome.Failed -> r
        }
    }

    private fun stripFences(s: String): String =
        s.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()

    private inline fun <T> post(
        path: String,
        payload: JsonObject,
        priority: Priority,
        transform: (JsonObject) -> T
    ): Outcome<T> = runCatching {
        val req = Request.Builder()
            .url("$baseUrl$path")
            .addHeader("Authorization", "Bearer $token")
            .apply { priority.header?.let { addHeader("X-Medha-Priority", it) } }
            .post(payload.toString().toRequestBody(JSON_MEDIA))
            .build()

        http.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            when {
                r.code == 429 -> Outcome.Backpressure(
                    r.header("Retry-After")?.toIntOrNull() ?: 30
                )
                r.code == 401 || r.code == 403 ->
                    Outcome.Failed("token rejected -- re-pair with Medha", r.code)
                !r.isSuccessful -> Outcome.Failed(body.take(200), r.code)
                else -> Outcome.Ok(transform(json.parseToJsonElement(body).jsonObject))
            }
        }
    }.getOrElse { Outcome.Failed(it.message ?: "medha unreachable") }

    companion object {
        suspend fun from(cfg: AppConfig.Snapshot, token: String) = MedhaClient(
            baseUrl = cfg.medhaBaseUrl,
            token = token,
            connectTimeoutSeconds = cfg.connectTimeoutSeconds,
            readTimeoutSeconds = cfg.readTimeoutSeconds
        )
    }
}
