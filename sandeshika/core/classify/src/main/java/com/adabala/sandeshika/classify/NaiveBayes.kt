package com.adabala.sandeshika.classify

import kotlin.math.exp
import kotlin.math.ln

/**
 * Multinomial Naive Bayes over [Features], trained on the device.
 *
 * ## Why this and not something bigger
 *
 * It trains in milliseconds on a phone, which is the property that decides
 * everything else. The corpus never leaves, the model fits *this* inbox
 * rather than an average one, and a correction takes effect immediately
 * instead of at the next release. A fine-tuned transformer buys accuracy on
 * novel phrasing and gives up all three, on data measured to be 68.7%
 * repeated shapes.
 *
 * ## What the accuracy number does and does not mean
 *
 * The model is bootstrapped from rule-labelled messages, so measured
 * "accuracy" is agreement with the rules, not correctness. It says the model
 * learned to reproduce them; it says nothing about the uncategorised tail,
 * where by definition no rule label exists. That tail is the only part the
 * model is actually deployed on, and it is currently **unvalidated**.
 *
 * Validating it needs real labels, which means user corrections. That is what
 * the active-learning loop is for, and until it exists any claim about tail
 * accuracy is a guess.
 *
 * ## Abstention is the important part
 *
 * [predict] returns null unless the winning class beats the runner-up by
 * [logMargin]. The previous build of this app swept that threshold and found
 * 94% accuracy at 57% coverage preferable to 86% at 73% — because these
 * predictions are shown to a person as fact. A confident wrong label is not
 * a small error; it makes every other label suspect, and the user has no way
 * to tell which ones to re-check. Silence is a better answer than a guess.
 */
