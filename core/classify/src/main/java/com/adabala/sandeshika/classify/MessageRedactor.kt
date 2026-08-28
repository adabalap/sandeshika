package com.adabala.sandeshika.classify

/**
 * Turns real messages into shareable *shapes*.
 *
 * The purpose is tuning the classifier without handing over an inbox. Rules
 * key on structure — that a rupee figure is present, and how it is written
 * (`Rs.5000` against `Rs 5,000.00`) — never on the figure itself. So the
 * values can go and the shape can stay, and what comes out is everything a
 * rule needs and nothing it does not.
 *
 * ## What survives on purpose
 *
 * Digit *counts* are preserved: `Rs.5000` becomes `Rs.<N4>`, not `Rs.<N>`.
 * That looks like a detail and is not — the amount bug that cost this project
 * a factor of ten only reproduces at a specific digit length, and a redaction
 * that flattened every number to `<N>` would have hidden it. Same reason
 * separators are kept exactly: `Rs.` and `Rs ` and `INR ` are three different
 * parsing problems.
 *
 * ## What never leaves
 *
 * Personal messages are excluded wholesale rather than redacted. A private
 * conversation has no template worth tuning on, and "we redacted it" is a
 * weaker promise than "we never included it".
 */
object MessageRedactor {

    /** A distinct message shape and how many messages collapsed into it. */
    data class Template(
        val sender: String,
        val shape: String,
        val count: Int,
        val category: Category
    )

    /**
     * Redacts one message body, preserving structure.
     *
     * Order matters. Longer, more specific patterns run first, because a
     * generic digit rule applied early would eat the digits that later
     * patterns need in order to recognise themselves — an account number
     * would become `<N4>` before the account rule ever saw it.
     */
    fun redactBody(body: String): String {
        var s = body

        // URLs first: they contain digits, dots and slashes that every later
        // rule would otherwise carve up into meaningless fragments.
        s = s.replace(Regex("""https?://\S+"""), "<URL>")
        s = s.replace(Regex("""\b(?:[a-z0-9-]+\.)+(?:com|in|io|org|net|co)/\S*""", RegexOption.IGNORE_CASE), "<URL>")

        // Masked account forms, kept distinguishable because banks differ and
        // the parser has to cope with each: XX5261, *5261, ...5261.
        s = s.replace(Regex("""\bX{2,}\d{2,6}\b""", RegexOption.IGNORE_CASE), "<ACCTX>")
        s = s.replace(Regex("""\*+\d{2,6}\b"""), "<ACCT*>")
        s = s.replace(Regex("""\.{3}\d{2,6}\b"""), "<ACCT.>")

        // Amounts. The currency token and its spacing are preserved verbatim;
        // only the digits are replaced, and the replacement records how many
        // there were plus whether it had decimals.
        s = Regex("""(rs\.?|inr|₹)(\s*)([\d,]+)(\.\d{1,2})?""", RegexOption.IGNORE_CASE)
            .replace(s) { m ->
                val digits = m.groupValues[3].filter { it.isDigit() }.length
                val dec = if (m.groupValues[4].isNotEmpty()) ".DD" else ""
                "${m.groupValues[1]}${m.groupValues[2]}<N$digits$dec>"
            }

        // Names, before anything numeric touches them.
        //
        // A UPI transfer carries the payee's actual name -- "To DHANDE
        // PARVATI" -- and an earlier version of this redactor let it straight
        // through, because the tests only checked that *digits* were gone.
        // That is a real person's name leaving the device from the one
        // feature whose entire job is making sure that does not happen.
        //
        // Bank SMS writes names in two recognisable ways, so both are
        // handled. Runs of two or more ALL-CAPS words catch "DHANDE PARVATI"
        // while leaving single tokens like HDFC, OTP and UPDATE alone, since
        // those never appear as a pair. Title-case runs following to/from/at
        // catch "To Dhande Parvati".
        //
        // This over-redacts occasionally -- "DEAR CUSTOMER" becomes <NAME> --
        // and that is the right way to be wrong here. Losing a little shape
        // costs a tuning hint; losing a name costs someone's privacy.
        s = s.replace(Regex("""\b[A-Z]{2,}(?:\s+[A-Z]{2,})+\b"""), "<NAME>")
        // The case-insensitive flag applies inline to the keyword only. Put
        // on the whole pattern it defeats the point: [A-Z][a-z]+ stops
        // meaning "title case" and matches any word at all, which turned
        // "Thank you for Shopping with us" into "for <NAME>" and shredded
        // ordinary marketing copy that carries no personal data whatsoever.
        s = Regex("""\b(?i:to|from|at|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)""")
            .replace(s) { m -> m.value.substringBefore(m.groupValues[1]) + "<NAME>" }
        // UPI virtual payment addresses are identifiers too: name@okhdfcbank.
        s = s.replace(Regex("""\b[\w.\-]{2,}@[a-z]{2,}\b""", RegexOption.IGNORE_CASE), "<VPA>")

        // Phone numbers before bare digit runs, or the digit rule swallows them.
        s = s.replace(Regex("""\+?91[\s-]?\d{10}\b"""), "<PHONE>")
        s = s.replace(Regex("""\b\d{10}\b"""), "<PHONE>")

        // Dates in the forms Indian banks use.
        s = s.replace(Regex("""\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b"""), "<DATE>")
        s = s.replace(
            Regex("""\b\d{1,2}[-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*([-\s]\d{2,4})?\b""", RegexOption.IGNORE_CASE),
            "<DATE>"
        )
        s = s.replace(Regex("""\b\d{1,2}:\d{2}(:\d{2})?\b"""), "<TIME>")

        // Whatever numeric runs are left: reference numbers, OTP codes, UPI
        // ids. Length is kept because a rule that keys on "a 6-digit code"
        // needs to still see six digits.
        s = Regex("""\b\d{3,}\b""").replace(s) { m -> "<N${m.value.length}>" }

        // Collapse whitespace so two messages differing only in line breaks
        // deduplicate into one template rather than two.
        return s.replace(Regex("""\s+"""), " ").trim()
    }

