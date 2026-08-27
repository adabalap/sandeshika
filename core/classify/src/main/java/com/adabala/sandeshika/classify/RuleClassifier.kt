package com.adabala.sandeshika.classify

/**
 * Deterministic inbox classifier for Indian SMS.
 *
 * ## Why rules before any model
 *
 * A model here would be learning things that are already knowable with
 * certainty. "Does this message contain a six-digit code and the words 'do not
 * share'?" is not a judgement call. Starting deterministic means every
 * decision is explainable, testable against a corpus, and correctable by
 * editing one rule rather than retraining. A learned layer belongs *after*
 * this, handling only what the rules abstain on — which is where the previous
 * build's Naive Bayes earned its keep.
 *
 * ## Order is the design
 *
 * Rules are evaluated most-specific first, and the ordering encodes real
 * conflicts rather than being arbitrary:
 *
 *  - **OTP before transaction.** "OTP for txn of Rs 5000 at AMAZON" contains
 *    every transaction signal there is, but no money has moved yet. Filing it
 *    under transactions would double-count the spend when the real debit
 *    message arrives minutes later.
 *  - **Transaction before bill.** "Rs 500 debited towards your electricity
 *    bill" is money that has already left. A bill tab is for what you still
 *    owe; putting settled payments there makes it useless as a to-do list.
 *  - **Promotion last among commercial rules.** Marketing copy imitates
 *    everything else on purpose ("your reward is due!"), so it only wins when
 *    nothing more concrete matched.
 *  - **Personal is a structural test, not a keyword one**, and runs first for
 *    that reason. See [isPersonalSender].
 */
object RuleClassifier {

    fun classify(sms: Sms): Classification {
        val body = sms.body
        val lower = body.lowercase()

        // Structural, and far more reliable than any keyword: Indian
        // commercial senders are TRAI-registered alphanumeric headers, never
        // dialable numbers. A message from an actual phone number is from a
        // person, whatever it happens to say -- including a friend forwarding
        // an offer, which keyword rules would happily misfile as promotion.
        if (isPersonalSender(sms.sender)) {
            return Classification(Category.PERSONAL, true, "sender is a phone number")
        }

        matchOtp(lower, body)?.let { return it }
        matchTransaction(lower, body)?.let { return it }
        matchBill(lower)?.let { return it }
        matchTravel(lower, body)?.let { return it }
        matchDelivery(lower)?.let { return it }
        matchPromotion(lower)?.let { return it }

        // Abstain rather than guess. OTHER is a real answer here: it means
        // "the rules did not recognise this", which a later learned layer can
        // act on, and which a user sees as an honest "uncategorised" rather
        // than a wrong tab.
        return Classification(Category.OTHER, false, "no rule matched")
    }

    // ------------------------------------------------------------------
    // sender shape
    // ------------------------------------------------------------------

    /**
     * True when the sender is a dialable number rather than a registered
     * commercial header.
     *
     * Indian commercial SMS arrives from headers like `VM-HDFCBK` or
     * `AX-SBIINB`: two characters, a hyphen, then a six-character entity code.
     * Businesses cannot send from a plain mobile number under TRAI's DLT
     * rules, and people cannot send from a header. That makes sender *shape* a
     * structural signal, independent of anything in the text — which is
     * exactly what makes it trustworthy enough to check first.
     *
     * Handles `+91` prefixes, spacing, and short codes. A short numeric code
     * (like a 5-digit service number) is deliberately NOT personal.
     */
    fun isPersonalSender(sender: String): Boolean {
        val cleaned = sender.trim().replace(" ", "").replace("-", "")
        val digits = cleaned.removePrefix("+")
        if (digits.isEmpty()) return false
        if (!digits.all { it.isDigit() }) return false
        // 10 local digits, or 12 with the 91 country code. Anything shorter is
        // a service short code, which is commercial.
        val national = digits.removePrefix("91")
        return national.length == 10
    }

    // ------------------------------------------------------------------
    // rules
    // ------------------------------------------------------------------

    private val OTP_WORDS = listOf(
        "otp", "one time password", "one-time password", "verification code",
        "security code", "do not share", "never share", "dont share", "don't share"
    )

    private fun matchOtp(lower: String, body: String): Classification? {
        val hasWord = OTP_WORDS.any { lower.contains(it) }
        if (!hasWord) return null
        // Require an actual code alongside the word. "Never share your PIN
        // with anyone" is a bank advisory, not an OTP, and burying advisories
        // in the OTP tab trains people to ignore it.
        val hasCode = CODE_RE.containsMatchIn(body)
        return if (hasCode) {
            Classification(Category.OTP, true, "OTP keyword with a numeric code")
        } else {
            null
        }
    }

