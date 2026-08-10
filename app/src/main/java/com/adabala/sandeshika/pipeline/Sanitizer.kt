package com.adabala.sandeshika.pipeline

import java.security.MessageDigest
import java.text.Normalizer

/**
 * Turns a raw Indian SMS into normalised text, a sender identity, extracted
 * money/account/reference slots, and a template skeleton.
 *
 * Every pattern here was validated against a real corpus before being written
 * (see tools/validate_patterns.py). Two of them are load-bearing and easy to
 * get wrong:
 *
 *  - AMOUNT_BODY handles Indian lakh grouping. The obvious `[\d,]+` parses
 *    "Rs.1,23,456.78" as 1.23 and "2,340" as 2.34 — silently, with no error,
 *    producing a money app that is confidently wrong. That is the single worst
 *    failure mode this app has.
 *  - VPA vs email: UPI handles have no dot in the domain (@ybl, @okhdfcbank);
 *    email addresses do. That one fact separates them without a handle list.
 */
object Sanitizer {

    // ── DLT sender headers ────────────────────────────────────────────
    // TRAI format: <2-char telco prefix>-<entity header>[-<category>]
    //   AD-HDFCBK-S  ->  HDFCBK / S      VM-TSSPDC -> TSSPDC / null
    // The optional prefix group requires a separator, so "ADANI" does not
    // lose its leading "AD".
    private val DLT = Regex("""^(?:([A-Z]{2})[-_])?([A-Z0-9]{2,10})(?:[-_]([STPG]))?$""")
    private val PHONE = Regex("""^\+?\d[\d\s\-]{5,}$""")

    // ── Money ─────────────────────────────────────────────────────────
    private const val AMOUNT_BODY =
        """(?:\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"""
    val CURRENCY = Regex(
        """(?:₹|\bRs\.?|\bINR\b|\bRUPEES\b)\s*($AMOUNT_BODY)\s*(lakh|lacs?|lakhs|crores?|cr|k)?\b""",
        RegexOption.IGNORE_CASE
    )
    private val MULTIPLIER = mapOf(
        "lakh" to 100_000.0, "lac" to 100_000.0, "lacs" to 100_000.0, "lakhs" to 100_000.0,
        "cr" to 10_000_000.0, "crore" to 10_000_000.0, "crores" to 10_000_000.0, "k" to 1_000.0
    )

    // ── Identifiers ───────────────────────────────────────────────────
    val ACCOUNT = Regex(
        """(?:a/?c|acct|account|card|ac)\b[^\dxX*]{0,12}(?:[xX*]{2,}|ending\s+(?:in\s+)?)?(\d{3,6})\b""" +
            """|(?:[xX*]{4,})(\d{3,6})\b""",
        RegexOption.IGNORE_CASE
    )
    val RRN = Regex("""\b(\d{12})\b""")
    val TXN_REF = Regex(
        """(?:upi|ref|rrn|txn|transaction|utr)[^\d]{0,15}(\d{9,18})\b""",
        RegexOption.IGNORE_CASE
    )
    val VPA = Regex("""\b([a-z0-9][\w.\-]{1,30}@[a-z]{2,20})\b(?!\.[a-z])""", RegexOption.IGNORE_CASE)
    val ORDER_ID = Regex(
        """\b(\d{3}-\d{7}-\d{7})\b|order\s*(?:id|no\.?|#)?\s*[:#]?\s*([A-Z0-9\-]{6,20})\b""",
        RegexOption.IGNORE_CASE
    )

    private const val MON = """(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)"""
    val DATE = Regex(
        """\b\d{1,2}[-/](?:\d{1,2}|$MON)[-/]\d{2,4}\b""" +
            """|\b\d{1,2}\s*$MON\s*\d{2,4}\b""" +
            """|\b\d{1,2}(?:st|nd|rd|th)?\s+$MON\b""",
        RegexOption.IGNORE_CASE
    )
    val TIME = Regex("""\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|hrs)?\b""", RegexOption.IGNORE_CASE)
    val URL = Regex("""https?://\S+|\b(?:bit\.ly|tinyurl\.com)/\S+""", RegexOption.IGNORE_CASE)

