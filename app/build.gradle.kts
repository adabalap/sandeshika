import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

// ════════════════════════════════════════════════════════════════════════
//  .env loader
//
//  Precedence, highest first:
//     1. process environment  (CI:  SANDESHIKA_MEDHA_PORT=9000 ./gradlew)
//     2. .env                 (developer machine, gitignored)
//     3. .env.example         (committed default of record)
//
//  .env.example is loaded as the base layer rather than as a fallback for
//  missing keys only. That way adding a key to the example file gives every
//  developer a working default without them having to re-copy their .env,
//  and a build never fails because someone's months-old .env predates a new
//  setting.
// ════════════════════════════════════════════════════════════════════════
val env: Map<String, String> = run {
    fun read(f: File): Map<String, String> =
        if (!f.exists()) emptyMap()
        else Properties().apply { f.inputStream().use { load(it) } }
            .entries.associate { (k, v) -> k.toString() to v.toString().trim() }

    val example = read(rootProject.file(".env.example"))
    val local = read(rootProject.file(".env"))
    val merged = (example + local).toMutableMap()

    // Process env wins. Prefixed to avoid colliding with unrelated CI vars.
    merged.keys.toList().forEach { key ->
        System.getenv("SANDESHIKA_$key")?.takeIf { it.isNotBlank() }?.let { merged[key] = it }
    }
    if (local.isEmpty()) {
        logger.lifecycle("Sandeshika: no .env found — using .env.example defaults. " +
                "Run `cp .env.example .env` to customise.")
    }
    merged
}

fun envStr(key: String, fallback: String = ""): String = env[key] ?: fallback
fun envInt(key: String, fallback: Int): Int = env[key]?.toIntOrNull() ?: fallback
fun envBool(key: String, fallback: Boolean): Boolean =
    env[key]?.lowercase()?.let { it == "true" || it == "1" || it == "yes" } ?: fallback

