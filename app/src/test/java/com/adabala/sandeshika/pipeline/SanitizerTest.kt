package com.adabala.sandeshika.pipeline

import org.junit.Assert.*
import org.junit.Test

/**
 * The golden corpus. `:pipeline` has no Android dependencies, so this runs as
 * a plain JVM test in milliseconds -- which is what makes it realistic to run
 * on every pattern change rather than occasionally on a device.
 *
 * Grow this file as real senders appear. A correction from the review queue
 * should land here as a case before it lands in the template bank as a fix.
 */
class SanitizerTest {

    // ── DLT header normalisation ──────────────────────────────────────

    @Test fun `strips telco prefix and category suffix`() {
        val s = Sanitizer.sender("AD-HDFCBK-S")
        assertEquals("HDFCBK", s.norm)
        assertEquals("S", s.category)
        assertEquals(Sanitizer.SenderKind.INSTITUTION, s.kind)
    }

    @Test fun `handles header with no category`() {
        assertEquals("TSSPDC", Sanitizer.sender("VM-TSSPDC").norm)
    }

    @Test fun `does not eat leading letters of an unprefixed header`() {
        // The optional prefix group requires a separator, so ADANI keeps its AD.
        assertEquals("ADANI", Sanitizer.sender("ADANI").norm)
    }

    @Test fun `phone numbers are people, not institutions`() {
        assertEquals(Sanitizer.SenderKind.PERSON, Sanitizer.sender("+919876543210").kind)
    }

    // ── Amounts: the highest-consequence parser in the app ────────────

    @Test fun `parses Indian lakh grouping`() {
        // The naive [\d,]+ reads this as 1.23 -- silently, with no error.
        assertEquals(listOf(123456.78), Sanitizer.amounts("INR 1,23,456.78 credited"))
    }

    @Test fun `parses plain thousands grouping`() {
        assertEquals(listOf(2340.0), Sanitizer.amounts("Rs.2,340.00 debited"))
    }

    @Test fun `parses ungrouped amounts`() {
        assertEquals(listOf(1299.0), Sanitizer.amounts("spent Rs 1299 at AMAZON"))
    }

    @Test fun `applies lakh and crore multipliers`() {
        assertEquals(listOf(250_000.0), Sanitizer.amounts("Payment of Rs 2.5 Lakh received"))
        assertEquals(listOf(12_000_000.0), Sanitizer.amounts("Loan sanctioned Rs 1.2 Cr"))
    }

    @Test fun `extracts every amount in order including balance`() {
        assertEquals(
            listOf(2340.0, 48221.19),
            Sanitizer.amounts("Rs.2,340.00 debited from A/c XX4471. Avl Bal Rs.48,221.19")
        )
    }

    @Test fun `bare numbers without a currency marker are not amounts`() {
        assertTrue(Sanitizer.amounts("FLAT 60% OFF! Use code EAT60").isEmpty())
    }

    // ── Accounts ──────────────────────────────────────────────────────

    @Test fun `extracts masked account tail`() {
        assertEquals(listOf("4471"), Sanitizer.accounts("debited from A/c XX4471 on 05-Aug-26"))
    }

    @Test fun `extracts ending-form card tail`() {
        assertEquals(listOf("9012"), Sanitizer.accounts("Credit Card ending 9012 at AMAZON"))
    }

    @Test fun `consumer number is not an account`() {
        assertTrue(Sanitizer.accounts("electricity bill for consumer no 1234567").isEmpty())
    }

    // ── OTP gate: a privacy invariant, not a feature ──────────────────

    @Test fun `detects auth otp and its do-not-share confirmer`() {
        val otp = Sanitizer.otp("OTP for your transaction of Rs.4,999 is 483920. Do not share this OTP.")
        assertNotNull(otp)
        assertEquals(Sanitizer.Otp.Kind.AUTH, otp!!.kind)
        assertEquals(6, otp.digits)
        assertTrue(otp.confirmed)
    }

    @Test fun `delivery otp is classified separately and stays useful`() {
        val otp = Sanitizer.otp("Your Amazon delivery OTP is 4821. Share with the delivery agent.")
        assertEquals(Sanitizer.Otp.Kind.DELIVERY, otp?.kind)
    }

    @Test fun `otp marker without a code is not an otp`() {
        // Security notices carry the word but no value; treating them as OTPs
        // would purge legitimate bank advisories.
        assertNull(Sanitizer.otp("Bank staff will never ask for your OTP or PIN."))
    }

    @Test fun `ordinary transaction is not an otp`() {
        assertNull(Sanitizer.otp("Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to TSSPDCL"))
    }

    // ── VPA vs email ──────────────────────────────────────────────────

    @Test fun `upi handle is captured`() {
        assertTrue(Sanitizer.VPA.containsMatchIn("credited to swiggy@ybl (UPI Ref no 408772934112)"))
    }

    @Test fun `email address is not a upi handle`() {
        // UPI handles have no dot in the domain; email addresses do. That one
        // fact separates them with no handle allowlist to maintain.
        assertFalse(Sanitizer.VPA.containsMatchIn("write to care@hdfcbank.com for help"))
    }

    // ── Skeleton ──────────────────────────────────────────────────────

    @Test fun `skeleton masks amount date and account`() {
        val s = Sanitizer.skeleton("Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to TSSPDCL")
        assertTrue(s.contains("<AMT>"))
        assertTrue(s.contains("<ACCT>"))
        assertTrue(s.contains("<DATE>"))
        assertFalse("no raw digits should survive", Regex("""\d""").containsMatchIn(s))
    }

    @Test fun `amounts are masked before generic digits`() {
        // Order dependency: if digits were masked first, 2,340 becomes three
        // number tokens and the skeleton varies by amount -- which would defeat
        // template matching entirely.
        val a = Sanitizer.skeleton("Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to X")
        val b = Sanitizer.skeleton("Rs.899.00 debited from A/c XX4471 on 06-Aug-26 to X")
        assertEquals(a, b)
    }

    @Test fun `content hash is stable and body-sensitive`() {
        val h1 = Sanitizer.contentHash("AD-HDFCBK", 1000L, "hello")
        val h2 = Sanitizer.contentHash("AD-HDFCBK", 1000L, "hello")
        val h3 = Sanitizer.contentHash("AD-HDFCBK", 1000L, "hello ")
        assertEquals(h1, h2)
        assertNotEquals(h1, h3)
    }
}
