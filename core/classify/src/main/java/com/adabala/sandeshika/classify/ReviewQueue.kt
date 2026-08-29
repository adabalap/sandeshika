package com.adabala.sandeshika.classify

/**
 * Decides which messages are worth asking about.
 *
 * ## Why this is not just "show the uncategorised tab"
 *
 * A real inbox leaves thousands of messages unlabelled. Asking someone to
 * work through them in arrival order guarantees they stop before reaching
 * anything that matters, because the order carries no information about
 * value. The uncategorised pile is not a queue; it is a heap with a few
 * genuinely valuable items buried in it.
 *
 * Value here is concrete and countable: **how many messages does this one
 * label fix?** Corrections are keyed by shape, so labelling one of 311
 * near-identical offers re-files all 311. Labelling a singleton fixes one.
 * A ranked queue means twenty taps can settle several thousand messages,
 * which is the difference between a feature people finish and one they
 * abandon.
 *
 * ## Why unknown outranks uncertain
 *
 * Two kinds of message need labels, and they are not equally urgent.
 * Messages nothing could classify are genuinely unknown. Messages the model
 * guessed at are *displayed to the user as a category already* — possibly
 * wrongly, and with no way for them to know which. Both deserve attention,
 * but the unknown ones are where a label adds information rather than
 * confirming it, so they come first at equal volume.
 */
object ReviewQueue {

    data class Candidate(
        val shapeKey: String,
        /** A representative message; what gets shown when asking. */
        val sample: Sms,
        /** How many messages share this shape, and so how many a label fixes. */
        val impact: Int,
        /** The model's guess, if it made one. Null when nothing could classify it. */
        val suggested: Category?
    )

    /**
     * Builds the queue, most valuable first.
     *
     * [alreadyCorrected] shapes are excluded outright rather than ranked
     * last: re-asking about something the user has already answered is the
     * fastest way to make them stop trusting the queue.
     */
    fun build(
        classified: List<Triple<String, Sms, Classification>>,
        alreadyCorrected: Set<String> = emptySet(),
        limit: Int = 50
    ): List<Candidate> {
        val byShape = mutableMapOf<String, MutableList<Pair<Sms, Classification>>>()
        for ((key, sms, c) in classified) {
            if (key in alreadyCorrected) continue
            // Rule-classified messages are structurally certain and not worth
            // a person's attention. Only the unknown and the guessed-at are.
            val worthAsking = c.category == Category.OTHER || !c.confident
            if (!worthAsking) continue
            byShape.getOrPut(key) { mutableListOf() }.add(sms to c)
        }

        return byShape.map { (key, group) ->
            val first = group.first()
            Candidate(
                shapeKey = key,
                sample = first.first,
                impact = group.size,
                suggested = first.second.category.takeIf { it != Category.OTHER }
            )
        }.sortedWith(
            // Unknown before guessed, then by how many messages a label fixes.
            compareBy<Candidate> { if (it.suggested == null) 0 else 1 }
                .thenByDescending { it.impact }
        ).take(limit)
    }

    /**
     * How many messages the whole queue would settle.
     *
     * Shown to the user because effort with no visible payoff does not get
     * repeated. "These 20 shapes cover 1,847 messages" is a reason to start;
     * an unbounded list of things to fix is a reason not to.
     */
    fun reach(candidates: List<Candidate>): Int = candidates.sumOf { it.impact }
}
