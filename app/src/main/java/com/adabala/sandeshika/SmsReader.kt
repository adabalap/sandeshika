package com.adabala.sandeshika

import android.content.Context
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import com.adabala.sandeshika.classify.Category
import com.adabala.sandeshika.classify.Classification
import com.adabala.sandeshika.classify.LayeredClassifier
import com.adabala.sandeshika.classify.MessageRedactor
import com.adabala.sandeshika.classify.NaiveBayes
import com.adabala.sandeshika.classify.RuleClassifier
import com.adabala.sandeshika.classify.Sms

/** An inbox message together with what the classifier made of it. */
data class ClassifiedSms(
    val sms: Sms,
    val classification: Classification,
    /** Stable key for this message shape; what a correction is stored against. */
    val shapeKey: String = "",
    /** Contact name when the sender is someone in the address book. */
    val contactName: String? = null
) {
    /** What to show as the sender: a name if we have one, else the raw address. */
    val displaySender: String get() = contactName ?: sms.sender
}

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
     * Reads the whole inbox, newest first.
     *
     * [limit] now defaults to no cap. The earlier 500 was a guess at what a
     * person looks at, and it was the wrong call: an organiser that silently
     * ignores everything older than a few weeks cannot answer "how much did I
     * spend last month", which is the entire point. Classification is regex
     * over a string -- microseconds per message -- so tens of thousands is
     * comfortably fast; the cost is the cursor read, and that already runs
     * off the main thread.
     *
     * [onProgress] fires as rows are consumed so the UI can show real
     * movement instead of an indefinite spinner on a large inbox.
     */
    private val contacts = mutableMapOf<String, String?>()

    /**
     * Every name resolved from the address book during the last scan.
     *
     * Handed to the redactor so those names can be stripped from *every*
     * message body, not just the ones they sent. A bank message naming a
     * payee, a delivery SMS naming a recipient -- pattern matching cannot
     * reliably spot those, but an exact list of the people this person knows
     * can.
     */
    val knownContactNames: Set<String>
        get() = contacts.values.filterNotNull().toSet()

    fun read(
        context: Context,
        limit: Int = NO_LIMIT,
        corrections: CorrectionStore? = null,
        onProgress: (Int) -> Unit = {}
    ): List<ClassifiedSms> {
        val overrides = corrections?.all().orEmpty()
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE
        )
        val out = mutableListOf<ClassifiedSms>()
        val raw = mutableListOf<Sms>()
        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            null,
            null,
            // LIMIT inside the sort-order argument is the long-standing way to
            // bound a provider query; the provider passes it straight to
            // SQLite. There is no dedicated limit parameter before API 30.
            if (limit == NO_LIMIT) "${Telephony.Sms.DATE} DESC"
            else "${Telephony.Sms.DATE} DESC LIMIT $limit"
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
                raw.add(sms)
                // Only look up contacts for messages actually from a person.
                // A lookup per message would be thousands of provider round
                // trips, almost all of them for bank shortcodes that can
                // never match anything.
                if (raw.size % 500 == 0) onProgress(raw.size)
            }
        }

        // The model is trained here rather than persisted. It is derived data
        // -- fully reproducible from the corrections plus the rule-labelled
        // messages -- and a stored copy can only go stale relative to the
        // corrections that define it. Training measured at under two seconds
        // for ~9,000 examples, on a scan that is already asynchronous and
        // already takes longer than that to read the inbox.
        val ruleLabelled = raw.mapNotNull { sms ->
            val c = RuleClassifier.classify(sms)
            if (c.category == Category.OTHER) null else sms.body to c.category
        }
        val userLabelled = corrections?.trainingExamples().orEmpty()
        val model = if (ruleLabelled.size >= MIN_TRAINING_EXAMPLES) {
            runCatching { NaiveBayes.train(ruleLabelled + userLabelled) }.getOrNull()
        } else {
            null
        }
        val layered = LayeredClassifier(model)

        raw.forEach { sms ->
            val key = MessageRedactor.shapeKey(sms.sender, sms.body)
            // A correction the user made explicitly outranks everything.
            // Anything less would mean telling someone "this is a bill" and
            // watching the app disagree on the next scan.
            val override = overrides[key]
            val classification = if (override != null) {
                Classification(override, confident = true, why = "you corrected this")
            } else {
                layered.classify(sms)
            }
            val name = if (classification.category == Category.PERSONAL) {
                contacts.getOrPut(sms.sender) { lookupContact(context, sms.sender) }
            } else {
                null
            }
            out.add(ClassifiedSms(sms, classification, key, name))
        }
        onProgress(out.size)
        return out
    }

    /**
     * Below this, the model is not built at all.
     *
     * A model trained on a handful of messages produces confident-looking
     * output from coincidence, and the abstention margin cannot help: it
     * compares classes against each other, so it cannot detect that every
     * class is equally uninformed.
     */
    private const val MIN_TRAINING_EXAMPLES = 50

    const val NO_LIMIT = -1

    /**
     * Resolves a phone number to an address-book name.
     *
     * Uses PhoneLookup rather than matching the raw string: the provider
     * normalises number formats, so a contact saved as 98765 43210 still
     * matches an SMS from +919876543210. Doing this by string comparison
     * would miss almost every contact.
     *
     * Returns null when READ_CONTACTS was not granted, rather than throwing.
     * Contact names are a nicety; the inbox has to work without them.
     */
    private fun lookupContact(context: Context, number: String): String? = runCatching {
        if (number.isBlank()) return null
        val uri = Uri.withAppendedPath(
            ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number)
        )
        context.contentResolver.query(
            uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null
        )?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }.getOrNull()
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
    BALANCE("Balance", setOf(Category.BALANCE)),
    OTP("Codes", setOf(Category.OTP)),
    UPDATES("Updates", setOf(Category.DELIVERY, Category.TRAVEL)),
    SERVICE("Info", setOf(Category.SERVICE)),
    INSTITUTION("School", setOf(Category.INSTITUTION)),
    PROMOTIONS("Offers", setOf(Category.PROMOTION)),
    SPAM("Spam", setOf(Category.SPAM)),
    PERSONAL("Personal", setOf(Category.PERSONAL)),
    // Deliberately visible rather than hidden. The uncategorised pile is the
    // honest measure of how well the rules are doing, and it is what a later
    // learned layer will be pointed at.
    OTHER("Other", setOf(Category.OTHER))
}
