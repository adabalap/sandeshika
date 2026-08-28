package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Rule classifier behaviour, including every adversarial case that has
 * actually bitten this project.
 *
 * The cases here are not hypotheticals. A previous build of Sandeshika shipped
 * an amount regex that read `Rs.5000` as 500 -- a silent factor-of-ten error in
 * a spending total -- and this suite pins that shape explicitly. The OTP
 * boundary cases exist because the first version of CODE_RE in this very file
 * rejected `...is 448122.` at the end of a sentence, which is how most real OTP
 * messages are written.
 *
 * Run: ./gradlew :core:classify:test
 */
class RuleClassifierTest {

    private fun cat(sender: String, body: String) =
        RuleClassifier.classify(Sms(sender, body)).category

    private fun cls(sender: String, body: String) =
        RuleClassifier.classify(Sms(sender, body))

    @Test
    fun `classifies the messages an Indian inbox actually contains`() {

    // ---- sender shape: the structural signal ----
    assertTrue("+91 mobile is personal", RuleClassifier.isPersonalSender("+919876543210"))
    assertTrue("bare 10-digit is personal", RuleClassifier.isPersonalSender("9876543210"))
    assertTrue("spaced number is personal", RuleClassifier.isPersonalSender("+91 98765 43210"))
    assertTrue("TRAI header is not personal", !RuleClassifier.isPersonalSender("VM-HDFCBK"))
    assertTrue("AX header is not personal", !RuleClassifier.isPersonalSender("AX-SBIINB"))
    assertTrue("short code is not personal", !RuleClassifier.isPersonalSender("56767"))
    assertTrue("empty is not personal", !RuleClassifier.isPersonalSender(""))

    // A friend forwarding an offer must stay PERSONAL -- keyword rules alone
    // would misfile this as PROMOTION.
    assertTrue("friend forwarding an offer stays personal",
        cat("+919876543210", "Bro check this out, 50% off sale click here!") == Category.PERSONAL)

    // ---- OTP before transaction: the double-count trap ----
    assertTrue("OTP mentioning a txn amount is OTP, not transaction",
        cat("VM-HDFCBK", "123456 is the OTP for txn of Rs.5000 at AMAZON. Do not share.") == Category.OTP)
    assertTrue("plain OTP",
        cat("AX-ICICIB", "Your verification code is 448122. Never share it.") == Category.OTP)
    // An advisory with no code is not an OTP.
    assertTrue("PIN advisory without a code is not OTP",
        cat("VM-HDFCBK", "Bank never asks for your PIN. Do not share it with anyone.") != Category.OTP)

    // ---- transactions ----
    assertTrue("debit is a transaction",
        cat("VM-HDFCBK", "Rs.5000 debited from a/c XX1234 on 04-Jun") == Category.TRANSACTION)
    assertTrue("credit is a transaction",
        cat("AX-SBIINB", "INR 1,25,000.50 credited to your account") == Category.TRANSACTION)
    assertTrue("UPI debit is a transaction",
        cat("VK-PAYTMB", "Rs 250 paid to Chai Point via UPI") == Category.TRANSACTION)
    // The regression that produced a factor-of-ten error last time.
    assertTrue("Rs.5000 without space is recognised as an amount",
        cat("VM-HDFCBK", "Rs.5000 debited from your account") == Category.TRANSACTION)
    assertTrue("no amount means not a transaction",
        cat("VM-HDFCBK", "Your account statement is ready") != Category.TRANSACTION)

    // ---- transaction before bill, but future tense goes to bill ----
    assertTrue("settled bill payment is a transaction, not a bill",
        cat("VM-HDFCBK", "Rs 500 debited towards your electricity bill payment") == Category.TRANSACTION)
    assertTrue("future debit is a bill, not a transaction",
        cat("VM-HDFCBK", "Rs 1200 will be debited on 15-Jun for your EMI") == Category.BILL)

    // ---- bills ----
    assertTrue("credit card due is a bill",
        cat("AX-ICICIB", "Total amount due Rs 12,340 by 18-Jun") == Category.BILL)
    assertTrue("recharge expiry is a bill",
        cat("VM-AIRTEL", "Your plan validity expires on 20-Jun. Recharge now.") == Category.BILL)

    // ---- travel / delivery / promo ----
    assertTrue("PNR is travel", cat("VK-IRCTCI", "PNR 4512367890 confirmed, coach B4 seat 21") == Category.TRAVEL)
    assertTrue("out for delivery", cat("VM-AMAZON", "Your order is out for delivery today") == Category.DELIVERY)
    assertTrue("sale is promotion", cat("VM-MYNTRA", "FLAT 60% off, shop now! T&C apply") == Category.PROMOTION)

    // ---- abstention is a feature ----
    val unknown = cls("VM-RANDOM", "Thank you for visiting us.")
    assertTrue("unrecognised message abstains", unknown.category == Category.OTHER)
    assertTrue("abstention is marked not-confident", !unknown.confident)

    // ---- explainability ----
    assertTrue("every classification carries a reason", cls("VM-HDFCBK", "Rs 10 debited").why.isNotBlank())


    // The fix must not have simply loosened the guard into uselessness.
    assertTrue("code at end of sentence works", cat("VM-X","Your OTP is 448122.")==Category.OTP)
    assertTrue("code mid-sentence works", cat("VM-X","OTP 123456 valid for 10 min")==Category.OTP)
    assertTrue("code in parens works", cat("VM-X","Your OTP (998877). Do not share.")==Category.OTP)
    assertTrue("code followed by comma", cat("VM-X","OTP is 445566, valid 5 min")==Category.OTP)
    // A decimal amount alone must NOT read as an OTP code.
    assertTrue("decimal amount alone is not an OTP", cat("VM-X","Rs 5000.50 debited")!=Category.OTP)
    assertTrue("decimal amount is a transaction", cat("VM-X","Rs 5000.50 debited")==Category.TRANSACTION)
    // Long account/reference numbers should not be mistaken for codes.
    assertTrue("12-digit ref is not a code", cat("VM-X","Ref 123456789012 do not share")!=Category.OTP)
    // Amount forms
    assertTrue("lakh with commas", cat("VM-X","INR 1,25,000 credited")==Category.TRANSACTION)
    assertTrue("rupee symbol", cat("VM-X","₹499 debited for subscription")==Category.TRANSACTION)
    assertTrue("Rs with no dot no space", cat("VM-X","Rs5000 debited")==Category.TRANSACTION)
    // Ambiguous direction should be flagged not-confident.
    val amb = RuleClassifier.classify(Sms("VM-X","Rs 100 debited and Rs 50 credited"))
    assertTrue("both directions flags low confidence", !amb.confident)
    }

