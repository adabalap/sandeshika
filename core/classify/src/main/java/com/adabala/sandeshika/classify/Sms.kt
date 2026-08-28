package com.adabala.sandeshika.classify

/**
 * A single SMS, reduced to what classification actually needs.
 *
 * Deliberately not an Android `Telephony.Sms` row or a Room entity. Keeping a
 * plain data class at the boundary means the whole classification layer can be
 * exercised on a JVM with no device, and it means the storage schema can
 * change without touching the logic that decides what a message *is*.
 */
data class Sms(
    /** The sender as Android reports it: `VM-HDFCBK`, `+919876543210`, `AX-SBIINB`. */
    val sender: String,
    val body: String,
    /** Epoch millis. */
    val receivedAt: Long = 0L
)

/**
 * Inbox categories.
 *
 * Chosen to match how people actually triage an Indian inbox, not to mirror
 * any bank's taxonomy. The test is whether a tab is worth opening: OTP is
 * separate because it is urgent and disposable, bills because they carry a
 * deadline, promotions because the whole point is never reading them.
 */
enum class Category {
    /** Money moved. Debit, credit, UPI, card, ATM. */
    TRANSACTION,

    /**
     * Bank telling you where you stand, without money having moved: balance
     * alerts, minimum-balance warnings, statement-ready notices.
     *
     * Separate from TRANSACTION because folding them together corrupts any
     * spending total -- a "your balance is Rs 1,258" message contains a rupee
     * figure that is emphatically not a spend. Separate from BILL because
     * there is nothing to pay.
     */
    BALANCE,

    /** An obligation with a date: bill due, recharge expiring, EMI upcoming. */
    BILL,

    /** One-time passwords and verification codes. Urgent, then worthless. */
    OTP,

    /** Marketing. Offers, sales, "click here". */
    PROMOTION,

    /** Orders, shipping, courier updates. */
    DELIVERY,

    /** PNR, flight, train, bus, cab. */
    TRAVEL,

    /** From a human, not a business. */
    PERSONAL,

    /**
     * Fraud and junk masquerading as something legitimate: work-from-home
     * "salary" messages, lottery wins, loan-approval bait.
     *
     * Deliberately not folded into PROMOTION. A real offer from a shop you
     * use and a scam impersonating your employer deserve different treatment,
     * and burying the second in a tab people ignore by design is exactly how
     * someone gets caught by it.
     */
    SPAM,

    /** Genuinely unclassifiable, or the classifier abstained. */
    OTHER
}

/**
 * A classification with its reasoning attached.
 *
 * [why] is not decoration. A category the user disagrees with is worth very
 * little if neither of us can see what drove it — and it is the difference
 * between a correction that teaches the system something and a correction that
 * just papers over an unexplained mistake.
 *
 * [confident] carries the lesson from the previous build's tuning sweep: a
 * classifier that guesses at every message reaches higher coverage and lower
 * trust. A confident wrong label costs credibility across every other label,
 * so abstaining into [Category.OTHER] is the better failure.
 */
data class Classification(
    val category: Category,
    val confident: Boolean,
    val why: String
)