    /**
     * Senders are kept as-is when they are commercial headers and dropped
     * when they are people.
     *
     * `AD-BATAIn-S` is a TRAI-registered business identifier, not personal
     * data, and it is genuinely useful for tuning — sender-specific rules are
     * often the cleanest fix. A phone number is the opposite on both counts.
     */
    fun redactSender(sender: String): String =
        if (RuleClassifier.isPersonalSender(sender)) "<PERSON>" else sender

    /**
     * Collapses messages into distinct templates, most frequent first.
     *
     * [Category.PERSONAL] is dropped entirely rather than redacted, and
     * [Category.OTP] with it: an OTP body is almost pure value, so its
     * redacted shape carries no tuning signal worth the risk of getting the
     * redaction slightly wrong.
     */
    fun templates(
        messages: List<Pair<String, Sms>>,
        onlyUncategorised: Boolean = true
    ): List<Template> {
        val excluded = setOf(Category.PERSONAL, Category.OTP)
        val grouped = mutableMapOf<Pair<String, String>, MutableList<Category>>()

        for ((_, sms) in messages) {
            val category = RuleClassifier.classify(sms).category
            if (category in excluded) continue
            if (onlyUncategorised && category != Category.OTHER) continue
            val key = redactSender(sms.sender) to redactBody(sms.body)
            grouped.getOrPut(key) { mutableListOf() }.add(category)
        }

        return grouped.map { (key, cats) ->
            Template(key.first, key.second, cats.size, cats.first())
        }.sortedByDescending { it.count }
    }

    /** Renders templates as the plain text that actually gets shared. */
    fun render(templates: List<Template>, totalScanned: Int): String = buildString {
        append("Sandeshika classifier tuning export\n")
        append("$totalScanned messages scanned, ${templates.size} distinct shapes\n")
        append("Values redacted. <N4> = a 4-digit number. Personal and OTP messages excluded.\n")
        append("=".repeat(60)).append('\n')
        templates.forEach { t ->
            append("\n[${t.count}x] ${t.sender}  (${t.category})\n")
            append(t.shape).append('\n')
        }
    }
}
