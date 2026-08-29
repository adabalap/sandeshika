package com.adabala.sandeshika.classify

import java.util.Calendar

/**
 * Decides how to answer a question about the inbox.
 *
 * ## The rule that shapes everything here
 *
 * **Arithmetic never goes through the model.** If a question is answerable by
 * summing parsed amounts, this computes it and returns the number directly.
 * A language model asked to add two hundred rupee figures will occasionally
 * get one wrong, and there is no way to tell which time — so a total it
 * produced is a total nobody can rely on, which makes it worse than no
 * feature at all.
 *
 * Medha's job is language: understanding a question phrased in a hundred
 * different ways, and reading a handful of messages to answer something no
 * sum can. Those are the things a model is genuinely better at than code.
 *
 * ## Retrieval is local
 *
 * For questions that need message content, the *app* selects which messages
 * are relevant and passes only those as context. Medha is never handed the
 * inbox to index. That keeps the amount of data leaving this app small and
 * inspectable, avoids a second copy of every message living somewhere else,
 * and means nothing goes stale when the inbox changes.
 */
object QuestionRouter {

    sealed interface Plan {
        /** Answerable by arithmetic. No model involved. */
        data class Computed(val answer: String) : Plan

        /** Needs a model, given these messages as context. */
        data class AskModel(val question: String, val context: List<Sms>) : Plan

        /** Nothing relevant found; saying so beats inventing an answer. */
        data class NothingFound(val reason: String) : Plan
    }

    private val SPEND_Q = Regex(
        """\b(how much|total|sum).{0,30}\b(spen[dt]|paid|debited|cost)|
           \bspen[dt]\b.{0,20}\b(how much|total)""".trimIndent().replace("\n", "").replace(" ", "\\s*"),
        setOf(RegexOption.IGNORE_CASE)
    )
    private val RECEIVED_Q = Regex(
        """\b(how much|total).{0,30}\b(receiv|credit|earn|income)""",
        RegexOption.IGNORE_CASE
    )

    fun plan(
        question: String,
        messages: List<Pair<Sms, Classification>>,
        now: Long = System.currentTimeMillis()
    ): Plan {
        val q = question.trim()
        if (q.isBlank()) return Plan.NothingFound("Ask something about your messages.")

        val range = TimeRange.parse(q, now)

        if (SPEND_Q.containsMatchIn(q) || RECEIVED_Q.containsMatchIn(q)) {
            val wantSpend = SPEND_Q.containsMatchIn(q)
            var total = 0.0
            var count = 0
            var unreadable = 0
            messages.forEach { (sms, c) ->
                if (c.category != Category.TRANSACTION) return@forEach
                if (sms.receivedAt !in range.from..range.to) return@forEach
                val txn = TransactionParser.parse(sms)
                if (txn == null) { unreadable++; return@forEach }
                val matches = if (wantSpend) txn.isSpend
                              else txn.direction == TransactionParser.Direction.CREDIT
                if (matches) { total += txn.amount; count++ }
            }
            if (count == 0) {
                return Plan.NothingFound("No ${if (wantSpend) "spending" else "income"} found ${range.label}.")
            }
            val verb = if (wantSpend) "spent" else "received"
            // The caveat travels with the number rather than being tucked
            // away in a settings screen. A total whose coverage is invisible
            // invites more confidence than it has earned.
            val caveat = if (unreadable > 0) {
                " ($unreadable message${if (unreadable == 1) "" else "s"} could not be read and are not included)"
            } else {
                ""
            }
            return Plan.Computed(
                "You $verb ${Dashboard.formatRupees(total)} ${range.label}, across $count transactions.$caveat"
            )
        }

        val relevant = retrieve(q, messages, range)
        if (relevant.isEmpty()) {
            return Plan.NothingFound("Nothing in your messages looks related to that.")
        }
        return Plan.AskModel(q, relevant)
    }