android {
    namespace = "com.adabala.sandeshika"
    compileSdk = envInt("APP_TARGET_SDK", 35)

    defaultConfig {
        applicationId = envStr("APP_ID", "com.adabala.sandeshika")
        minSdk = envInt("APP_MIN_SDK", 29)
        targetSdk = envInt("APP_TARGET_SDK", 35)
        versionCode = envInt("APP_VERSION_CODE", 1)
        versionName = envStr("APP_VERSION_NAME", "0.1.0")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // ── Every .env value that the app needs at runtime is surfaced here
        //    as a BuildConfig default. AppConfig then layers the DataStore
        //    override on top, so ports and tokens stay changeable after
        //    install without a rebuild.
        fun s(name: String, key: String, fb: String = "") =
            buildConfigField("String", name, "\"${envStr(key, fb)}\"")
        fun i(name: String, key: String, fb: Int) =
            buildConfigField("int", name, envInt(key, fb).toString())
        fun b(name: String, key: String, fb: Boolean) =
            buildConfigField("boolean", name, envBool(key, fb).toString())
        fun f(name: String, key: String, fb: Double) =
            buildConfigField("float", name, "${env[key]?.toFloatOrNull() ?: fb}f")

        s("MEDHA_HOST", "MEDHA_HOST", "127.0.0.1")
        i("MEDHA_PORT", "MEDHA_PORT", 8080)
        s("MEDHA_TOKEN", "MEDHA_TOKEN")
        s("MEDHA_CLIENT_ID", "MEDHA_CLIENT_ID", "sandeshika")
        s("MEDHA_NAMESPACE", "MEDHA_NAMESPACE", "sms")
        b("MEDHA_ENABLED", "MEDHA_ENABLED", true)
        i("MEDHA_HEALTH_POLL_SECONDS", "MEDHA_HEALTH_POLL_SECONDS", 60)
        i("MEDHA_CONNECT_TIMEOUT_SECONDS", "MEDHA_CONNECT_TIMEOUT_SECONDS", 5)
        i("MEDHA_READ_TIMEOUT_SECONDS", "MEDHA_READ_TIMEOUT_SECONDS", 180)
        i("MEDHA_BATCH_SIZE", "MEDHA_BATCH_SIZE", 12)
        i("MEDHA_MAX_RETRIES", "MEDHA_MAX_RETRIES", 4)
        i("MEDHA_RETRY_BASE_SECONDS", "MEDHA_RETRY_BASE_SECONDS", 8)

        i("INGEST_BACKFILL_PAGE_SIZE", "INGEST_BACKFILL_PAGE_SIZE", 300)
        i("INGEST_BACKFILL_MAX_MESSAGES", "INGEST_BACKFILL_MAX_MESSAGES", 0)
        i("INGEST_HISTORY_DAYS", "INGEST_HISTORY_DAYS", 0)
        i("INGEST_SWEEP_MINUTES", "INGEST_SWEEP_MINUTES", 15)
        i("INGEST_OBSERVER_DEBOUNCE_MS", "INGEST_OBSERVER_DEBOUNCE_MS", 1500)

        i("OTP_RETENTION_HOURS", "OTP_RETENTION_HOURS", 24)
        i("PROMO_RETENTION_DAYS", "PROMO_RETENTION_DAYS", 30)
        b("REQUIRE_BIOMETRIC", "REQUIRE_BIOMETRIC", true)
        i("BIOMETRIC_TIMEOUT_MINUTES", "BIOMETRIC_TIMEOUT_MINUTES", 5)
        b("DB_ENCRYPTION", "DB_ENCRYPTION", true)
        b("FLAG_SECURE", "FLAG_SECURE", true)

        f("TEMPLATE_MERGE_RATIO", "TEMPLATE_MERGE_RATIO", 0.62)
        i("TEMPLATE_PREFIX_TOKENS", "TEMPLATE_PREFIX_TOKENS", 3)
        i("LINK_MERGE_THRESHOLD", "LINK_MERGE_THRESHOLD", 60)
        i("LINK_ADJUDICATE_MIN", "LINK_ADJUDICATE_MIN", 30)
        i("AMOUNT_WINDOW_HOURS", "AMOUNT_WINDOW_HOURS", 48)
        f("REVIEW_CONFIDENCE_FLOOR", "REVIEW_CONFIDENCE_FLOOR", 0.55)

        s("DEFAULT_CURRENCY", "DEFAULT_CURRENCY", "INR")
        s("DEFAULT_LOCALE", "DEFAULT_LOCALE", "en-IN")
        s("DATE_ORDER", "DATE_ORDER", "DMY")
        s("DEFAULT_TIMEZONE", "DEFAULT_TIMEZONE", "Asia/Kolkata")
        s("LOG_LEVEL", "LOG_LEVEL", "INFO")
        b("DEBUG_KEEP_QUARANTINE", "DEBUG_KEEP_QUARANTINE", true)
    }

    // Release signing only when the secrets exist, mirroring Medha's CI shape.
    signingConfigs {
        create("release") {
            val ksPath = System.getenv("SANDESHIKA_KEYSTORE_PATH")
            if (ksPath != null && File(ksPath).exists()) {
                storeFile = File(ksPath)
                storePassword = System.getenv("SANDESHIKA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SANDESHIKA_KEY_ALIAS")
                keyPassword = System.getenv("SANDESHIKA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            // R8 is off for now: OkHttp, kotlinx.serialization and Room all
            // need keep rules, and they fail at RUNTIME, not build time.
            // Shipping unminified is the honest choice until rules are written.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("SANDESHIKA_KEYSTORE_PATH") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
    testOptions { unitTests { isReturnDefaultValues = true } }
}

// Room schema export — required for migration tests, which PRODUCTION-READINESS
// flags as the single highest-consequence untested path in Medha. Not repeating it.
ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.compose.adaptive.navigation)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.sqlcipher)
    implementation(libs.sqlite.ktx)

    implementation(libs.work.runtime.ktx)
    implementation(libs.datastore.preferences)
    implementation(libs.security.crypto)
    implementation(libs.biometric)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.room.testing)
}
