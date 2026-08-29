package com.adabala.sandeshika.classify

import java.util.Calendar
import java.util.Locale

/**
 * Reads "what do I owe, and by when" out of a bill message.
 *
 * Deterministic like [TransactionParser], and for the same reason: a due date
 * shown on a dashboard is acted on. Getting it wrong by a week is worse than
 * showing nothing, because someone stops checking their own bills once they
 * believe the app is doing it.
 *
 * ## The year problem
 *
 * Bank and utility SMS routinely omit the year: "due on 18-Jun", "pay by
 * 05/09". Guessing the current year makes every December bill look overdue
 * for the whole of January. So a bare date resolves to the nearest sensible
 * future occurrence, with a small backward tolerance for bills that just
 * lapsed — those still matter, and hiding them would be its own failure.
 */
object DueDateParser {

    data class Due(
        val amount: Double?,
        /** Epoch millis, midnight local, or null when no date could be read. */
        val dueAt: Long?,
        val label: String
    ) {
        fun daysFrom(now: Long): Int? = dueAt?.let {
            ((it - startOfDay(now)) / 86_400_000L).toInt()
        }
    }

    fun parse(sms: Sms, now: Long = System.currentTimeMillis()): Due? {
        val body = sms.body
        if (!DUE_CONTEXT.containsMatchIn(body)) return null

        val amount = AMOUNT.find(body)?.groupValues?.get(2)
            ?.replace(",", "")?.toDoubleOrNull()
        val dueAt = findDate(body, now)
        if (amount == null && dueAt == null) return null

        return Due(amount, dueAt, sms.sender)
    }

    /**
     * Only messages that actually state an obligation.
     *
     * A payment confirmation also contains an amount and a date, and treating
     * it as a bill would put settled payments in an upcoming-dues list — which
     * makes the list untrustworthy in the one way that matters, by showing
     * things that are not owed.
     */
    private val DUE_CONTEXT = Regex(
        """\b(due|payable|outstanding|unpaid|overdue|last date|pay by|before|bill for|minimum amount)\b""",
        RegexOption.IGNORE_CASE
    )

    private val AMOUNT = Regex(
        """(rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)""",
        RegexOption.IGNORE_CASE
    )

    private val MONTHS = listOf(
        "jan", "feb", "mar", "apr", "may", "jun",
        "jul", "aug", "sep", "oct", "nov", "dec"
    )

    private val DMY = Regex("""\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\b""")
    private val D_MON = Regex(
        """\b(\d{1,2})[-\s]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:[-\s](\d{2,4}))?\b""",
        RegexOption.IGNORE_CASE
    )

    private fun findDate(body: String, now: Long): Long? {
        D_MON.find(body)?.let { m ->
            val day = m.groupValues[1].toIntOrNull() ?: return@let
            val month = MONTHS.indexOf(m.groupValues[2].lowercase().take(3))
            if (month < 0) return@let
            val year = m.groupValues[3].toIntOrNull()?.let { normaliseYear(it) }
            return build(day, month, year, now)
        }
        DMY.find(body)?.let { m ->
            val day = m.groupValues[1].toIntOrNull() ?: return@let
            // Indian convention is day-first. Reading 05/09 as 9 May rather
            // than 5 September silently moves a due date by months, and the
            // ambiguity is invisible for any day under 13.
            val month = (m.groupValues[2].toIntOrNull() ?: return@let) - 1
            if (day !in 1..31 || month !in 0..11) return@let
            val year = m.groupValues[3].toIntOrNull()?.let { normaliseYear(it) }
            return build(day, month, year, now)
        }
        return null
    }

    private fun normaliseYear(y: Int) = if (y < 100) 2000 + y else y

    /**
     * Resolves a day and month to an actual instant.
     *
     * With no year stated, picks the occurrence nearest to now rather than
     * assuming the current year. [BACKWARD_TOLERANCE_DAYS] of slack keeps a
     * bill that lapsed last week visible instead of flinging it a year
     * forward — a recently missed payment is exactly what someone needs to
     * see.
     */
    private fun build(day: Int, month: Int, year: Int?, now: Long): Long? = runCatching {
        val cal = Calendar.getInstance(Locale.getDefault())
        if (year != null) {
            cal.timeInMillis = now
            cal.set(year, month, day, 0, 0, 0)
            cal.set(Calendar.MILLISECOND, 0)
            return cal.timeInMillis
        }
        cal.timeInMillis = now
        val thisYear = cal.get(Calendar.YEAR)
        val candidates = listOf(thisYear - 1, thisYear, thisYear + 1).map { y ->
            Calendar.getInstance().apply {
                set(y, month, day, 0, 0, 0); set(Calendar.MILLISECOND, 0)
            }.timeInMillis
        }
        val floor = startOfDay(now) - BACKWARD_TOLERANCE_DAYS * 86_400_000L
        candidates.filter { it >= floor }.minByOrNull { it } ?: candidates.max()
    }.getOrNull()

    private const val BACKWARD_TOLERANCE_DAYS = 20L

    private fun startOfDay(millis: Long): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    /**
     * Upcoming dues, soonest first, deduplicated by sender.
     *
     * Utilities send the same reminder repeatedly as a deadline approaches.
     * Listing every copy would bury five real bills under thirty reminders
     * about one of them, so only the most recent message per sender survives.
     */
    fun upcoming(
        items: List<Pair<Sms, Classification>>,
        now: Long = System.currentTimeMillis(),
        withinDays: Int = 30
    ): List<Due> {
        val horizon = startOfDay(now) + withinDays * 86_400_000L
        val floor = startOfDay(now) - BACKWARD_TOLERANCE_DAYS * 86_400_000L
        return items.asSequence()
            .filter { it.second.category == Category.BILL }
            .sortedByDescending { it.first.receivedAt }
            .distinctBy { it.first.sender }
            .mapNotNull { parse(it.first, now) }
            .filter { it.dueAt != null && it.dueAt in floor..horizon }
            .sortedBy { it.dueAt }
            .toList()
    }
}
