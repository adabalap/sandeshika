package com.adabala.sandeshika

import android.content.Context
import android.provider.Telephony
import com.adabala.sandeshika.classify.Category
import com.adabala.sandeshika.classify.Classification
import com.adabala.sandeshika.classify.RuleClassifier
import com.adabala.sandeshika.classify.Sms

/** An inbox message together with what the classifier made of it. */
data class ClassifiedSms(
    val sms: Sms,
    val classification: Classification
)

/**
 * Reads the device inbox and classifies it.
 *
 * The system SMS provider is already durable, indexed storage for the
 * messages themselves, so this slice deliberately adds no database of its
 * own. A Room layer earns its place once there is something the provider
 * cannot hold — user corrections, cached model answers — and not before;
 * mirroring the inbox into a second copy just creates two things that can
 * disagree.
 */
object SmsReader {

    /**
     * Newest first, capped at [limit].
     *
     * The cap is not laziness. Real Indian inboxes run to tens of thousands
     * of messages, and reading all of them synchronously on the main thread
     * would stall the app for seconds before it drew anything. A few hundred
     * recent messages is what a person actually looks at; paging further back
     * belongs with the persistence layer, not here.
     */
    fun read(context: Context, limit: Int = 500): List<ClassifiedSms> {
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE
        )
        val out = mutableListOf<ClassifiedSms>()
        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            null,
            null,
            // LIMIT inside the sort-order argument is the long-standing way to
            // bound a provider query; the provider passes this straight to
            // SQLite. There is no dedicated limit parameter before API 30.
            "${Telephony.Sms.DATE} DESC LIMIT $limit"
        )?.use { cursor ->
            val iAddr = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val iBody = cursor.getColumnIndex(Telephony.Sms.BODY)
            val iDate = cursor.getColumnIndex(Telephony.Sms.DATE)
            while (cursor.moveToNext()) {
                val sms = Sms(
                    sender = if (iAddr >= 0) cursor.getString(iAddr).orEmpty() else "",
                    body = if (iBody >= 0) cursor.getString(iBody).orEmpty() else "",
                    receivedAt = if (iDate >= 0) cursor.getLong(iDate) else 0L
                )
                if (sms.body.isBlank()) continue
                out.add(ClassifiedSms(sms, RuleClassifier.classify(sms)))
            }
        }
        return out
    }
}

/**
 * The tabs, in the order they appear.
 *
 * Ordered by how often a person needs them, not alphabetically or by the
 * enum's declaration order. Transactions and bills are why someone opens this
 * app; promotions exist so they can be ignored in bulk.
 */
enum class Tab(val label: String, val categories: Set<Category>) {
    ALL("All", Category.values().toSet()),
    TRANSACTIONS("Money", setOf(Category.TRANSACTION)),
    BILLS("Bills", setOf(Category.BILL)),
    OTP("Codes", setOf(Category.OTP)),
    UPDATES("Updates", setOf(Category.DELIVERY, Category.TRAVEL)),
    PROMOTIONS("Offers", setOf(Category.PROMOTION)),
    PERSONAL("Personal", setOf(Category.PERSONAL)),
    // Deliberately visible rather than hidden. The uncategorised pile is the
    // honest measure of how well the rules are doing, and it is what a later
    // learned layer will be pointed at.
    OTHER("Other", setOf(Category.OTHER))
}
