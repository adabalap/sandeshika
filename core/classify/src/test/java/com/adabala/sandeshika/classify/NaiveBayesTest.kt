package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Feature extraction and the learned layer.
 *
 * Learning and abstention are asserted separately and deliberately. At the
 * production margin a six-example model refuses to answer anything at all --
 * correctly, since a model that confident on that little data would be
 * guessing -- so testing "did it learn" against that margin would only be
 * re-testing the abstention policy. The learning tests therefore pass an
 * explicit margin of 0.0, and abstention gets its own assertions at the real
 * default.
 */
class NaiveBayesTest {

    @Test
    fun `extracts useful features, learns, and knows when to stay quiet`() {

    // --- tokenizer keeps the shapes that carry signal ---
    val tk = Features.tokens("Rs.5000 debited from a/c XX1234 on 04-Jun")
    assertTrue("money collapsed to a symbol", tk.contains("<money>"))
    assertTrue("a/c kept as one token", tk.contains("<acct>"))
    assertTrue("masked account collapsed", tk.contains("<acctno>"))
    assertTrue("date collapsed", tk.contains("<date>"))
    assertTrue("no raw digits survive", tk.none { it.any(Char::isDigit) })
    assertTrue("specific amount does not leak into features",
        Features.tokens("Rs.500 spent") == Features.tokens("Rs.99999 spent"))

    // --- feature kinds present ---
    val fe = Features.extract("Rs.500 debited")
    assertTrue("has word features", fe.any { it.startsWith("w:") })
    assertTrue("has bigram features", fe.any { it.startsWith("b:") })
    assertTrue("has char features", fe.any { it.startsWith("c:") })
    assertTrue("char ngrams bridge spelling variants",
        Features.extract("debited").filter{it.startsWith("c:")}
            .intersect(Features.extract("debitd").filter{it.startsWith("c:")}.toSet()).size >= 3)

    // --- training and abstention ---
    val train = listOf(
        "Your parcel is out for delivery today" to Category.DELIVERY,
        "Order shipped, arriving tomorrow" to Category.DELIVERY,
        "Package dispatched from warehouse" to Category.DELIVERY,
        "Flight AI302 departs at 6pm from gate 4" to Category.TRAVEL,
        "Your PNR is confirmed, coach B4" to Category.TRAVEL,
        "Train running late by 2 hours" to Category.TRAVEL
    )
    // Learning and abstention are separate behaviours and are tested
    // separately. With the production margin a six-example model correctly
    // refuses to answer anything -- so testing "does it learn" against that
    // margin measures the abstention policy, not the learning.
    val learn = NaiveBayes.train(train, logMargin = 0.0)
    assertTrue("learns delivery", learn.predict("Your order has been dispatched")?.category == Category.DELIVERY)
    assertTrue("learns travel", learn.predict("PNR confirmed for your train")?.category == Category.TRAVEL)

    // With the real margin, a model this thin must stay quiet. This is the
    // property that protects a new user on day one, before enough
    // corrections exist to learn anything trustworthy.
    val m = NaiveBayes.train(train)
    assertTrue("a six-example model abstains at the production margin",
        m.predict("Your order has been dispatched") == null)
    assertTrue("abstains on unrelated text", m.predict("zzz qqq vvv") == null)

    // A class with too few examples is not learned at all.
    val thin = NaiveBayes.train(train + listOf("weird one off" to Category.SPAM), logMargin = 0.0)
    assertTrue("class below the example floor is dropped",
        thin.predict("weird one off")?.category != Category.SPAM)

    // --- rules always win over the model ---
    val layered = LayeredClassifier(NaiveBayes.train(
        List(5){ "some random promo text $it" to Category.PROMOTION }, logMargin = 0.0
    ))
    val otp = layered.classify(Sms("VM-HDFCBK","123456 is your OTP. Do not share."))
    assertTrue("rule beats model", otp.category == Category.OTP)
    assertTrue("rule keeps its own reason", otp.why.contains("OTP"))
    val fell = layered.classify(Sms("VM-X","some random promo text 99"))
    assertTrue("model handles what rules abstain on", fell.category == Category.PROMOTION)
    assertTrue("model result is marked not-confident", !fell.confident)

    // --- empty model is harmless ---
    assertTrue("untrained model abstains", NaiveBayes.train(emptyList()).predict("anything") == null)
    assertTrue("null model falls through to rules",
        LayeredClassifier(null).classify(Sms("VM-X","Rs 50 debited")).category == Category.TRANSACTION)
    }
}
