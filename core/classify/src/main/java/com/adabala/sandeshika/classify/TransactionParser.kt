package com.adabala.sandeshika.classify

/**
 * Pulls the money out of a transaction message.
 *
 * Deterministic on purpose, and never a model. A spending total is either
 * right or worthless — a figure that is 97% accurate cannot be used for
 * anything, because the 3% is indistinguishable from the rest and every
 * number becomes a maybe. Categories can be inferred; amounts must be read.
 *
 * ## The traps, each of which produces a wrong total silently
 *
 * **The balance is not the amount.** "Rs 500 debited. Avl bal: Rs 2,000"
 * contains two rupee figures and only one of them is the transaction. Taking
 * the largest, or the last, inflates a month's spending by an arbitrary
 * amount. The parser reads the figure attached to the movement verb and
 * explicitly discards balance clauses first.
 *
 * **Self-transfers are not spending.** Moving money between your own accounts
 * generates a debit message and a credit message. Counting the debit makes
 * the total wrong every time, and it was exactly this that inflated a daily
 * figure from ₹8,478 to ₹13,478 in an earlier build of this app.
 *
 * **Decimal handling.** `Rs.5000` must not parse as 500. That specific
 * failure shipped once, in a regex where an alternation split the number.
 */
object TransactionParser {

    enum class Direction { DEBIT, CREDIT }

    data class Txn(
        val amount: Double,
        val direction: Direction,
        /** Who received or sent it, when the message names them. */
        val counterparty: String?,
        /** True when this looks like money moved between the user's own accounts. */
        val selfTransfer: Boolean
    ) {
        /** What counts toward spending. Credits and self-transfers do not. */
        val isSpend: Boolean get() = direction == Direction.DEBIT && !selfTransfer
    }

    fun parse(sms: Sms): Txn? {
        val body = sms.body
        // Balance clauses are removed before any amount is read, so the
        // trailing "Avl bal: Rs 2,000" can never be mistaken for the
        // transaction. Done first because every later step assumes the
        // remaining amounts describe the movement.
        val withoutBalance = BALANCE_CLAUSE.replace(body, " ")

        val amounts = AMOUNT.findAll(withoutBalance).mapNotNull { m ->
            m.groupValues[2].replace(",", "").toDoubleOrNull()
        }.toList()
        if (amounts.isEmpty()) return null

        val lower = withoutBalance.lowercase()
        val debit = DEBIT.containsMatchIn(lower)
        val credit = CREDIT.containsMatchIn(lower)
        // A message naming two accounts, one debited and one credited, is a
        // transfer rather than an ambiguous message. On a real inbox this
        // shape ("Acct A debited with Rs X & Acct B credited") accounted for
        // ~180 messages that were being refused outright. Treating it as a
        // transfer records it while keeping it out of spending, which is the
        // safe direction to be wrong in: a transfer wrongly counted as
        // spending inflates the total, whereas one wrongly excluded only
        // understates activity the user can still see in the list.
        val bothLegs = debit && credit &&
            TRANSFER_PAIR.containsMatchIn(lower) &&
            ACCOUNT_MENTION.containsMatchIn(lower)
        val direction = when {
            bothLegs -> Direction.DEBIT
            debit && !credit -> Direction.DEBIT
            credit && !debit -> Direction.CREDIT
            // Genuinely ambiguous messages are still refused. A wrong
            // direction does not merely miss a transaction, it moves money
            // the wrong way in the total -- an error of twice the amount.
            else -> return null
        }

        return Txn(
            // The first amount after balance removal is the transaction. Banks
            // lead with it; anything later is a fee, a limit or a reference.
            amount = amounts.first(),
            direction = direction,
            counterparty = COUNTERPARTY.find(body)?.groupValues?.get(2)?.trim()?.takeIf { it.isNotBlank() },
            selfTransfer = bothLegs || SELF_TRANSFER.containsMatchIn(lower)
        )
    }

    /**
     * Rupee amounts. The whole-number part is matched greedily and the
     * decimal group is optional as a unit, so `Rs.5000` yields 5000 rather
     * than splitting at the dot and yielding 500.
     */
    private val AMOUNT = Regex(
        """(rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)""",
        RegexOption.IGNORE_CASE
    )

    /**
     * Balance clauses, in the wordings Indian banks actually use.
     *
     * Matched up to the end of the number so the surrounding sentence
     * survives; removing the whole tail would also remove a fee or a second
     * leg that the caller may care about later.
     */
    private val BALANCE_CLAUSE = Regex(
        """\b(avl|avbl|available|closing|current|updated|a/c|total)?\s*(bal|balance)\b[^.\n]{0,20}?(rs\.?|inr|₹)\s*[\d,]+(\.\d{1,2})?""",
        RegexOption.IGNORE_CASE
    )

    private val DEBIT = Regex(
        """\b(debited|debit|spent|withdrawn|withdrawal|paid|purchase|deducted|sent|transferred)\b""",
        RegexOption.IGNORE_CASE
    )
    private val CREDIT = Regex(
        """\b(credited|credit|received|deposited|refund(?:ed)?|cashback)\b""",
        RegexOption.IGNORE_CASE
    )

    private val COUNTERPARTY = Regex(
        """\b(to|at|from)\s+([A-Z][A-Za-z0-9&.\- ]{2,30}?)(?=\s+(on|via|ref|upi|a/c|\.|$)|[.\n]|$)"""
    )

    /**
     * Money moved between the user's own accounts.
     *
     * Deliberately conservative. Marking a genuine payment as a self-transfer
     * hides real spending, which is a worse and much less visible error than
     * leaving one in — so only explicit self-transfer language counts, not a
     * guess based on the counterparty resembling the account holder.
     */
    /**
     * "Acct A debited ... & Acct B credited" and similar two-leg wordings.
     *
     * The gap allows any character, including dots. An earlier version used
     * `[^.\n]` and therefore never matched a single real message, because
     * every one of them contains `Rs 5555.00` or a date between the two
     * verbs. It looked correct and did nothing.
     */
    private val TRANSFER_PAIR = Regex(
        """\bdebited\b.{0,100}?\bcredited\b|\bcredited\b.{0,100}?\bdebited\b""",
        RegexOption.IGNORE_CASE
    )

    /**
     * Required alongside [TRANSFER_PAIR] before calling something a transfer.
     *
     * Both verbs appearing is not enough on its own: "Rs 100 debited and
     * Rs 50 credited" is two different sums and genuinely ambiguous, and
     * silently calling it a transfer would hide a real debit from the
     * spending total. A named account is what distinguishes a bank
     * describing one movement between two accounts from a message that
     * simply mentions both words.
     */
    private val ACCOUNT_MENTION = Regex("""\b(a/?c|acct|account)\b""", RegexOption.IGNORE_CASE)

    private val SELF_TRANSFER = Regex(
        """\b(self[- ]?transfer|own account|between your accounts|to your own|self a/c|transfer to self)\b""",
        RegexOption.IGNORE_CASE
    )
}
