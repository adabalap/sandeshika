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

    /**
     * Extra redaction inputs that only exist on a real device.
     *
     * [contactNames] comes from the address book and is by far the most
     * reliable signal available: it is the actual list of people this person
     * knows, so no pattern-matching heuristic is needed to recognise them.
     *
     * [customTerms] is whatever the user adds after reading a preview and
     * spotting something the rules missed. That feedback loop matters more
     * than any single pattern, because the one thing guaranteed about
     * redaction rules is that some inbox will contain a shape nobody
     * anticipated.
     */
    data class RedactionContext(
        val contactNames: Set<String> = emptySet(),
        val customTerms: Set<String> = emptySet()
    )

    private val GENERIC_SALUTATIONS = setOf(
        "customer", "parent", "user", "member", "sir", "madam", "client",
        "subscriber", "guest", "friend", "team", "all", "valued"
    )

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
    fun redactBody(body: String, extra: RedactionContext = RedactionContext()): String {
        var s = body

        // Known contact names first, and they are the strongest tool here.
        //
        // Pattern-based name detection is guesswork -- it cannot tell
        // "Dear Ramesh" from "Dear Customer". The address book is ground
        // truth for the names that actually matter to this person, so any of
        // them appearing anywhere in any message is removed outright,
        // whatever the surrounding grammar. Longest first, so "Ramesh Kumar"
        // is replaced whole rather than leaving a stray "Kumar".
        for (name in extra.contactNames.sortedByDescending { it.length }) {
            if (name.length < 3) continue
            s = s.replace(Regex("""\b${Regex.escape(name)}\b""", RegexOption.IGNORE_CASE), "<NAME>")
        }
        // Anything the user added by hand after reading a preview.
        for (term in extra.customTerms.sortedByDescending { it.length }) {
            if (term.length < 3) continue
            s = s.replace(Regex("""\b${Regex.escape(term)}\b""", RegexOption.IGNORE_CASE), "<REDACTED>")
        }

        // Structured identifiers, before anything generic can fragment them.
        s = s.replace(Regex("""\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"""), "<EMAIL>")
        s = s.replace(Regex("""\b[A-Z]{5}\d{4}[A-Z]\b"""), "<PAN>")
        s = s.replace(Regex("""\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b"""), "<CARD>")
        s = s.replace(Regex("""\b\d{4}\s\d{4}\s\d{4}\b"""), "<AADHAAR>")
        s = s.replace(Regex("""\b[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}\b"""), "<VEHICLE>")

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

        // Salutations. "Dear Ramesh" is a name even though a single
        // title-case word after a preposition is not enough to conclude that
        // anywhere else. Common non-names are excluded so "Dear Customer"
        // and "Dear Parent" survive -- those carry template shape and no PII.
        s = Regex("""\b(?i:dear|hi|hello|mr|mrs|ms|shri|smt)\.?\s+([A-Z][a-z]{2,})""")
            .replace(s) { m ->
                val word = m.groupValues[1]
                if (word.lowercase() in GENERIC_SALUTATIONS) m.value
                else m.value.replace(word, "<NAME>")
            }

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
     * A stable grouping key for a message.
     *
     * More aggressive than [redactBody], and for a different purpose. Redaction
     * preserves detail so a human can read a shape and spot a parser bug —
     * digit counts, currency spacing, which mask style a bank uses. A key
     * wants the opposite: every message that is "the same message with
     * different values" must collapse to one string, so that correcting a
     * single Bata offer re-labels all 311 of them instead of one.
     *
     * So digit lengths collapse, every remaining name and reference goes, and
     * punctuation noise is normalised away.
     */
    fun shapeKey(sender: String, body: String): String {
        var s = redactBody(body)
        s = Regex("""<N\d+(\.DD)?>""").replace(s, "<N>")
        s = Regex("""<ACCT[X*.]?>""").replace(s, "<ACCT>")
        // Alphanumeric reference codes vary per message and would otherwise
        // split one template into hundreds of singletons.
        s = Regex("""\b(?=[A-Za-z0-9]{6,})(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}\b""").replace(s, "<REF>")
        s = Regex("""\b\d+\b""").replace(s, "<N>")
        s = Regex("""[^a-z0-9<>]+""", RegexOption.IGNORE_CASE).replace(s, " ")
        return redactSender(sender) + "|" + s.lowercase().trim()
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
        onlyUncategorised: Boolean = true,
        context: RedactionContext = RedactionContext()
    ): List<Template> {
        val excluded = setOf(Category.PERSONAL, Category.OTP)
        val grouped = mutableMapOf<Pair<String, String>, MutableList<Category>>()

        for ((_, sms) in messages) {
            val category = RuleClassifier.classify(sms).category
            if (category in excluded) continue
            if (onlyUncategorised && category != Category.OTHER) continue
            val key = redactSender(sms.sender) to redactBody(sms.body, context)
            grouped.getOrPut(key) { mutableListOf() }.add(category)
        }

        return grouped.map { (key, cats) ->
            Template(key.first, key.second, cats.size, cats.first())
        }.sortedByDescending { it.count }
    }

    /**
     * CSV, for opening in a spreadsheet and reviewing before sharing.
     *
     * Quoting is not optional here: message shapes routinely contain commas,
     * quotes and newlines, and an unquoted export would silently shear rows
     * apart in Excel -- producing a file that looks fine until someone acts
     * on a mangled row.
     */
    fun renderCsv(templates: List<Template>): String = buildString {
        append("count,sender,category,shape\n")
        templates.forEach { t ->
            append(t.count).append(',')
            append(csv(t.sender)).append(',')
            append(t.category).append(',')
            append(csv(t.shape)).append('\n')
        }
    }

    private fun csv(v: String): String =
        "\"" + v.replace("\"", "\"\"").replace("\n", " ") + "\""

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