    /**
     * Picks the messages worth sending as context.
     *
     * Keyword overlap, scored and capped. Deliberately simple: the model is
     * good at reading a handful of messages and poor at reading two hundred,
     * so the win comes from sending few and relevant rather than from
     * clever ranking. The cap also bounds how much of the inbox can leave
     * this app for any single question.
     */
    fun retrieve(
        question: String,
        messages: List<Pair<Sms, Classification>>,
        range: TimeRange,
        limit: Int = 8
    ): List<Sms> {
        val terms = question.lowercase()
            .split(Regex("""[^a-z0-9]+"""))
            .filter { it.length > 2 && it !in STOPWORDS }
            .toSet()
        if (terms.isEmpty()) return emptyList()

        return messages.asSequence()
            .filter { it.first.receivedAt in range.from..range.to }
            .map { (sms, _) ->
                val body = sms.body.lowercase()
                val hits = terms.count { body.contains(it) }
                sms to hits
            }
            .filter { it.second > 0 }
            // Recency breaks ties: for "what did Airtel say about my plan",
            // the newest matching message is almost always the intended one.
            .sortedWith(compareByDescending<Pair<Sms, Int>> { it.second }
                .thenByDescending { it.first.receivedAt })
            .take(limit)
            .map { it.first }
            .toList()
    }

    private val STOPWORDS = setOf(
        "the", "was", "were", "what", "when", "how", "did", "does", "for",
        "and", "any", "are", "you", "your", "from", "with", "about", "that",
        "this", "have", "has", "much", "many", "tell", "show", "give", "all"
    )

    /** A resolved time window plus how to describe it in an answer. */
    data class TimeRange(val from: Long, val to: Long, val label: String) {
        companion object {
            fun parse(question: String, now: Long): TimeRange {
                val q = question.lowercase()
                val cal = { Calendar.getInstance().apply { timeInMillis = now } }
                return when {
                    "today" in q -> {
                        val c = cal().apply { midnight() }
                        TimeRange(c.timeInMillis, now, "today")
                    }
                    "yesterday" in q -> {
                        val c = cal().apply { add(Calendar.DAY_OF_YEAR, -1); midnight() }
                        val end = cal().apply { midnight() }
                        TimeRange(c.timeInMillis, end.timeInMillis, "yesterday")
                    }
                    "last month" in q -> {
                        val start = cal().apply { add(Calendar.MONTH, -1); set(Calendar.DAY_OF_MONTH, 1); midnight() }
                        val end = cal().apply { set(Calendar.DAY_OF_MONTH, 1); midnight() }
                        TimeRange(start.timeInMillis, end.timeInMillis, "last month")
                    }
                    "this month" in q || "month" in q -> {
                        val c = cal().apply { set(Calendar.DAY_OF_MONTH, 1); midnight() }
                        TimeRange(c.timeInMillis, now, "this month")
                    }
                    "week" in q -> {
                        val c = cal().apply { add(Calendar.DAY_OF_YEAR, -7) }
                        TimeRange(c.timeInMillis, now, "in the last week")
                    }
                    "year" in q -> {
                        val c = cal().apply { add(Calendar.YEAR, -1) }
                        TimeRange(c.timeInMillis, now, "in the last year")
                    }
                    // No stated period means everything. Silently assuming
                    // "this month" would answer a different question from the
                    // one asked, and the person would have no way to notice.
                    else -> TimeRange(0L, now, "in total")
                }
            }

            private fun Calendar.midnight() {
                set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }
        }
    }

    /**
     * The prompt sent to Medha.
     *
     * States explicitly that the answer must come from the supplied messages.
     * Without that, a model asked about a bill will happily produce a
     * plausible due date from nowhere — and a confident invented date is
     * worse than "I could not find that", because the person will act on it.
     */
    fun buildPrompt(question: String, context: List<Sms>): String = buildString {
        append("Answer using only the SMS messages below. ")
        append("If they do not contain the answer, say so plainly. ")
        append("Do not calculate totals; if asked for one, say it is not available here.\n\n")
        context.forEachIndexed { i, sms ->
            append("[").append(i + 1).append("] from ").append(sms.sender).append(": ")
            append(sms.body.take(320)).append("\n")
        }
        append("\nQuestion: ").append(question)
    }
}