    /**
     * A standalone 4-8 digit code.
     *
     * The boundaries need care in both directions. They must reject a decimal
     * fragment -- `5000` out of `5000.50` -- without also rejecting a code
     * that simply ends a sentence, `...is 448122.`, which is how most real
     * OTP messages are written. So the guard is specifically "not adjacent to
     * a digit, and not part of a digit-period-digit run", rather than the
     * blunter "not adjacent to a digit or a period" that failed the
     * end-of-sentence case.
     */
    private val CODE_RE = Regex("""(?<!\d)(?<!\d\.)\d{4,8}(?!\d)(?!\.\d)""")

    private val DEBIT_WORDS = listOf(
        "debited", "debit", "spent", "withdrawn", "paid", "purchase",
        "deducted", "sent to", "transferred to"
    )
    private val CREDIT_WORDS = listOf(
        "credited", "credit", "received", "deposited", "refund", "cashback"
    )

    private fun matchTransaction(lower: String, body: String): Classification? {
        if (!AMOUNT_RE.containsMatchIn(body)) return null
        val debit = DEBIT_WORDS.any { lower.contains(it) }
        val credit = CREDIT_WORDS.any { lower.contains(it) }
        if (!debit && !credit) return null
        // "will be debited" / "due to be debited" is a future obligation, not
        // a completed movement -- that is a bill, and matchBill will take it.
        if (FUTURE_RE.containsMatchIn(lower)) return null
        val direction = if (debit && !credit) "debit" else if (credit && !debit) "credit" else "ambiguous"
        return Classification(
            Category.TRANSACTION,
            confident = direction != "ambiguous",
            why = "amount present with $direction wording"
        )
    }

    /**
     * Rupee amounts in the forms Indian banks actually send.
     *
     * The optional decimal group is `(?:\.\d{1,2})?` and not `\.?\d*`, and the
     * whole-number part is matched greedily before it. An earlier
     * implementation of this idea used alternation that could match `Rs.5000`
     * as `Rs.` + `5000` split badly and yield 500 -- a silent factor-of-ten
     * error in a spending total. The test suite pins that case explicitly.
     */
    private val AMOUNT_RE = Regex(
        """(?:rs\.?|inr|₹)\s*\d[\d,]*(?:\.\d{1,2})?""",
        RegexOption.IGNORE_CASE
    )

    private val FUTURE_RE = Regex(
        """\b(will be|shall be|is due to be|due to be|scheduled to be)\s+(debited|deducted|charged)"""
    )

    private val BILL_WORDS = listOf(
        "bill", "due date", "is due", "payment due", "outstanding",
        "minimum amount due", "total amount due", "last date", "overdue",
        "recharge", "validity expires", "expires on", "renew", "premium due", "emi"
    )

    private fun matchBill(lower: String): Classification? {
        val hit = BILL_WORDS.firstOrNull { lower.contains(it) } ?: return null
        return Classification(Category.BILL, true, "bill wording: \"$hit\"")
    }

    private val TRAVEL_WORDS = listOf(
        "pnr", "boarding", "flight", "departure", "seat no", "coach",
        "train", "irctc", "gate no", "check-in", "cab", "ride", "driver"
    )

    private fun matchTravel(lower: String, body: String): Classification? {
        val hit = TRAVEL_WORDS.firstOrNull { lower.contains(it) } ?: return null
        return Classification(Category.TRAVEL, true, "travel wording: \"$hit\"")
    }

    private val DELIVERY_WORDS = listOf(
        "out for delivery", "delivered", "shipped", "dispatched", "your order",
        "order id", "tracking", "courier", "arriving", "package"
    )

    private fun matchDelivery(lower: String): Classification? {
        val hit = DELIVERY_WORDS.firstOrNull { lower.contains(it) } ?: return null
        return Classification(Category.DELIVERY, true, "delivery wording: \"$hit\"")
    }

    private val PROMO_WORDS = listOf(
        "offer", "sale", "discount", "% off", "flat ", "coupon", "deal",
        "t&c apply", "tnc apply", "click here", "shop now", "buy now",
        "limited time", "hurry", "exclusive", "unsubscribe", "lowest price"
    )

    private fun matchPromotion(lower: String): Classification? {
        val hit = PROMO_WORDS.firstOrNull { lower.contains(it) } ?: return null
        return Classification(Category.PROMOTION, true, "promotional wording: \"$hit\"")
    }
}
