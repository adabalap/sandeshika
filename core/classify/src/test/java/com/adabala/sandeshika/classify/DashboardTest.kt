package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Dashboard aggregation, including month boundaries and Indian digit
 * grouping.

 * Unparseable transactions are asserted to be *counted* rather than dropped,
 * because a total that silently omits what it could not read is a total
 * nobody can trust. Lakh grouping is asserted because western grouping on an
 * Indian amount makes a familiar figure hard to recognise at a glance.
 */
class DashboardTest {

    private fun thisMonth(): Long { val c = java.util.Calendar.getInstance(); c.set(java.util.Calendar.DAY_OF_MONTH, 5); return c.timeInMillis }
    private fun lastMonth(): Long { val c = java.util.Calendar.getInstance(); c.add(java.util.Calendar.MONTH, -2); return c.timeInMillis }
    private fun item(b: String, at: Long, cat: Category = Category.TRANSACTION) =
        Triple(Sms("VM-HDFCBK", b), Classification(cat, true, "x"), at)

    @Test
    fun `aggregates only what it can read, and says what it could not`() {

    val s = Dashboard.compute(listOf(
        item("Rs 500 debited at STORE", thisMonth()),
        item("Rs 300 debited at CAFE", thisMonth()),
        item("Rs 1000 credited to your account", thisMonth()),
        item("Rs 9999 debited at OLDSHOP", lastMonth()),          // previous month
        item("Rs 5000 transferred to your own account", thisMonth()), // self transfer
        item("Your statement is ready", thisMonth()),              // unparseable txn
        item("Bill due Rs 200", thisMonth(), Category.BILL),
        item("mystery", thisMonth(), Category.OTHER)
    ))
    assertTrue("spending sums only this month's debits", s.spentThisMonth==800.0)
    assertTrue("spend count matches", s.spendCount==2)
    assertTrue("credits tracked separately", s.receivedThisMonth==1000.0)
    assertTrue("self transfer excluded from spending", s.spentThisMonth==800.0)
    assertTrue("previous month excluded", s.spentThisMonth<9999.0)
    assertTrue("unparseable transactions counted, not silently dropped", s.unparsedTransactions==1)
    assertTrue("bills counted", s.billCount==1)
    assertTrue("uncategorised counted", s.uncategorised==1)
    assertTrue("total is every message", s.totalMessages==8)
    assertTrue("breakdown covers categories", s.byCategory.sumOf{it.second}==8)
    assertTrue("counterparties collected", s.topCounterparties.isNotEmpty())

    // Indian digit grouping
    assertTrue("hundreds", Dashboard.formatRupees(500.0)=="₹500")
    assertTrue("thousands", Dashboard.formatRupees(5000.0)=="₹5,000")
    assertTrue("lakh grouping not western", Dashboard.formatRupees(125000.0)=="₹1,25,000")
    assertTrue("crore grouping", Dashboard.formatRupees(12500000.0)=="₹1,25,00,000")
    assertTrue("zero", Dashboard.formatRupees(0.0)=="₹0")

    assertTrue("empty input is safe", Dashboard.compute(emptyList()).totalMessages==0)
    }
}