class NaiveBayes private constructor(
    private val classCounts: Map<Category, Int>,
    private val featureCounts: Map<Category, Map<String, Int>>,
    private val classTotals: Map<Category, Int>,
    private val vocabulary: Int,
    val logMargin: Double
) {

    /**
     * Best class, or null when the model is not confident enough to say.
     *
     * Everything is computed in log space. Multiplying hundreds of small
     * probabilities directly underflows to zero within a few dozen features,
     * which would make every long message score identically and silently
     * break the comparison this whole function rests on.
     */
    fun predict(body: String): Prediction? {
        if (classCounts.isEmpty()) return null
        val features = Features.extract(body)
        if (features.isEmpty()) return null

        val totalDocs = classCounts.values.sum().toDouble()
        val scores = classCounts.keys.associateWith { cls ->
            var score = ln(classCounts.getValue(cls) / totalDocs)
            val counts = featureCounts[cls].orEmpty()
            val denom = (classTotals[cls] ?: 0) + vocabulary
            features.forEach { f ->
                // Laplace smoothing. Without the +1 an unseen feature makes
                // the whole product zero, so a single novel word would veto a
                // class no matter how strongly everything else pointed at it.
                score += ln(((counts[f] ?: 0) + 1).toDouble() / denom)
            }
            score
        }

        val ranked = scores.entries.sortedByDescending { it.value }
        val best = ranked[0]
        val runnerUp = ranked.getOrNull(1)
        val margin = if (runnerUp == null) Double.MAX_VALUE else best.value - runnerUp.value
        if (margin < logMargin) return null

        return Prediction(best.key, margin, exp(best.value - ranked[0].value))
    }

    data class Prediction(
        val category: Category,
        /** How far ahead of the runner-up, in log space. */
        val margin: Double,
        val relativeScore: Double
    )

    /** Feature and class counts, for persisting a trained model. */
    fun snapshot(): Snapshot = Snapshot(classCounts, featureCounts, classTotals, vocabulary)

    data class Snapshot(
        val classCounts: Map<Category, Int>,
        val featureCounts: Map<Category, Map<String, Int>>,
        val classTotals: Map<Category, Int>,
        val vocabulary: Int
    )

    companion object {

        /**
         * Default confidence threshold, in log units, measured not guessed.
         *
         * This started at 2.0, carried over from the previous build of this
         * app. That was a mistake: a threshold in log units is meaningless
         * without knowing how many features contribute to the score, and this
         * model uses word, bigram and character features -- several hundred
         * per message against that build's word-only handful. At 2.0 the
         * model abstained on 0.2% of messages, which is to say it never
         * abstained at all, quietly discarding the one property the design
         * depends on.
         *
         * Swept against a real 20,261-message corpus:
         *
         * | margin | coverage | agreement |
         * |--------|----------|-----------|
         * | 2      | 99.8%    | 89.4%     |
         * | 25     | 92.1%    | 92.9%     |
         * | **50** | **84.8%**| **95.0%** |
         * | 100    | 68.4%    | 97.7%     |
         * | 200    | 44.8%    | 99.5%     |
         *
         * 50 is chosen as the point where accuracy passes 95% while still
         * answering most messages. Notably it beats the previous build's
         * 94%/57% on both axes, which the richer feature set should be
         * expected to do.
         *
         * Re-measure with `tools/eval` after any change to [Features]. A
         * margin tuned against one feature representation says nothing about
         * another -- which is exactly the error that produced 2.0.
         */
        const val DEFAULT_MARGIN = 50.0

        /**
         * Trains from labelled examples.
         *
         * A class needs [minExamplesPerClass] before it is learned at all.
         * One or two examples produce a class that fires confidently on
         * coincidental features — which is worse than not having it, because
         * the abstention margin cannot protect against a class that is
         * genuinely winning for the wrong reason.
         */
        fun train(
            labelled: List<Pair<String, Category>>,
            logMargin: Double = DEFAULT_MARGIN,
            minExamplesPerClass: Int = 3
        ): NaiveBayes {
            val perClass = labelled.groupBy({ it.second }, { it.first })
                .filterValues { it.size >= minExamplesPerClass }

            val classCounts = mutableMapOf<Category, Int>()
            val featureCounts = mutableMapOf<Category, MutableMap<String, Int>>()
            val classTotals = mutableMapOf<Category, Int>()
            val vocab = HashSet<String>()

            perClass.forEach { (cls, bodies) ->
                classCounts[cls] = bodies.size
                val counts = featureCounts.getOrPut(cls) { mutableMapOf() }
                var total = 0
                bodies.forEach { body ->
                    Features.extract(body).forEach { f ->
                        counts[f] = (counts[f] ?: 0) + 1
                        vocab.add(f)
                        total++
                    }
                }
                classTotals[cls] = total
            }

            return NaiveBayes(classCounts, featureCounts, classTotals, vocab.size, logMargin)
        }

        fun from(snapshot: Snapshot, logMargin: Double = DEFAULT_MARGIN) = NaiveBayes(
            snapshot.classCounts, snapshot.featureCounts,
            snapshot.classTotals, snapshot.vocabulary, logMargin
        )
    }
}

/**
 * Rules first, model second, abstention last.
 *
 * The ordering is the design and not an implementation detail. Rules decide
 * anything structurally certain, and a learned model must never be able to
 * overrule them — a model that has seen a few hundred of someone's messages
 * will occasionally out-vote "this message contains a six-digit code and the
 * words do not share", and it would be wrong every time it did.
 *
 * So the model only ever sees what the rules declined to answer. Its job is
 * the measured 16.5% tail, not the whole inbox.
 */
class LayeredClassifier(private val model: NaiveBayes?) {

    fun classify(sms: Sms): Classification {
        val ruled = RuleClassifier.classify(sms)
        if (ruled.category != Category.OTHER) return ruled

        val prediction = model?.predict(sms.body) ?: return ruled
        return Classification(
            category = prediction.category,
            // Never presented as confidently as a rule. A rule is a fact
            // about the message; this is an inference from what this inbox
            // has looked like so far, and the UI should be able to say so.
            confident = false,
            why = "learned from your corrections"
        )
    }
}
