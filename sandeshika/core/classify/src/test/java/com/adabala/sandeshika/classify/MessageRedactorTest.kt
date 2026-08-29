package com.adabala.sandeshika.classify

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Redaction is a privacy boundary, so it is tested like one.
 *
 * The assertions are in two halves and both matter. One half proves values
 * are gone; the other proves shape survives, because a redactor that returns
 * "<REDACTED>" for everything is perfectly private and completely useless for
 * the tuning this exists to enable.
 *
 * Two real bugs are pinned here. A payee name -- "To DHANDE PARVATI" from an
 * actual UPI message -- once passed straight through, because the tests only
 * checked that digits were removed. And the fix for that over-corrected,
 * shredding ordinary marketing copy into "<NAME>", because a case-insensitive
 * flag on the whole pattern stopped [A-Z][a-z]+ meaning title case at all.
 */
class MessageRedactorTest {

    private fun r(s: String) = MessageRedactor.redactBody(s)

    @Test
    fun `removes every value while preserving parseable shape`() {

    // --- the real messages from the screenshots ---
    val hdfc = "Sent Rs.60.00\nFrom HDFC Bank A/C *5261\nTo DHANDE PARVATI\nOn 26/08/26"
    val bal  = "UPDATE:Bal in HDFC Bank A/c XX5261 has gone below minimum limit of INR 5,000.00.Yesterday's bal:INR 1,258.27"
    val bata = "Dear Bata Member, Thank you for Shopping with us! Get Rs. 250 OFF on Rs. 2000 shopping till 07 June at store. TnC"

    // --- THE critical property: no original value may survive ---
    val secrets = listOf("60.00","5261","26/08/26","5,000.00","1,258.27","250","2000","DHANDE")
    val allRedacted = listOf(r(hdfc), r(bal), r(bata)).joinToString(" ")
    secrets.forEach { sec ->
        assertTrue("value '$sec' does not survive redaction", !allRedacted.contains(sec))
    }
    assertTrue("payee name does not survive", !allRedacted.contains("DHANDE") && !allRedacted.contains("PARVATI"))
    assertTrue("title-case payee name does not survive",
        !r("Sent Rs.60 To Dhande Parvati on 26/08/26").contains("Dhande"))
    assertTrue("UPI VPA does not survive", !r("paid to ramesh@okhdfcbank").contains("ramesh"))
    assertTrue("single all-caps tokens are kept", r("HDFC Bank OTP alert").contains("HDFC"))
    assertTrue("ordinary marketing copy is not redacted as a name",
        r("Thank you for Shopping with us!").contains("Shopping with us"))
    assertTrue("bank name after From is kept", r("From HDFC Bank A/C *5261").contains("HDFC Bank"))

    // --- shape is preserved where the parser cares ---
    assertTrue("Rs. vs Rs space distinction kept",
        r("Rs.5000 debited") == "Rs.<N4> debited" && r("Rs 5000 debited") == "Rs <N4> debited")
    assertTrue("digit count preserved", r("Rs.5000 x") .contains("<N4>"))
    assertTrue("decimal marker preserved", r("Rs.60.00 x").contains("<N2.DD>"))
    assertTrue("INR form preserved", r("INR 1,25,000 credited").contains("INR <N6>"))
    assertTrue("account mask form distinguished",
        r("A/c XX5261").contains("<ACCTX>") && r("A/C *5261").contains("<ACCT*>"))
    assertTrue("url removed", r("Chat on hdfcbk.io/k/DUvfE8hRogl now") == "Chat on <URL> now")
    assertTrue("phone removed", r("call 9876543210 now") == "call <PHONE> now")
    assertTrue("10-digit not mistaken for amount", !r("call 9876543210").contains("<N10>"))

    // --- dedup: the Bata messages differ only in values ---
    val b1 = Sms("AD-BATAIn-S","Dear Bata Member, Get Rs. 250 OFF on Rs. 2000 shopping till 07 June at store. TnC")
    val b2 = Sms("AD-BATAIn-S","Dear Bata Member, Get Rs. 200 OFF on Rs. 1000 shopping till 02 June at store. TnC")
    assertTrue("near-identical offers collapse to one template", r(b1.body) == r(b2.body))

    // --- newline vs space must not create two templates ---
    assertTrue("whitespace normalised", r("a\nb") == r("a b"))

    // --- personal senders never appear ---
    assertTrue("personal sender replaced", MessageRedactor.redactSender("+919876543210")=="<PERSON>")
    assertTrue("business header kept", MessageRedactor.redactSender("AD-BATAIn-S")=="AD-BATAIn-S")

    // --- personal and OTP bodies are excluded entirely ---
    val msgs = listOf(
        "" to Sms("+919876543210","Hey are we still on for dinner?"),
        "" to Sms("VM-HDFCBK","123456 is your OTP. Do not share."),
        "" to Sms("AD-NEWCO","Some unrecognised message here")
    )
    val tpl = MessageRedactor.templates(msgs)
    assertTrue("personal body excluded", tpl.none { it.shape.contains("dinner") })
    assertTrue("otp body excluded", tpl.none { it.shape.contains("OTP") })
    assertTrue("uncategorised included", tpl.any { it.shape.contains("unrecognised") })
    }

