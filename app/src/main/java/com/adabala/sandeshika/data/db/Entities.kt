package com.adabala.sandeshika.data.db

import androidx.room.*

/**
 * P0 schema: immutable raw layer plus the template bank.
 *
 * Events, entities, obligations and the ledger arrive in P1-P5. They are
 * deliberately absent here — shipping the raw layer and FTS first means the
 * app is useful (instant search over years of SMS) before any derived table
 * exists, and every later table is a purely additive migration.
 */

object PipelineStatus {
    const val NEW = "NEW"
    const val SANITIZED = "SANITIZED"
    const val ROUTED = "ROUTED"
    const val EXTRACTED = "EXTRACTED"
    const val LINKED = "LINKED"
    const val PROJECTED = "PROJECTED"
    const val DONE = "DONE"
    const val QUARANTINED = "QUARANTINED"
}

@Entity(
    tableName = "sms_raw",
    indices = [
        Index(value = ["contentHash"], unique = true),
        Index(value = ["receivedAt"]),
        Index(value = ["templateFp"]),
        Index(value = ["pipelineStatus"]),
        Index(value = ["purgeAfter"]),
        Index(value = ["senderNorm"])
    ]
)
data class SmsRaw(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,

    /** Telephony.Sms._ID. Kept so mark-read can be written back to the OS. */
    val systemId: Long?,
    val threadIdOs: Long?,

    val senderRaw: String,          // "AD-HDFCBK-S"
    val senderNorm: String?,        // "HDFCBK"
    val senderCategory: String?,    // S / T / P / G from the DLT suffix
    val senderKind: String,         // INSTITUTION | PERSON | UNKNOWN
    val number: String?,

    val body: String,               // encrypted at rest by SQLCipher
    val bodyNormalised: String?,
    val receivedAt: Long,
    val ingestedAt: Long,

    /** sha256(number|receivedAt|body). The dedup key across re-scans. */
    val contentHash: String,
    val templateFp: String?,
    val language: String?,
    val simSlot: Int?,

    /**
     * Auth OTP. Body is wiped at [purgeAfter]; the row survives so the
     * security lens keeps its metadata and dedup stays correct.
     */
    val isSensitive: Boolean = false,
    val purgeAfter: Long?,
    val bodyPurged: Boolean = false,

    val pipelineStatus: String = PipelineStatus.NEW,
    val pipelineError: String? = null
)

/**
 * The template bank. Grows from data (TemplateMiner) and, from P6, from Medha
 * induction. A verified template is worth far more than one correct parse —
 * it is every future message from that sender, free.
 */
@Entity(
    tableName = "templates",
    indices = [Index(value = ["senderNorm"]), Index(value = ["lastSeen"])]
)
data class TemplateRow(
    @PrimaryKey val fp: String,
    val senderNorm: String?,
    /** Space-joined skeleton tokens; <VAR> marks a learned variable slot. */
    val skeleton: String,
    val exemplarSmsId: Long?,
    val domain: String? = null,
    val intent: String? = null,
    /** JSON: regex + slot type map. Null until induction fills it in (P6). */
    val extractorJson: String? = null,
    val confidence: Float = 0.5f,
    /** miner | seed | medha | user */
    val origin: String,
    val verified: Boolean = false,
    val hitCount: Int = 0,
    val errorCount: Int = 0,
    val firstSeen: Long,
    val lastSeen: Long
)

/**
 * Content-backed FTS. Room keeps the index in sync with sms_raw, which avoids
 * the hand-maintained-FTS drift that Medha's own PRODUCTION-READINESS doc
 * flags as a quiet retrieval-degradation bug.
 */
@Fts4(contentEntity = SmsRaw::class)
@Entity(tableName = "sms_fts")
data class SmsFts(
    @ColumnInfo(name = "rowid") @PrimaryKey val rowId: Long,
    val body: String,
    val senderNorm: String?
)

/** Ingestion watermark, so a resumed backfill never re-walks the whole inbox. */
@Entity(tableName = "ingest_state")
data class IngestState(
    @PrimaryKey val id: Int = 1,
    /** Newest message timestamp seen. Forward sweeps start here. */
    val newestSeenAt: Long = 0,
    /** Oldest message timestamp reached. Backfill pages downward from here. */
    val oldestSeenAt: Long = Long.MAX_VALUE,
    val backfillComplete: Boolean = false,
    val totalIngested: Int = 0,
    val lastRunAt: Long = 0
)

data class SenderCount(val senderNorm: String?, val n: Int)
