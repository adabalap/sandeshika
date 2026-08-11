package com.adabala.sandeshika

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Hosts the Sandeshika UI in a WebView.
 *
 * The whole app is local: assets are served through [WebViewAssetLoader] under
 * `https://appassets.androidplatform.net/`, so there is no server to run, no
 * port to forward and nothing to keep alive. Network access is used only to
 * reach Medha on loopback, and only via [MedhaBridge].
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true      // localStorage for the sync cursor
            settings.databaseEnabled = false
            settings.allowFileAccess = false       // assets come via the loader
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
            settings.textZoom = 100                // respect layout, not system font scaling
            // Assets are served over the loader's https origin, so no mixed
            // content is ever needed; Medha is reached natively instead.
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView, request: WebResourceRequest
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(
                    view: WebView, request: WebResourceRequest
                ): Boolean {
                    // Keep the app in-app; nothing here should navigate away.
                    return !request.url.toString().startsWith(BASE)
                }
            }
        }

        addJavascriptInterface()
        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; finish() }
            }
        })

        web.loadUrl("$BASE/assets/web/index.html")
    }

    private fun addJavascriptInterface() {
        // Safe on every supported API level: minSdk is 27, well past the
        // addJavascriptInterface reflection vulnerability that affected API < 17,
        // and the loaded content is entirely first-party from assets.
        web.addJavascriptInterface(MedhaBridge(this, web), "AndroidMedha")
    }

    override fun onDestroy() {
        web.removeJavascriptInterface("AndroidMedha")
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val BASE = "https://appassets.androidplatform.net"
    }
}
