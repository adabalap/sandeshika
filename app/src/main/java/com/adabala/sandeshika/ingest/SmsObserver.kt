package com.adabala.sandeshika.ingest

import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Telephony

/**
 * Watches the SMS provider while the app process is alive.
 *
 * The provider fires several notifications for a single incoming message
 * (insert, then thread update, then read-state), so a naive observer enqueues
 * three jobs per message. Debouncing collapses the burst into one.
 *
 * Deliberately NOT a BroadcastReceiver on SMS_RECEIVED. Declaring RECEIVE_SMS
 * is the permission Play Protect treats most harshly on a sideloaded build --
 * Medha's own PLAY-PROTECT.md documents removing it for exactly this reason,
 * having found it bought nothing. ContentObserver plus the periodic sweep
 * covers the same ground for a companion app that does not need sub-second
 * latency.
 */
class SmsObserver(
    private val ctx: Context,
    private val debounceMs: Long
) : ContentObserver(Handler(Looper.getMainLooper())) {

    private var registered = false

    override fun onChange(selfChange: Boolean, uri: Uri?) {
        IngestWorker.enqueueNow(ctx, debounceMs)
    }

    fun register() {
        if (registered) return
        ctx.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, this)
        registered = true
    }

    fun unregister() {
        if (!registered) return
        ctx.contentResolver.unregisterContentObserver(this)
        registered = false
    }
}
