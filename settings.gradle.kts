pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "sandeshika"

include(":app")
// Pure-Kotlin, zero-Android module. Split out so the parsing and
// classification logic -- the part where correctness actually matters and
// where bugs are silent -- can be compiled and unit-tested on a plain JVM,
// with no emulator and no Android SDK in the loop.
include(":core:classify")
