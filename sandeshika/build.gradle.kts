plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.3.0" apply false
    id("org.jetbrains.kotlin.jvm") version "2.3.0" apply false
    // Required from Kotlin 2.0 onward: the Compose compiler moved out of the
    // Kotlin plugin into its own. Omitting it fails with a confusing message
    // about composable functions not being allowed.
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.0" apply false
}
