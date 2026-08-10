package com.adabala.sandeshika

import android.app.Application
import com.adabala.sandeshika.config.AppConfig
import com.adabala.sandeshika.ingest.IngestWorker
import com.adabala.sandeshika.ingest.SmsObserver
import com.adabala.sandeshika.ingest.SmsReader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class SandeshikaApp : Application() {

    lateinit var observer: SmsObserver
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        scope.launch {
            val cfg = AppConfig.get(this@SandeshikaApp).snapshot()
            observer = SmsObserver(this@SandeshikaApp, cfg.observerDebounceMs)
            if (SmsReader(this@SandeshikaApp).canRead()) {
                observer.register()
                IngestWorker.schedulePeriodicSweep(
                    this@SandeshikaApp, BuildConfig.INGEST_SWEEP_MINUTES
                )
            }
        }
    }
}
