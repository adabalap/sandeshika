plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePath: String? = System.getenv("SANDESHIKA_KEYSTORE_PATH")
val hasReleaseSigning = !keystorePath.isNullOrBlank() && file(keystorePath).exists()

android {
    namespace = "com.adabala.sandeshika"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.adabala.sandeshika"
        minSdk = 27
        targetSdk = 34
        versionCode = 4
        versionName = "1.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("SANDESHIKA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SANDESHIKA_KEY_ALIAS")
                keyPassword = System.getenv("SANDESHIKA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isDebuggable = false
            // Off deliberately: the JavascriptInterface methods are reached by
            // name from JS, and R8 would rename or strip them. Runtime-only
            // failure, invisible at build time.
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    androidResources { noCompress += listOf("js", "css", "html") }
    lint { abortOnError = false }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    // WebViewAssetLoader: serves assets over a real https origin so the page is
    // a secure context, without shipping a server.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
