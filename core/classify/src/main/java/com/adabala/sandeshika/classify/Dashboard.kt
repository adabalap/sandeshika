package com.adabala.sandeshika.classify

import java.util.Calendar

/**
 * The numbers behind the dashboard.
 *
 * Pure aggregation, deliberately separated from the UI so it can be tested.
 * A dashboard that quietly reports a wrong total is worse than no dashboard,
 * because a number on a screen gets believed — and there is no way for
 * someone to sanity-check a spending figure derived from 24,000 messages.
 *
 * Everything monetary comes from [TransactionParser] and nothing else. No
 * estimating, no inferring an amount from context, and messages the parser
 * cannot read with certainty are excluded and *counted*, so the figure is
 * always presented alongside how much it might be missing.
 */
object Dashboard {

    data class Stats(
        val totalMessages: Int,
        val uncategorised: Int,
        val spentThisMonth: Double,
        val receivedThisMonth: Double,
        /** Transactions that contributed to [spentThisMonth]. */
        val spendCount: Int,
        /** Transaction messages the parser could not read, and so excluded. */
        val unparsedTransactions: Int,
        val billCount: Int,
        val byCategory: List<Pair<Category, Int>>,
        val topCounterparties: List<Pair<String, Int>>
    )

    fun compute(
        items: List<Triple<Sms, Classification, Long>>,
        now: Long = System.currentTimeMillis()
    ): Stats {
        val monthStart = startOfMonth(now)
        var spent = 0.0
        var received = 0.0
        var spendCount = 0
        var unparsed = 0
        val counterparties = mutableMapOf<String, Int>()
        val byCat = mutableMapOf<Category, Int>()

        for ((sms, classification, receivedAt) in items) {
            byCat[classification.category] = (byCat[classification.category] ?: 0) + 1
            if (classification.category != Category.TRANSACTION) continue

            val txn = TransactionParser.parse(sms)
            if (txn == null) {
                unparsed++
                continue
            }
            txn.counterparty?.let { counterparties[it] = (counterparties[it] ?: 0) + 1 }

            // Month filtering uses the message timestamp, not anything parsed
            // from the text. A date inside the body may be a due date, a
            // statement period or a transaction date that differs from when
            // the message arrived, and picking the wrong one shifts spending
            // between months in ways nobody can audit.
            if (receivedAt < monthStart) continue
            when {
                txn.isSpend -> { spent += txn.amount; spendCount++ }
                txn.direction == TransactionParser.Direction.CREDIT -> received += txn.amount
                // Self-transfers land here and are counted in neither, which
                // is the whole point of detecting them.
            }
        }

        return Stats(
            totalMessages = items.size,
            uncategorised = byCat[Category.OTHER] ?: 0,
            spentThisMonth = spent,
            receivedThisMonth = received,
            spendCount = spendCount,
            unparsedTransactions = unparsed,
            billCount = byCat[Category.BILL] ?: 0,
            byCategory = byCat.entries.sortedByDescending { it.value }.map { it.key to it.value },
            topCounterparties = counterparties.entries
                .sortedByDescending { it.value }.take(5).map { it.key to it.value }
        )
    }

    private fun startOfMonth(now: Long): Long = Calendar.getInstance().apply {
        timeInMillis = now
        set(Calendar.DAY_OF_MONTH, 1)
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    /** Indian digit grouping: 1,25,000 rather than 125,000. */
    fun formatRupees(amount: Double): String {
        val whole = amount.toLong()
        val s = whole.toString()
        if (s.length <= 3) return "₹$s"
        // Last three digits, then pairs, which is how the lakh/crore system
        // reads. Western grouping on an Indian amount is immediately jarring
        // and makes a familiar figure hard to recognise.
        val last3 = s.takeLast(3)
        val rest = s.dropLast(3)
        val grouped = rest.reversed().chunked(2).joinToString(",").reversed()
        return "₹$grouped,$last3"
    }
}
