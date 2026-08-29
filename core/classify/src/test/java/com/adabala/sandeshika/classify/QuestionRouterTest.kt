package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * Question routing, and the boundary that keeps answers trustworthy.
 *
 * The assertions that matter most are the ones proving arithmetic never
 * reaches a model: a spending question returns a computed plan, with the sum
 * produced by code. A model asked to add two hundred rupee figures will
 * occasionally get one wrong and there is no way to tell which time, so a
 * total it produced could not be relied on for anything.
 *
 * The prompt assertions matter for the opposite reason. A model asked about a
 * bill will invent a plausible due date if not told otherwise, and a
 * confident wrong date is worse than "I could not find that" because someone
 * will act on it.
 */
class QuestionRouterTest {

    private fun daysAgo(n: Int): Long {
        val c = Calendar.getInstance(); c.add(Calendar.DAY_OF_YEAR, -n); return c.timeInMillis
    }

    private fun m(b: String, at: Long, cat: Category = Category.TRANSACTION) =
        Sms("VM-HDFCBK", b, at) to Classification(cat, true, "x")

    @Test
    fun `computes totals itself and sends only content questions to a model`() {

    val msgs = listOf(
        m("Rs 500 debited at CAFE", daysAgo(2)),
        m("Rs 300 debited at STORE", daysAgo(3)),
        m("Rs 2000 credited to your account", daysAgo(4)),
        m("Rs 9999 debited at OLD", daysAgo(200)),
        m("Your statement is ready", daysAgo(1)),
        m("Airtel: your plan benefits have changed, 2GB per day now", daysAgo(5), Category.SERVICE)
    )

    // arithmetic must be computed, never sent to a model
    val p1 = QuestionRouter.plan("how much did I spend this week?", msgs)
    assertTrue("spend question is computed", p1 is QuestionRouter.Plan.Computed)
    assertTrue("sums only the week's debits", (p1 as QuestionRouter.Plan.Computed).answer.contains("₹800"))
    assertTrue("answer names the period", p1.answer.contains("last week"))
    assertTrue("answer states transaction count", p1.answer.contains("2 transactions"))

    val p2 = QuestionRouter.plan("total received this week", msgs)
    assertTrue("income question is computed", p2 is QuestionRouter.Plan.Computed)
    assertTrue("credits summed", (p2 as QuestionRouter.Plan.Computed).answer.contains("₹2,000"))

    // no period stated means everything, not a silent assumption
    val p3 = QuestionRouter.plan("how much have I spent", msgs) as QuestionRouter.Plan.Computed
    assertTrue("absent period means all time", p3.answer.contains("in total"))
    assertTrue("all-time total includes the old txn", p3.answer.contains("₹10,799"))

    // content questions go to the model with local context
    val p4 = QuestionRouter.plan("what did airtel say about my plan?", msgs)
    assertTrue("content question asks the model", p4 is QuestionRouter.Plan.AskModel)
    assertTrue("context contains the airtel message",
        (p4 as QuestionRouter.Plan.AskModel).context.any{it.body.contains("Airtel")})
    assertTrue("context is small", p4.context.size <= 8)

    // nothing relevant: say so rather than invent
    val p5 = QuestionRouter.plan("what about my helicopter lease", msgs)
    assertTrue("irrelevant question finds nothing", p5 is QuestionRouter.Plan.NothingFound)
    assertTrue("blank question handled", QuestionRouter.plan("   ", msgs) is QuestionRouter.Plan.NothingFound)

    // no spending in range: say so, do not report zero as a total
    val p6 = QuestionRouter.plan("how much did I spend today?", msgs)
    assertTrue("no data in range reports nothing found", p6 is QuestionRouter.Plan.NothingFound)

    // the prompt must constrain the model
    val prompt = QuestionRouter.buildPrompt("when is my bill due", listOf(Sms("A","bill due 5th",0)))
    assertTrue("prompt forbids invention", prompt.contains("only the SMS messages"))
    assertTrue("prompt forbids arithmetic", prompt.contains("Do not calculate totals"))
    assertTrue("prompt includes context", prompt.contains("bill due 5th"))
    assertTrue("prompt includes the question", prompt.contains("when is my bill due"))
    }
}
