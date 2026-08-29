package com.adabala.sandeshika.classify

/**
 * Turns a message into the features a linear model learns over.
 *
 * ## Why character n-grams and not just words
 *
 * Indian SMS is not tidy English. It mixes Hinglish, transliteration, and
 * bank abbreviations that no dictionary contains: `trxn`, `a/c`, `avl bal`,
 * `Rs.`, `debitd`. Word features treat `debited`, `debitd` and `debit` as
 * three unrelated tokens and learn each one separately, which on a small
 * per-user corpus means learning none of them well. Character 3-grams share
 * `deb`, `ebi`, `bit` across all three, so a form the model has never seen
 * still lands near the ones it has.
 *
 * Both are used rather than one. Word features carry meaning that characters
 * cannot — `credited` and `debited` share most of their trigrams while
 * meaning opposite things — so dropping them would blur exactly the
 * distinction that matters most here.
 */
object Features {

    /**
     * Tokenizes without shattering the patterns that carry the signal.
     *
     * A naive `split(non-letters)` turns `Rs.5000` into `rs` and `5000`, and
     * `a/c` into `a` and `c` — destroying the very shapes that distinguish a
     * bank message from anything else. So money, account and reference forms
     * are recognised first and emitted as single symbolic tokens.
     *
     * Digits collapse to `<num>` rather than being kept. A specific amount is
     * noise for classification: the model must not learn that ₹500 means food
     * and ₹5,000 means rent, because next month it will be a different figure
     * and the lesson was never true anyway.
     */
    fun tokens(body: String): List<String> {
        val out = mutableListOf<String>()
        var s = body.lowercase()

        // Symbolic tokens for the structures that matter, before anything
        // generic can break them apart.
        s = Regex("""(rs\.?|inr|₹)\s*[\d,]+(\.\d{1,2})?""").replace(s) { " <money> " }
        s = Regex("""\ba/?c\b""").replace(s) { " <acct> " }
        s = Regex("""\b(x{2,}|\*+)\d{2,6}\b""").replace(s) { " <acctno> " }
        s = Regex("""\bhttps?://\S+|\b[\w-]+\.(com|in|io|co)/\S*""").replace(s) { " <url> " }
        s = Regex("""\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b""").replace(s) { " <date> " }
        s = Regex("""\b\d{4}-\d{1,2}-\d{1,2}\b""").replace(s) { " <date> " }
        // Day plus month name: "04-Jun", "26 Aug 2025". Extremely common in
        // Indian bank SMS, and missing it leaves a literal month token that
        // the model would learn as a seasonal signal -- "jun means salary" is
        // a pattern it can absolutely pick up and will always be wrong about.
        s = Regex("""\b\d{1,2}[-\s](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*([-\s]\d{2,4})?\b""")
            .replace(s) { " <date> " }
        s = Regex("""\b\d{1,2}:\d{2}\b""").replace(s) { " <time> " }
        s = Regex("""\b\d+\b""").replace(s) { " <num> " }

        for (t in s.split(Regex("""[^a-z<>_]+"""))) {
            if (t.length in 2..24) out.add(t)
        }
        return out
    }

    /**
     * The full feature set: unigrams, bigrams, and character 3-grams.
     *
     * Bigrams are included because word order carries real meaning in this
     * domain — "will be debited" is a bill and "was debited" is a
     * transaction, and unigrams alone cannot tell them apart.
     *
     * Character n-grams are taken from the *tokenized* text, not the raw
     * message, so they inherit the `<money>` and `<acct>` collapsing instead
     * of learning the digits of one person's account number.
     */
    fun extract(body: String): List<String> {
        val words = tokens(body)
        val out = ArrayList<String>(words.size * 6)

        words.forEach { out.add("w:$it") }
        for (i in 0 until words.size - 1) out.add("b:${words[i]}_${words[i + 1]}")

        // Character trigrams, space-padded so word starts and ends are
        // distinguishable: "deb" at the start of a word is a different signal
        // from "deb" in the middle of one.
        val joined = " " + words.joinToString(" ") + " "
        for (i in 0..joined.length - 3) {
            val g = joined.substring(i, i + 3)
            if (g.isNotBlank()) out.add("c:$g")
        }
        return out
    }
}
