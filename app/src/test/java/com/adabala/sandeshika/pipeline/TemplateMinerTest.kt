package com.adabala.sandeshika.pipeline

import org.junit.Assert.*
import org.junit.Test

/**
 * These cases encode the two bugs the miner was built to fix. Both were found
 * by running a real corpus, not by reasoning about it, and both failed
 * silently -- which is why they are pinned here.
 */
class TemplateMinerTest {

    private val hdfcDebits = listOf(
        "Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to TSSPDCL. Avl Bal Rs.48,221.19. Not you? Call 18002586161",
        "Rs.2,340.00 debited from A/c XX4471 on 07-Aug-26 to BIGBASKET. Avl Bal Rs.45,881.19. Not you? Call 18002586161",
        "Rs.899.00 debited from A/c XX4471 on 08-Aug-26 to SWIGGY. Avl Bal Rs.44,982.19. Not you? Call 18002586161",
        "Rs.150.00 debited from A/c XX9911 on 08-Aug-26 to UBER INDIA. Avl Bal Rs.12,000.00. Not you? Call 18002586161",
        "Rs.4,100.00 debited from A/c XX4471 on 09-Aug-26 to RELIANCE SMART POINT HYDERABAD. Avl Bal Rs.8,900.00. Not you? Call 18002586161"
    )

    @Test fun `same template with different merchants collapses to one`() {
        // BUG 1: masking only structural slots left the merchant unmasked, so
        // every merchant produced a different fingerprint for one bank template.
        val m = TemplateMiner()
        hdfcDebits.forEach { m.add("HDFCBK", it) }
        val debit = m.all().filter { it.skeleton.contains("DEBITED") }
        assertEquals("all five debits are one template", 1, debit.size)
        assertEquals(5, debit.first().count)
    }

    @Test fun `variable-length merchant names do not fragment the template`() {
        // BUG 2: clustering on token count split "TO SWIGGY" from
        // "TO UBER INDIA" and again from "TO RELIANCE SMART POINT HYDERABAD".
        val m = TemplateMiner()
        hdfcDebits.forEach { m.add("HDFCBK", it) }
        val debit = m.all().first { it.skeleton.contains("DEBITED") }
        assertEquals("exactly one merchant slot", 1, debit.slots.size)
    }

    @Test fun `merchant slot is discovered from data with no stoplist`() {
        val m = TemplateMiner()
        m.add("HDFCBK", hdfcDebits[0])
        val before = m.all().first()
        assertTrue("first sighting has no slot yet", before.slots.isEmpty())

        m.add("HDFCBK", hdfcDebits[1])
        val after = m.all().first()
        assertTrue("second sighting reveals the slot", after.slots.isNotEmpty())
        assertTrue(after.skeleton.contains(TemplateMiner.VAR))
    }

    @Test fun `genuinely different templates stay separate`() {
        val m = TemplateMiner()
        hdfcDebits.forEach { m.add("HDFCBK", it) }
        m.add("HDFCBK", "Your HDFC Bank Credit Card ending 9012 statement is generated. Total Due Rs.24,900.00 by 18/08/2026")
        assertEquals("a statement is not a debit", 2, m.all().size)
    }

    @Test fun `different senders never share a template`() {
        val m = TemplateMiner()
        m.add("HDFCBK", hdfcDebits[0])
        m.add("ICICIB", hdfcDebits[0])
        assertEquals(2, m.all().size)
    }

    @Test fun `status transitions from NEW to REFINED to MATCHED`() {
        val m = TemplateMiner()
        assertEquals(TemplateMiner.Status.NEW, m.add("HDFCBK", hdfcDebits[0]).status)
        assertEquals(TemplateMiner.Status.REFINED, m.add("HDFCBK", hdfcDebits[1]).status)
        assertEquals(TemplateMiner.Status.MATCHED, m.add("HDFCBK", hdfcDebits[2]).status)
    }

    @Test fun `restore rebuilds learned templates on cold start`() {
        val warm = TemplateMiner()
        hdfcDebits.forEach { warm.add("HDFCBK", it) }
        val learned = warm.all().first { it.skeleton.contains("DEBITED") }

        val cold = TemplateMiner()
        cold.restore("HDFCBK", learned.tokens, learned.count)
        val r = cold.add("HDFCBK", "Rs.75.00 debited from A/c XX4471 on 10-Aug-26 to ZEPTO. Avl Bal Rs.8,825.00. Not you? Call 18002586161")
        assertEquals("a restarted app must not re-learn what it knows",
            TemplateMiner.Status.MATCHED, r.status)
        assertEquals(learned.fp, r.template.fp)
    }
}
