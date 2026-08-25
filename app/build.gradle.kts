plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// NOTE ON COMMENT STYLE IN THIS FILE
//
// Line comments only, deliberately. Kotlin block comments NEST, so a glob
// pattern written inside one - the kind this file is full of - opens a nested
// comment that never closes, and the outer comment then swallows real code
// until it meets a stray close sequence inside a string literal. That produced
// a parse error tens of lines below the actual mistake and cost a full build
// cycle to find. tools/check_kotlin_comments.py now fails on it.

// Kept in step with package.json, static/sw.js, static/js/main.js and app.py.
// tests/shell.test.js fails when those disagree, and the app warns the user
// about a stale cache when the page build differs from the server's.
val appVersionName = "2.1.0"
val appVersionCode = 20100

android {
    namespace = "com.adabala.sandeshika"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.adabala.sandeshika"
        minSdk = 26
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersionName
        resValue("string", "app_version", appVersionName)
    }

    // TWO FLAVOURS, mirroring Medha's own split.
    //
    // "core" ships without SMS-adjacent capability so it installs cleanly and
    // can be handed to anyone. "full" is the build that reads an inbox.
    //
    // Sandeshika itself never holds READ_SMS in either flavour: it asks Medha
    // for messages over loopback, and Medha is the app that holds the
    // permission. The flavour only controls whether the SMS features exist.
    flavorDimensions += "capability"
    productFlavors {
        create("core") {
            dimension = "capability"
            applicationIdSuffix = ".core"
            versionNameSuffix = "-core"
            resValue("string", "app_name", "Sandeshika Core")
            buildConfigField("boolean", "SMS_ENABLED", "false")
        }
        create("full") {
            dimension = "capability"
            resValue("string", "app_name", "Sandeshika")
            buildConfigField("boolean", "SMS_ENABLED", "true")
        }
    }

    signingConfigs {
        create("release") {
            // Read from the environment so no key material is ever committed.
            // When the variables are absent - a local build, or a fork's CI -
            // the release build falls back to the debug key rather than
            // failing: an unsigned artifact you cannot install is less useful
            // than a debug-signed one you can.
            val storePath = System.getenv("SANDESHIKA_KEYSTORE")
            if (!storePath.isNullOrBlank() && file(storePath).exists()) {
                storeFile = file(storePath)
                storePassword = System.getenv("SANDESHIKA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SANDESHIKA_KEY_ALIAS")
                keyPassword = System.getenv("SANDESHIKA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val hasKey = !System.getenv("SANDESHIKA_KEYSTORE").isNullOrBlank()
            signingConfig = if (hasKey) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }

    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE.md")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
}

// THE PWA IS THE APP.
//
// static/ is the single source of truth for the interface, shared with the
// browser build. It is copied into assets at build time rather than duplicated
// into this project: two copies of an entire front end drift apart within a
// week, and the divergence only shows up as a bug that reproduces on the phone
// and nowhere else.
val webRoot = rootProject.file("static")

// THE ASSET LAYOUT MUST MATCH THE FLASK URL SPACE EXACTLY.
//
// index.html references absolute paths because that is what app.py serves, and
// one index.html is shared by both builds, so the APK has to answer the same
// URLs or none of them resolve.
//
// An earlier version mounted everything one directory deeper and loaded the
// page from there. Every absolute path then pointed at a URL with no handler
// behind it: no stylesheet, no modules, no service worker. The app launched and
// rendered raw unstyled HTML with every view visible at once, because even the
// hidden class comes from the stylesheet. It looked like a catastrophically
// broken app; it was one wrong prefix.
//
// Produced layout, relative to the APK's assets directory:
//
//     index.html            served at the root
//     sw.js                 must be at the root to claim root scope
//     manifest.webmanifest  served at the root
//     static/               everything else, under the static prefix
val syncWebAssets by tasks.registering(Sync::class) {
    description = "Copies the PWA into the APK's assets, mirroring the Flask URL space."
    group = "build"

    into(layout.buildDirectory.dir("generated/webAssets"))

    from(webRoot) {
        into("static")
        exclude("**/.DS_Store")
        exclude("**/*.map")
        exclude("**/node_modules/**")
    }

    // The three files Flask serves from the root rather than under static.
    // sw.js in particular MUST be at the root: a service worker cannot claim a
    // scope above its own path, so one served from a subdirectory could never
    // control the whole app.
    from(webRoot) {
        include("index.html", "sw.js", "manifest.webmanifest")
    }

    doFirst {
        if (!webRoot.exists()) {
            throw GradleException(
                "static/ was not found at ${webRoot.absolutePath}.\n" +
                    "The Android project must sit at the SAME repository root as the web app:\n" +
                    "  settings.gradle.kts, app/, gradlew, static/, app.py\n" +
                    "If a release archive was extracted into a subfolder, move its contents up.",
            )
        }
        val required = listOf("index.html", "app.css", "sw.js", "js/main.js")
        for (name in required) {
            if (!File(webRoot, name).exists()) {
                throw GradleException(
                    "static/$name is missing - the APK would open a blank screen.",
                )
            }
        }
    }
}

android.sourceSets.getByName("main") {
    assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

// A build-time guard, not a runtime surprise.
//
// versionName here is a fifth copy of a number that already lives in four other
// files. When it drifts, the running app tells the user their cache is stale -
// a warning that is then wrong for everyone and quickly learned to be ignored.
val checkVersionAgreement by tasks.registering {
    description = "Fails if the APK version disagrees with package.json."
    group = "verification"
    doLast {
        val pkg = rootProject.file("package.json")
        if (pkg.exists()) {
            val declared = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
                .find(pkg.readText())?.groupValues?.get(1)
            if (declared != null && declared != appVersionName) {
                throw GradleException(
                    "Version mismatch: app/build.gradle.kts says $appVersionName, " +
                        "package.json says $declared.\n" +
                        "Run: python3 tools/bump_version.py $declared",
                )
            }
        }
    }
}

tasks.named("preBuild") {
    dependsOn(syncWebAssets, checkVersionAgreement)
}
