package com.adabala.sandeshika.ingest

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat
import com.adabala.sandeshika.data.db.PipelineStatus
import com.adabala.sandeshika.data.db.SmsRaw
import com.adabala.sandeshika.pipeline.Sanitizer

/**
 * Reads the system SMS provider.
 *
 * ## Paging is by timestamp, never by offset
 *
 * A backfill over 40,000 messages takes many pages. If pages are addressed by
 * OFFSET, a single message arriving mid-scan shifts every subsequent offset by
 * one — silently duplicating one message and skipping another, with no error
 * anywhere. Medha's own connector documents having learned this. Cursoring on
 * DATE is stable under concurrent inserts.
 */
class SmsReader(private val ctx: Context) {

    private val projection = arrayOf(
        Telephony.Sms._ID,
        Telephony.Sms.THREAD_ID,
        Telephony.Sms.ADDRESS,
        Telephony.Sms.BODY,
        Telephony.Sms.DATE,
        Telephony.Sms.TYPE,
        Telephony.Sms.SUBSCRIPTION_ID
    )

    fun canRead(): Boolean = ContextCompat.checkSelfPermission(
        ctx, Manifest.permission.READ_SMS
    ) == PackageManager.PERMISSION_GRANTED

    fun totalMessages(): Int = runCatching {
        ctx.contentResolver.query(
            Telephony.Sms.CONTENT_URI, arrayOf(Telephony.Sms._ID), null, null, null
        )?.use { it.count } ?: 0
    }.getOrDefault(0)

    /**
     * One page, newest first, strictly older than [before] and newer than
     * [after]. Both bounds are exclusive so a cursor can be handed straight
     * back in without an off-by-one re-read.
     */
    fun page(before: Long? = null, after: Long? = null, limit: Int = 300): List<SmsRaw> {
        if (!canRead()) return emptyList()

        val where = StringBuilder("1=1")
        val args = mutableListOf<String>()
        before?.let { where.append(" AND ${Telephony.Sms.DATE} < ?"); args.add(it.toString()) }
        after?.let { where.append(" AND ${Telephony.Sms.DATE} > ?"); args.add(it.toString()) }

        val now = System.currentTimeMillis()
        val out = ArrayList<SmsRaw>(limit)

        runCatching {
            ctx.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                projection,
                where.toString(),
                args.toTypedArray(),
                "${Telephony.Sms.DATE} DESC LIMIT ${limit.coerceIn(1, 1000)}"
            )?.use { c ->
                while (c.moveToNext()) {
                    val body = c.getString(3) ?: continue
                    val address = c.getString(2).orEmpty()
                    val date = c.getLong(4)
                    out.add(toRow(
                        systemId = c.getLong(0),
                        threadId = c.getLong(1),
                        address = address,
                        body = body,
                        date = date,
                        type = c.getInt(5),
                        sim = runCatching { c.getInt(6) }.getOrNull(),
                        now = now
                    ))
                }
            }
        }
        return out
    }

    /**
     * Sanitises one message into a storable row. Pure apart from the clock, so
     * it is directly unit-testable against the golden corpus.
     */
    fun toRow(
        systemId: Long?, threadId: Long?, address: String, body: String,
        date: Long, type: Int, sim: Int?, now: Long = System.currentTimeMillis(),
        otpRetentionHours: Int = 24
    ): SmsRaw {
        val sender = Sanitizer.sender(address)
        val normalised = Sanitizer.normalise(body)
        val otp = Sanitizer.otp(body)

        // Only AUTH codes are sensitive. A delivery OTP belongs to an order and
        // stays useful right up to the doorstep, so it is deliberately exempt.
        val sensitive = otp?.kind == Sanitizer.Otp.Kind.AUTH

        return SmsRaw(
            systemId = systemId,
            threadIdOs = threadId,
            senderRaw = address,
            senderNorm = sender.norm,
            senderCategory = sender.category,
            senderKind = sender.kind.name,
            number = if (sender.kind == Sanitizer.SenderKind.PERSON) address else null,
            body = body,
            bodyNormalised = normalised,
            receivedAt = date,
            ingestedAt = now,
            contentHash = Sanitizer.contentHash(address, date, body),
            templateFp = null,               // assigned by the miner in the worker
            language = detectScript(body),
            simSlot = sim,
            isSensitive = sensitive,
            purgeAfter = if (sensitive) date + otpRetentionHours * 3_600_000L else null,
            pipelineStatus = PipelineStatus.SANITIZED
        )
    }

    /**
     * Coarse script tag, not language ID. Enough to route Telugu/Devanagari
     * messages away from English-only extractors; a real classifier is
     * unnecessary at this stage and would be a dependency for no gain.
     */
    private fun detectScript(s: String): String {
        var telugu = 0; var deva = 0; var latin = 0
        for (ch in s) {
            when (ch.code) {
                in 0x0C00..0x0C7F -> telugu++
                in 0x0900..0x097F -> deva++
                in 0x0041..0x007A -> latin++
            }
        }
        return when {
            telugu > 3 -> "te"
            deva > 3 -> "hi"
            latin > 0 -> "en"
            else -> "und"
        }
    }

    companion object {
        const val INBOX = Telephony.Sms.MESSAGE_TYPE_INBOX
    }
}
