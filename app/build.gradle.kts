plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // Required from Kotlin 2.0 onward. Without it the build fails with a
    // message about @Composable not being allowed here, which reads like a
    // code error rather than a missing plugin.
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.adabala.sandeshika"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.adabala.sandeshika"
        minSdk = 27
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
        // Required for BuildConfig.VERSION_NAME, used on the About screen.
        // Not on by default since AGP 8, and its absence fails only at the
        // reference site with an unresolved-symbol error that reads like a
        // missing import.
        buildConfig = true
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            // Left off until there are keep rules written and tested against
            // a real build. Medha learned this the hard way: reflective code
            // silently degrades under R8 rather than failing loudly.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    }
}

// Top level, not inside android { } -- `kotlin` is a project extension and
// nesting it in the Android DSL does not resolve.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core:classify"))

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")

    // The BOM pins mutually-compatible Compose library versions. The Compose
    // *compiler* version is handled by the plugin above and tracks Kotlin, so
    // the two are independent and both need to be right.
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.compose.ui:ui-tooling-preview")
}
