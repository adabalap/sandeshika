package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Money parsing, tested against the failures that corrupt a total silently.

 * The balance trap is the one that matters most: "Rs 500 debited. Avl bal:
 * Rs 2,000" contains two figures and taking the wrong one inflates a month
 * by an arbitrary amount, with nothing on screen to indicate it happened.
 * Self-transfers are here for the same reason -- counting one as spending
 * inflated a daily figure from Rs 8,478 to Rs 13,478 in an earlier build.
 */
class TransactionParserTest {

    private fun p(b: String) = TransactionParser.parse(Sms("VM-HDFCBK", b))

    @Test
    fun `reads the amount and direction that a spending total depends on`() {

    // THE trap: the balance must never be read as the amount
    val bal=p("Rs 500.00 debited from A/c XX1234. Avl bal: Rs 2,000.00")
    assertTrue("amount is the transaction, not the balance", bal?.amount==500.0)
    assertTrue("direction debit", bal?.direction==TransactionParser.Direction.DEBIT)
    val bal2=p("INR 250 debited. Available Balance: INR 98,000")
    assertTrue("available balance variant ignored", bal2?.amount==250.0)
    val bal3=p("Rs 75 spent. Closing balance Rs 12,345.67")
    assertTrue("closing balance variant ignored", bal3?.amount==75.0)

    // the factor-of-ten regression
    assertTrue("Rs.5000 is five thousand", p("Rs.5000 debited")?.amount==5000.0)
    assertTrue("Rs 5,000.50 keeps decimals", p("Rs 5,000.50 debited")?.amount==5000.50)
    assertTrue("lakh formatting", p("INR 1,25,000 credited")?.amount==125000.0)
    assertTrue("rupee symbol", p("₹499 debited")?.amount==499.0)

    // direction
    assertTrue("credit detected", p("Rs 100 credited to your account")?.direction==TransactionParser.Direction.CREDIT)
    assertTrue("ambiguous direction refused", p("Rs 100 debited and Rs 50 credited")==null)
    assertTrue("no amount means no transaction", p("Your statement is ready")==null)
    assertTrue("no verb means no transaction", p("Rs 500 is your limit")==null)

    // spending semantics
    assertTrue("plain debit is a spend", p("Rs 300 debited at STORE")?.isSpend==true)
    assertTrue("credit is not a spend", p("Rs 300 credited")?.isSpend==false)
    val self=p("Rs 5000 transferred to your own account")
    assertTrue("self transfer detected", self?.selfTransfer==true)
    assertTrue("self transfer is not a spend", self?.isSpend==false)
    assertTrue("normal payment is not marked self transfer",
        p("Rs 60 sent to RAMESH KUMAR")?.selfTransfer==false)

    // counterparty
    assertTrue("payee extracted", p("Sent Rs.60.00 to DHANDE PARVATI on 26/08/26")?.counterparty?.contains("DHANDE")==true)
    assertTrue("merchant extracted", p("Rs 250 spent at CROMA on 01/01/25")?.counterparty?.contains("CROMA")==true)
    }
}
