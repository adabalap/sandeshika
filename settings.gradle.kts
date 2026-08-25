/*
 * Sandeshika — Android wrapper.
 *
 * This project exists for one reason: to host the PWA in a WebView and give it
 * a direct, in-process route to Medha, so the app works on the phone with no
 * laptop and no Flask server running anywhere.
 *
 * In the browser, static/js/data/transport.js reaches Medha through the Flask
 * reverse proxy. Inside this APK there is no Flask server at all, so the same
 * module detects `window.AndroidMedha` and calls the bridge in MedhaBridge.kt
 * instead. The two paths are interchangeable by design and both are covered by
 * tests/transport.test.js.
 */
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Sandeshika"
include(":app")
