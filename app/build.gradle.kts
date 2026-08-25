plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * Kept in step with package.json, static/sw.js, static/js/main.js and app.py.
 *
 * tests/shell.test.js fails when those four disagree, and the app reports a
 * stale cache to the user when the page build differs from the server's. This
 * is the fifth place the number lives, so tools/bump_version.py writes it too.
 */
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

    /*
     * TWO FLAVOURS, mirroring Medha's own split.
     *
     * `core` ships without any SMS-adjacent capability so it installs cleanly
     * and can be handed to anyone. `full` is the build that actually reads an
     * inbox. Keeping them apart is what lets the core build stay free of a
     * restricted permission it does not need — the same reasoning that keeps
     * READ_SMS out of Medha's core flavour.
     *
     * Note that Sandeshika itself never holds READ_SMS: it asks MEDHA for
     * messages over loopback, and Medha is the app that holds the permission.
     * The flavour here only controls whether the SMS features are present.
     */
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
            /*
             * Read from the environment so no key material is ever committed.
             * When the variables are absent — a local build, or a fork's CI —
             * the release build falls back to the debug key below rather than
             * failing, because an unsigned artifact you cannot install is less
             * useful than a debug-signed one you can.
             */
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
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val hasKey = !System.getenv("SANDESHIKA_KEYSTORE").isNullOrBlank()
            signingConfig = if (hasKey) signingConfigs.getByName("release")
                            else signingConfigs.getByName("debug")
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
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/LICENSE*")
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

/*
 * THE PWA IS THE APP.
 *
 * static/ is the single source of truth for the interface, shared with the
 * browser build. It is copied into assets at build time rather than duplicated
 * into the repository, because two copies of an app's entire front end drift
 * apart within a week and the divergence is invisible until someone reports a
 * bug that only reproduces on the phone.
 *
 * The web assets live at the repository root (../static from this module), the
 * same place the Flask server reads them from.
 */
val webRoot = rootProject.file("static")

val syncWebAssets by tasks.registering(Sync::class) {
    description = "Copies the PWA into the APK's assets, mirroring the Flask URL space."
    group = "build"

    val out = layout.buildDirectory.dir("generated/webAssets")
    into(out)

    /*
     * THE ASSET LAYOUT MUST MATCH THE FLASK URL SPACE EXACTLY.
     *
     * index.html references absolute paths — /static/app.css, /static/js/main.js,
     * /sw.js, /manifest.webmanifest — because that is what app.py serves. One
     * index.html is shared by both builds, so the APK has to answer the same
     * URLs or none of them resolve.
     *
     * An earlier version mounted everything under /assets/web/ and loaded the
     * page from there. Every absolute path then pointed at a URL with no
     * handler behind it: no stylesheet, no modules, no service worker. The app
     * launched and rendered raw unstyled HTML with every view visible at once,
     * because even `.hidden` comes from the stylesheet. It looked like a
     * catastrophically broken app; it was one wrong prefix.
     *
     *   assets/index.html            <- served at /
     *   assets/sw.js                 <- /sw.js, needs root scope
     *   assets/manifest.webmanifest  <- /manifest.webmanifest
     *   assets/static/**             <- /static/**
     */
    from(webRoot) {
        into("static")
        exclude("**/.DS_Store", "**/*.map", "**/node_modules/**")
    }

    // The three files Flask serves from the root rather than from /static/.
    // sw.js in particular MUST be at the root: a worker cannot claim a scope
    // above its own path, so one served from /static/ could never control "/".
    from(webRoot) {
        include("index.html", "sw.js", "manifest.webmanifest")
    }

    doFirst {
        if (!webRoot.exists()) {
            throw GradleException(
                "static/ was not found at ${webRoot.absolutePath}.\n" +
                "The Android project must sit at the SAME repository root as the web app:\n" +
                "  settings.gradle.kts, app/, gradlew, static/, app.py\n" +
                "If you extracted a release archive into a subfolder, move its contents up."
            )
        }
        for (required in listOf("index.html", "app.css", "sw.js", "js/main.js")) {
            if (!File(webRoot, required).exists()) {
                throw GradleException("static/$required is missing — the APK would open a blank screen.")
            }
        }
    }
}

android.sourceSets.getByName("main") {
    assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
}

tasks.named("preBuild") { dependsOn(syncWebAssets) }

/*
 * A build-time guard, not a runtime surprise.
 *
 * The versionName here is a fifth copy of a number that already lives in four
 * other files. When it drifts, the running app tells the user their cache is
 * stale — a warning that is then wrong for everyone and quickly learned to be
 * ignored.
 */
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
                    "package.json says $declared.\nRun: python3 tools/bump_version.py $declared"
                )
            }
        }
    }
}

tasks.named("preBuild") { dependsOn(checkVersionAgreement) }
