package com.adabala.sandeshika.pipeline

/**
 * Discovers SMS templates from data, without a vocabulary or a stoplist.
 *
 * ## Why this exists
 *
 * Institutional SMS is machine-generated. A five-year inbox of 40,000 messages
 * is realistically a few hundred templates. If the app learns the templates, it
 * can extract deterministically forever after, and the LLM is needed only for
 * genuinely novel senders. That is the difference between an app that runs all
 * day on a phone and one that cooks the SoC.
 *
 * ## Why alignment and not token count
 *
 * The first version clustered on (sender, token count, prefix) and diffed
 * members positionally. It worked until "to SWIGGY" met "to UBER INDIA":
 * merchant names are variable LENGTH, so token count differed and the same
 * bank template was learned twice — and would have been learned a third time
 * for "RELIANCE SMART POINT HYDERABAD".
 *
 * So token count cannot be part of the cluster key. Bucket on sender plus a
 * short leading prefix, score candidates by sequence similarity, and merge by
 * aligning them — collapsing each differing span to a single [VAR].
 *
 * A stoplist of "words that are really merchant names" is the obvious
 * alternative and the wrong one: it never stops needing curation, and it is
 * wrong for every bank whose templates nobody has read yet. Alignment learns
 * the slot from two examples, in any language, with no vocabulary at all.
 */
class TemplateMiner(
    private val mergeRatio: Float = 0.62f,
    private val prefixTokens: Int = 3
) {

    data class Template(
        val fp: String,
        val skeleton: String,
        val tokens: List<String>,
        val count: Int,
        val slots: List<Int>
    )

    enum class Status { NEW, REFINED, MATCHED }

    data class Result(val template: Template, val status: Status)

    private class Cluster(var tokens: List<String>, var count: Int)

    private val buckets = HashMap<String, MutableList<Cluster>>()

    fun add(senderNorm: String, body: String): Result {
        val tokens = Sanitizer.skeleton(body).split(' ').filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return Result(view(Cluster(emptyList(), 1)), Status.NEW)

        val key = senderNorm + "|" + tokens.take(prefixTokens).joinToString(" ")
        val bucket = buckets.getOrPut(key) { mutableListOf() }

        var best: Cluster? = null
        var bestRatio = 0f
        for (c in bucket) {
            val r = similarity(c.tokens, tokens)
            if (r > bestRatio) { best = c; bestRatio = r }
        }

        if (best != null && bestRatio >= mergeRatio) {
            val merged = align(best.tokens, tokens)
            val status = if (merged == best.tokens) Status.MATCHED else Status.REFINED
            best.tokens = merged
            best.count++
            return Result(view(best), status)
        }

        val fresh = Cluster(tokens, 1)
        bucket.add(fresh)
        return Result(view(fresh), Status.NEW)
    }

    fun all(): List<Template> = buckets.values.flatten().map(::view)

    /** Seed the miner from persisted templates on cold start. */
    fun restore(senderNorm: String, tokens: List<String>, count: Int) {
        if (tokens.isEmpty()) return
        val key = senderNorm + "|" + tokens.take(prefixTokens).joinToString(" ")
        buckets.getOrPut(key) { mutableListOf() }.add(Cluster(tokens, count))
    }

    private fun view(c: Cluster): Template {
        val skel = c.tokens.joinToString(" ")
        return Template(
            fp = Sanitizer.sha256Short(skel),
            skeleton = skel,
            tokens = c.tokens,
            count = c.count,
            slots = c.tokens.indices.filter { c.tokens[it] == VAR }
        )
    }

    // ── sequence alignment ────────────────────────────────────────────

    /** Ratio of matched tokens to total length. Mirrors difflib's ratio(). */
    internal fun similarity(a: List<String>, b: List<String>): Float {
        if (a.isEmpty() && b.isEmpty()) return 1f
        if (a.isEmpty() || b.isEmpty()) return 0f
        return 2f * lcs(a, b) / (a.size + b.size)
    }

    /** Merge two token lists; every differing span collapses to one [VAR]. */
    internal fun align(a: List<String>, b: List<String>): List<String> {
        val out = ArrayList<String>(maxOf(a.size, b.size))
        var i = 0
        var j = 0
        val table = lcsTable(a, b)
        while (i < a.size && j < b.size) {
            if (a[i] == b[j]) {
                out.add(a[i]); i++; j++
            } else {
                // Walk the whole divergent span, then emit one slot for it.
                pushVar(out)
                if (table[i + 1][j] >= table[i][j + 1]) i++ else j++
            }
        }
        if (i < a.size || j < b.size) pushVar(out)
        return out
    }

    private fun pushVar(out: MutableList<String>) {
        if (out.isEmpty() || out.last() != VAR) out.add(VAR)
    }

    private fun lcs(a: List<String>, b: List<String>): Int = lcsTable(a, b)[0][0]

    /**
     * Suffix LCS table: table[i][j] is the LCS length of a[i..] and b[j..].
     * Built suffix-wise so [align] can consult it while walking forward.
     */
    private fun lcsTable(a: List<String>, b: List<String>): Array<IntArray> {
        val t = Array(a.size + 1) { IntArray(b.size + 1) }
        for (i in a.indices.reversed()) {
            for (j in b.indices.reversed()) {
                t[i][j] = if (a[i] == b[j]) 1 + t[i + 1][j + 1]
                else maxOf(t[i + 1][j], t[i][j + 1])
            }
        }
        return t
    }

    companion object { const val VAR = "<VAR>" }
}
