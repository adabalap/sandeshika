package com.adabala.sandeshika

import android.app.Application
import android.os.Build
import android.webkit.WebView

class SandeshikaApp : Application() {
    override fun onCreate() {
        super.onCreate()

        /*
         * Debug builds only. WebView contents debugging exposes the page to
         * anything that can reach the device over adb — including the running
         * app's own state — so it must never be on in a release the user
         * installs.
         */
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        /*
         * Multi-process WebView needs a distinct data directory per process,
         * or the second process to start throws on first use. Only one process
         * uses a WebView here, but naming it is cheap insurance against a
         * future service or a crash-reporting library that starts one.
         */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val process = getProcessName()
            if (process != packageName) WebView.setDataDirectorySuffix(process)
        }
    }
}
