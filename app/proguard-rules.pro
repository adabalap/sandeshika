# ---------------------------------------------------------------------------
# The JavaScript bridge
#
# Invoked reflectively by the WebView, never from Kotlin. R8 sees no callers,
# strips the methods, and the release build fails at runtime with
# "AndroidMedha.getConfig is not a function" while the debug build works
# perfectly — the worst shape a bug can take, because it only appears in the
# artifact users install.
# ---------------------------------------------------------------------------
-keepclassmembers class com.adabala.sandeshika.MedhaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.adabala.sandeshika.MedhaBridge { *; }

# Belt and braces: any @JavascriptInterface method, wherever it lives.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# org.json crosses the bridge boundary.
-dontwarn org.json.**

# ---------------------------------------------------------------------------
# Google Tink, pulled in by androidx.security:security-crypto
#
# EncryptedSharedPreferences is backed by Tink, and Tink's classes are annotated
# with Error Prone and JSR-305 annotations that exist only at COMPILE time. They
# are deliberately absent at runtime — nothing loads them, and no behaviour
# depends on them — but R8 walks every reference it can see and refuses to
# finish when a referenced class is missing:
#
#   Missing class com.google.errorprone.annotations.CanIgnoreReturnValue
#   Missing class javax.annotation.Nullable
#   ...
#
# Adding the annotation libraries as real dependencies would embed classes the
# app never uses. Telling R8 they are absent on purpose is the correct fix and
# the one Google documents.
# ---------------------------------------------------------------------------
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**

# Tink resolves key managers and primitives reflectively from the keyset, so the
# classes it instantiates have no static callers for R8 to find. Losing one of
# them means EncryptedSharedPreferences throws on first open — which, on this
# app, is the screen where the Medha token is saved.
-keep class com.google.crypto.tink.** { *; }
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}
-dontwarn com.google.crypto.tink.**

# ---------------------------------------------------------------------------
# Diagnostics
#
# Line numbers are kept and the source file name renamed to a placeholder: a
# stack trace from a user's device is worth having, and the file name alone
# gives nothing away that the line number does not.
# ---------------------------------------------------------------------------
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