    /**
     * The device-only inputs: address-book names and user-supplied terms.
     *
     * Contact names are the strongest redaction signal available and the
     * reason this is not purely pattern-based. No regex can tell "Dear
     * Ramesh" from "Dear Customer", but an exact list of the people someone
     * knows can -- so both cases are pinned here, along with the structured
     * identifiers (PAN, Aadhaar, card, vehicle) that are unambiguous enough
     * to match on shape alone.
     */
    @Test
    fun `uses contacts and custom terms, and escapes CSV correctly`() {
        val ctx = MessageRedactor.RedactionContext(
            contactNames = setOf("Ramesh Kumar", "Priya", "Dhande Parvati"),
            customTerms = setOf("ACME Corp")
        )
        fun r(s: String) = MessageRedactor.redactBody(s, ctx)
        fun rp(s: String) = MessageRedactor.redactBody(s)

    // contact-book names, the strongest signal
    assertTrue("full contact name removed", !r("Sent Rs.60 to Ramesh Kumar").contains("Ramesh"))
    assertTrue("partial contact name removed", !r("Call Priya about it").contains("Priya"))
    assertTrue("case-insensitive contact match", !r("sent to RAMESH KUMAR").contains("RAMESH"))
    assertTrue("longest-first avoids stray remnant", !r("To Ramesh Kumar now").contains("Kumar"))
    // user-added terms
    assertTrue("custom term removed", !r("Invoice from ACME Corp").contains("ACME"))
    // structured PII
    assertTrue("email", rp("mail me at foo.bar@gmail.com ok").contains("<EMAIL>"))
    assertTrue("PAN", rp("PAN ABCDE1234F linked").contains("<PAN>"))
    assertTrue("card", rp("card 4111 1111 1111 1111 used").contains("<CARD>"))
    assertTrue("aadhaar", rp("Aadhaar 1234 5678 9012 verified").contains("<AADHAAR>"))
    assertTrue("vehicle", rp("Vehicle MH12AB1234 challan").contains("<VEHICLE>"))
    // salutation names vs generic salutations
    assertTrue("Dear Ramesh redacted", rp("Dear Ramesh, your bill is ready").contains("<NAME>"))
    assertTrue("Dear Customer kept", rp("Dear Customer, your bill is ready").contains("Customer"))
    assertTrue("Dear Parent kept", rp("Dear Parent, your ward attended").contains("Parent"))
    // no regressions on shape
    assertTrue("amount shape kept", rp("Rs.5000 debited")=="Rs.<N4> debited")
    assertTrue("marketing copy kept", rp("Thank you for Shopping with us!").contains("Shopping with us"))
    assertTrue("bank name kept", rp("From HDFC Bank A/C *5261").contains("HDFC Bank"))
    // CSV correctness: shapes contain commas and quotes
    val tpls = listOf(MessageRedactor.Template("AD-X", "a,b \"q\" c", 3, Category.OTHER))
    val csv = MessageRedactor.renderCsv(tpls)
    assertTrue("csv header", csv.startsWith("count,sender,category,shape"))
    assertTrue("csv quotes escaped", csv.contains("\"a,b \"\"q\"\" c\""))
    assertTrue("csv has no raw newline in field", csv.trim().split("\n").size==2)
    }
}
