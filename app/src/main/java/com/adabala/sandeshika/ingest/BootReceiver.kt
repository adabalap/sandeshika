package com.adabala.sandeshika.ingest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.adabala.sandeshika.BuildConfig

/**
 * WorkManager already survives reboot, but the periodic sweep is re-registered
 * here so a fresh install that has never opened post-boot still catches up
 * rather than waiting for the user to launch the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!SmsReader(ctx).canRead()) return
        IngestWorker.schedulePeriodicSweep(ctx, BuildConfig.INGEST_SWEEP_MINUTES)
        IngestWorker.enqueueNow(ctx)
    }
}
