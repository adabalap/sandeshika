plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Deliberately a plain JVM module, not an Android library. Nothing here may
// import android.*; that constraint is what keeps this module testable on a
// bare JVM with no emulator, and it is easy to lose by accident. Treat any
// Android import appearing here as a design error rather than a convenience.
kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