    // ── OTP gate ──────────────────────────────────────────────────────
    private val OTP_MARK = Regex(
        """\b(?:otp|o\.t\.p|one[\s\-]?time\s+p(?:ass)?wo?r?d?|verification\s+code""" +
            """|security\s+code|auth(?:entication)?\s+code|login\s+code)\b""",
        RegexOption.IGNORE_CASE
    )
    private val OTP_VAL = Regex("""\b(\d{4,8})\b""")
    private val DO_NOT_SHARE = Regex("""(?:do\s*not|never|don'?t)\s+share""", RegexOption.IGNORE_CASE)
    private val DELIVERY_CTX = Regex(
        """\b(?:deliver|delivery|courier|parcel|shipment|rider|agent|collect)\w*\b""",
        RegexOption.IGNORE_CASE
    )

    private val ZERO_WIDTH = Regex("[\u200B-\u200F\u2060\uFEFF\u00AD]")
    private val MULTI_SPACE = Regex("[ \t]+")

    // ════════════════════════════════════════════════════════════════

    enum class SenderKind { INSTITUTION, PERSON, UNKNOWN }

    data class Sender(val norm: String?, val category: String?, val kind: SenderKind)

    fun sender(raw: String): Sender {
        val s = raw.trim().uppercase()
        if (PHONE.matches(s)) return Sender(null, null, SenderKind.PERSON)
        val m = DLT.matchEntire(s) ?: return Sender(null, null, SenderKind.UNKNOWN)
        return Sender(m.groupValues[2], m.groupValues[3].ifBlank { null }, SenderKind.INSTITUTION)
    }

    fun normalise(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFKC)
            .replace(ZERO_WIDTH, "")
            .let { MULTI_SPACE.replace(it, " ") }
            .trim()

    /** All money amounts in message order, lakh/crore multipliers applied. */
    fun amounts(text: String): List<Double> =
        CURRENCY.findAll(text).map { m ->
            val base = m.groupValues[1].replace(",", "").toDoubleOrNull() ?: 0.0
            val mult = m.groupValues[2].lowercase().let { MULTIPLIER[it] ?: 1.0 }
            base * mult
        }.toList()

    /** Masked account / card tails, de-duplicated, in message order. */
    fun accounts(text: String): List<String> =
        ACCOUNT.findAll(text)
            .map { it.groupValues[1].ifBlank { it.groupValues[2] } }
            .filter { it.isNotBlank() }
            .distinct().toList()

    data class Otp(val kind: Kind, val digits: Int, val confirmed: Boolean) {
        enum class Kind { AUTH, DELIVERY }
    }

    /**
     * Requires an OTP marker AND a 4-8 digit token within ~60 chars of it.
     * Marker alone matches "never share your OTP with anyone" security notices
     * that carry no code; the digit alone matches half the inbox.
     *
     * AUTH codes get purged on a TTL. DELIVERY codes do not — they belong to an
     * order and stay useful right up to the doorstep.
     */
    fun otp(text: String): Otp? {
        val mark = OTP_MARK.find(text) ?: return null
        val lo = (mark.range.first - 60).coerceAtLeast(0)
        val hi = (mark.range.last + 60).coerceAtMost(text.length)
        val value = OTP_VAL.find(text.substring(lo, hi)) ?: return null
        val kind = if (DELIVERY_CTX.containsMatchIn(text)) Otp.Kind.DELIVERY else Otp.Kind.AUTH
        return Otp(kind, value.groupValues[1].length, DO_NOT_SHARE.containsMatchIn(text))
    }

    /**
     * Masks every structurally unambiguous slot, leaving the template skeleton.
     *
     * Order is not cosmetic: amounts must be masked before generic digit runs,
     * or "2,340" is consumed as three separate number tokens and the skeleton
     * for one bank template differs by amount — which defeats the entire point.
     */
    fun skeleton(text: String): String {
        var t = normalise(text)
        t = URL.replace(t, " <URL> ")
        t = CURRENCY.replace(t, " <AMT> ")
        t = ACCOUNT.replace(t, " <ACCT> ")
        t = VPA.replace(t, " <VPA> ")
        t = DATE.replace(t, " <DATE> ")
        t = TIME.replace(t, " <TIME> ")
        t = Regex("""\b\d[\d,.]{2,}\b""").replace(t, " <NUM> ")
        t = Regex("""\b\d+\b""").replace(t, " <N> ")
        t = Regex("""[^\p{L}\p{N}<>\s]""").replace(t, " ")
        return Regex("""\s+""").replace(t, " ").trim().uppercase()
    }

    fun sha256Short(s: String, chars: Int = 16): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }.take(chars)

    /** Stable identity for dedup. Bodies repeat; body+number+time does not. */
    fun contentHash(number: String?, receivedAt: Long, body: String): String =
        sha256Short("${number.orEmpty()}|$receivedAt|$body", 32)
}
