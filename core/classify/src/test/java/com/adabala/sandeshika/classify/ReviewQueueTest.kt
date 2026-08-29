package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which messages are worth a person's attention, and in what order.
 *
 * The ordering rules are the substance here: rule-certain messages must never
 * be queued, higher-impact shapes come first, unknown outranks guessed, and a
 * shape the user has already answered must never reappear. Each of those is a
 * way the queue could waste someone's time, which is the only real failure
 * mode a feature like this has.
 */
class ReviewQueueTest {

    private fun row(key: String, body: String, cat: Category, conf: Boolean) =
        Triple(key, Sms("AD-X", body), Classification(cat, conf, "x"))

    @Test
    fun `ranks by how many messages a single label would fix`() {

    // 3 of shape A (unknown), 1 of shape B (unknown), 5 of C (rule-certain)
    val rows = buildList {
        repeat(3){ add(row("A","offer a $it",Category.OTHER,false)) }
        add(row("B","weird one",Category.OTHER,false))
        repeat(5){ add(row("C","Rs 5 debited $it",Category.TRANSACTION,true)) }
        repeat(2){ add(row("D","guessy $it",Category.PROMOTION,false)) }
    }
    val q = ReviewQueue.build(rows)

    assertTrue("rule-certain messages are never queued", q.none { it.shapeKey=="C" })
    assertTrue("higher-impact unknown ranks first", q.first().shapeKey=="A")
    assertTrue("impact counts messages, not shapes", q.first().impact==3)
    assertTrue("unknown outranks guessed even at lower volume",
        q.indexOfFirst{it.shapeKey=="B"} < q.indexOfFirst{it.shapeKey=="D"})
    assertTrue("unknown has no suggestion", q.first{it.shapeKey=="A"}.suggested==null)
    assertTrue("guessed carries the model's suggestion",
        q.first{it.shapeKey=="D"}.suggested==Category.PROMOTION)
    assertTrue("reach sums impact", ReviewQueue.reach(q)==3+1+2)

    // already-corrected shapes must never reappear
    val q2 = ReviewQueue.build(rows, alreadyCorrected=setOf("A"))
    assertTrue("corrected shapes are excluded", q2.none{it.shapeKey=="A"})
    assertTrue("excluding one does not drop the others", q2.size==2)

    // limit
    assertTrue("limit respected", ReviewQueue.build(rows, limit=1).size==1)
    assertTrue("empty input is safe", ReviewQueue.build(emptyList()).isEmpty())
    assertTrue("reach of empty queue is zero", ReviewQueue.reach(emptyList())==0)
    }
}