    /**
     * Verbatim messages from a real 500-message Indian inbox, all three of
     * which the first version of this classifier filed as "uncategorised".
     *
     * They are kept exactly as received, newlines and all. Paraphrasing them
     * would lose the specific shape that caused the miss -- the HDFC UPI
     * message fails only because "Sent" and "To" are separated, which a
     * tidied-up version of the same message would not reproduce.
     */
    @Test
    fun `handles the message shapes a real inbox actually contained`() {
        assertTrue(
            "HDFC UPI debit is a transaction, not uncategorised",
            cat("JD-HDFCBK-S", "Sent Rs.60.00\nFrom HDFC Bank A/C *5261\nTo DHANDE PARVATI\nOn 26/08/26")
                == Category.TRANSACTION
        )
        assertTrue(
            "minimum-balance alert is BALANCE, not a transaction",
            cat("JM-HDFCBK-S", "UPDATE:Bal in HDFC Bank A/c XX5261 has gone below minimum limit of INR 5,000.00.Yesterday's bal:INR 1,258.27")
                == Category.BALANCE
        )
        assertTrue(
            "fake-salary work-from-home message is SPAM",
            cat("AD-BIZAFA-S", "Dear Sir/Mam Your Salary was passed, Work at home with Rs39800 has been rescheduled to you")
                == Category.SPAM
        )
        // A debit that also reports the resulting balance must stay a
        // transaction: demoting it to BALANCE would quietly empty the
        // spending view.
        assertTrue(
            "debit reporting a balance stays a transaction",
            cat("VM-HDFCBK", "Rs 500.00 debited from A/c XX1234. Avl bal: Rs 2,000.00")
                == Category.TRANSACTION
        )
        // One spam marker is not enough: a real payroll message mentions
        // salary too.
        assertTrue(
            "a single spam-ish word does not make a message spam",
            cat("VM-PAYROL", "Your salary for August has been processed.") != Category.SPAM
        )
    }

    /**
     * Scam shapes that circulate on Indian numbers.
     *
     * Added after a real 24,040-message inbox produced exactly one spam
     * classification. The first four failed on word order -- the rules held
     * contiguous phrases like "pre-approved loan" which never match "loan of
     * Rs 5,00,000 is pre-approved" -- and KYC phishing, probably the single
     * most common shape of all, was not covered at any threshold.
     */
    @Test
    fun `catches the scam shapes that actually circulate`() {
        assertTrue("lottery win", cat("AD-X", "Congratulations! You have won Rs 25,00,000 in KBC lottery.") == Category.SPAM)
        assertTrue("work from home", cat("AD-X", "Earn daily 2000-5000 from home. No investment. WhatsApp 9876543210") == Category.SPAM)
        assertTrue("pre-approved loan, reversed word order",
            cat("AD-X", "Your loan of Rs 5,00,000 is pre-approved. Click bit.ly/abc to claim.") == Category.SPAM)
        assertTrue("part time job", cat("AD-X", "Part time job available, earn upto 35000 per month.") == Category.SPAM)
        assertTrue("KYC phishing",
            cat("AD-X", "Dear customer your KYC is expired, account will be blocked. Click here to update.") == Category.SPAM)

        // Must not swallow legitimate bank messages that mention the same nouns.
        assertTrue("real KYC completion notice is not spam",
            cat("VM-HDFCBK", "Your KYC has been successfully updated. Thank you.") != Category.SPAM)
        assertTrue("real loan EMI notice is not spam",
            cat("VM-HDFCBK", "Your home loan EMI of Rs 24,500 is due on 05-Sep") != Category.SPAM)
    }
}
