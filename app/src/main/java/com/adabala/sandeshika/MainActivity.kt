package com.adabala.sandeshika

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature

/**
 * Hosts the PWA.
 *
 * The interface is the same `static/` directory the Flask build serves — copied
 * into assets at build time rather than duplicated into this project, because
 * two copies of an app's whole front end drift apart within a week and the
 * divergence only shows up as a bug that reproduces on the phone and nowhere
 * else.
 *
 * WHY THE ASSET LOADER RATHER THAN file:///android_asset
 *
 * A `file://` page is an opaque origin: no service worker, no secure context,
 * no localStorage worth relying on, and `allowFileAccessFromFileURLs` — the
 * usual workaround — hands any script on the page the ability to read the
 * device's filesystem. WebViewAssetLoader serves the same files over
 * `https://appassets.androidplatform.net/`, which is a proper secure origin.
 * The service worker registers, the offline shell works, and the file system
 * stays unreachable.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    // NOT named `settings`: inside `WebView(...).apply { }` that would resolve
    // to WebView.getSettings(), and the two would be one rename apart from
    // silently swapping places.
    private lateinit var settingsStore: SettingsStore

    private val startUrl = "https://appassets.androidplatform.net/assets/web/index.html"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        settingsStore = SettingsStore(this)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )

            settings.apply {   // WebSettings
                javaScriptEnabled = true

                // The app stores scan cursors in localStorage. Everything
                // durable lives in Medha's store, not here.
                domStorageEnabled = true

                // Nothing in this app reads a file, a content provider, or a
                // remote origin. Each of these is a way for page script to
                // reach something it has no business reaching.
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setGeolocationEnabled(false)
                setSupportMultipleWindows(false)

                // The layout is already responsive and sized for a phone;
                // letting the WebView second-guess it produces a zoomed-out
                // desktop rendering on first paint.
                useWideViewPort = false
                loadWithOverviewMode = false
                builtInZoomControls = false

                // Text should follow the app's own type scale, not the system
                // font scale applied twice — the CSS already respects rem.
                textZoom = 100
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                /**
                 * Nothing navigates away from the app shell.
                 *
                 * An SMS body can contain a link, and those bodies are rendered
                 * in the inbox view. A stray navigation would replace the whole
                 * app with an attacker's page inside a WebView that has a
                 * JavaScript bridge attached to it.
                 */
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean = request.url.host != "appassets.androidplatform.net"
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    // Surfaced in logcat so a page-side error during a real
                    // import is diagnosable without attaching a debugger.
                    android.util.Log.d("Sandeshika", "${msg.message()} @${msg.lineNumber()}")
                    return true
                }
            }
        }

        /*
         * The service worker fetches through its own path, not the page's, so
         * it needs the asset loader wired up separately. Without this the
         * offline shell silently fails to cache anything and the app only works
         * while the WebView happens to have the files in memory.
         */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                object : ServiceWorkerClientCompat() {
                    override fun shouldInterceptRequest(
                        request: WebResourceRequest,
                    ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
                }
            )
        }

        webView.addJavascriptInterface(
            MedhaBridge(webView, settingsStore, lifecycleScope),
            MedhaBridge.NAME,
        )

        setContentView(webView)

        // The app is a stack of views inside one page; back should move within
        // it and only leave at the top, which is what a user expects from
        // anything that looks like this.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (savedInstanceState == null) webView.loadUrl(startUrl)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }

    override fun onDestroy() {
        // Detached before destruction: destroying an attached WebView leaks the
        // activity, and this one holds a bridge with a coroutine scope.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }
}
