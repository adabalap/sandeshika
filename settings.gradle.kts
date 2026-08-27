pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "sandeshika"

// :app is deliberately absent until it has a build file. Gradle configures
// every included module before running any task, so an included-but-empty
// module fails the whole build -- including the core tests, which have
// nothing to do with it. It gets added in the same commit that gives it a
// build.gradle.kts.
// Pure-Kotlin, zero-Android module. Split out so the parsing and
// classification logic -- the part where correctness actually matters and
// where bugs are silent -- can be compiled and unit-tested on a plain JVM,
// with no emulator and no Android SDK in the loop.
include(":core:classify")
