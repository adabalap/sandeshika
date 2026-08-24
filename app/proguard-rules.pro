# The JavaScript bridge is invoked reflectively by the WebView, never from
# Kotlin. R8 sees no callers, strips the methods, and the release build fails
# at runtime with "AndroidMedha.getConfig is not a function" while the debug
# build works perfectly — the worst shape a bug can take.
-keepclassmembers class com.adabala.sandeshika.MedhaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.adabala.sandeshika.MedhaBridge { *; }

# org.json is used across the bridge boundary.
-dontwarn org.json.**
