package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * Due dates, and the two ways reading them goes quietly wrong.
 *
 * **The year is usually missing.** "due 28-Dec" seen in January must not
 * resolve to a date eleven months away, and seen in December must not
 * resolve to last year. A bill that lapsed recently stays visible, because a
 * missed payment is exactly what someone needs to see.
 *
 * **Indian dates are day-first.** Reading 05/09 as 9 May rather than
 * 5 September moves a deadline by months, and the ambiguity is invisible for
 * any day under 13 — so it would look correct in most testing.
 */
class DueDateParserTest {

    private fun at(y: Int, m: Int, d: Int): Long {
        val c = Calendar.getInstance(); c.set(y, m, d, 12, 0, 0)
        c.set(Calendar.MILLISECOND, 0); return c.timeInMillis
    }

    private fun p(b: String, now: Long = at(2026, 5, 10)) =
        DueDateParser.parse(Sms("VM-X", b), now)

    @Test
    fun `reads what is owed and by when, without guessing the year wrong`() {

    val now = at(2026,5,10)  // 10 June 2026

    // amount + explicit date
    val d1=p("Total amount due Rs 12,340 by 18-Jun")
    assertTrue("amount read", d1?.amount==12340.0)
    assertTrue("date read", d1?.dueAt!=null)
    assertTrue("days computed", d1?.daysFrom(now)==8)

    // day-first, the Indian convention
    val d2=p("Pay by 05/09 to avoid disconnection. Rs 900 outstanding")
    assertTrue("05/09 is 5 September, not 9 May", d2?.daysFrom(now)!! > 80)

    // year omitted near a boundary must not read as overdue by a year
    val dec=p("Bill due 28-Dec", at(2026,11,20))
    assertTrue("December bill in December resolves to this year", dec?.daysFrom(at(2026,11,20))==8)
    val jan=p("Bill due 28-Dec", at(2027,0,5))
    assertTrue("recently lapsed bill stays visible, not flung a year out",
        jan?.daysFrom(at(2027,0,5))!! in -20..0)

    // must not treat settled payments as dues
    assertTrue("payment confirmation is not a due",
        DueDateParser.parse(Sms("VM-X","Rs 500 debited towards your bill payment"))==null)
    assertTrue("plain transaction is not a due",
        DueDateParser.parse(Sms("VM-X","Rs 500 debited at STORE on 01/01/26"))==null)

    // amount-only and date-only both usable
    assertTrue("amount without date still returned", p("Outstanding Rs 450")?.amount==450.0)
    assertTrue("date without amount still returned", p("Payment due on 18-Jun")?.dueAt!=null)
    assertTrue("neither means nothing", DueDateParser.parse(Sms("VM-X","hello"))==null)

    // upcoming list
    val bills=listOf(
        Sms("VM-AIRTEL","Bill due 15-Jun Rs 599", now) to Classification(Category.BILL,true,"x"),
        Sms("VM-AIRTEL","Reminder: bill due 15-Jun Rs 599", now+1000) to Classification(Category.BILL,true,"x"),
        Sms("VM-POWER","Total amount due Rs 2400 by 12-Jun", now) to Classification(Category.BILL,true,"x"),
        Sms("VM-X","Rs 5 debited", now) to Classification(Category.TRANSACTION,true,"x")
    )
    val up=DueDateParser.upcoming(bills, now)
    assertTrue("repeat reminders deduplicated by sender", up.size==2)
    assertTrue("soonest first", up.first().dueAt!! < up.last().dueAt!!)
    assertTrue("non-bills excluded", up.none{ it.amount==5.0 })
    }
}
