package com.adabala.sandeshika.data.db

import android.content.Context
import androidx.room.*
import kotlinx.coroutines.flow.Flow
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory

@Dao
interface SmsDao {

    /** IGNORE, not REPLACE: contentHash collisions are re-scans, not updates. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(rows: List<SmsRaw>): List<Long>

    @Query("SELECT COUNT(*) FROM sms_raw")
    fun countFlow(): Flow<Int>

    @Query("SELECT COUNT(*) FROM sms_raw")
    suspend fun count(): Int

    @Query("SELECT contentHash FROM sms_raw WHERE contentHash IN (:hashes)")
    suspend fun existingHashes(hashes: List<String>): List<String>

    @Query("SELECT * FROM sms_raw ORDER BY receivedAt DESC LIMIT :limit OFFSET :offset")
    fun timeline(limit: Int, offset: Int): Flow<List<SmsRaw>>

    @Query("SELECT * FROM sms_raw WHERE pipelineStatus = :status ORDER BY receivedAt DESC LIMIT :limit")
    suspend fun byStatus(status: String, limit: Int): List<SmsRaw>

    @Query("UPDATE sms_raw SET pipelineStatus = :status WHERE id IN (:ids)")
    suspend fun setStatus(ids: List<Long>, status: String)

    /**
     * Hybrid search entry point. FTS4 handles the lexical side; the semantic
     * side arrives in P7 once Medha has an embedder loaded.
     */
    @Query("""
        SELECT s.* FROM sms_raw s
        JOIN sms_fts f ON f.rowid = s.id
        WHERE sms_fts MATCH :query
        ORDER BY s.receivedAt DESC LIMIT :limit
    """)
    suspend fun search(query: String, limit: Int = 100): List<SmsRaw>

    @Query("""
        SELECT senderNorm, COUNT(*) AS n FROM sms_raw
        WHERE senderNorm IS NOT NULL
        GROUP BY senderNorm ORDER BY n DESC LIMIT :limit
    """)
    suspend fun topSenders(limit: Int = 40): List<SenderCount>

    /**
     * OTP purge. Wipes the body, keeps the row: dedup depends on contentHash
     * surviving, and the security lens still wants sender and timestamp.
     */
    @Query("""
        UPDATE sms_raw SET body = '', bodyNormalised = NULL, bodyPurged = 1
        WHERE isSensitive = 1 AND bodyPurged = 0
          AND purgeAfter IS NOT NULL AND purgeAfter < :now
    """)
    suspend fun purgeExpiredSensitive(now: Long): Int
}

@Dao
interface TemplateDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(row: TemplateRow)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<TemplateRow>)

    @Query("SELECT * FROM templates ORDER BY hitCount DESC")
    suspend fun all(): List<TemplateRow>

    @Query("SELECT * FROM templates ORDER BY hitCount DESC LIMIT :limit")
    fun topFlow(limit: Int = 200): Flow<List<TemplateRow>>

    @Query("SELECT * FROM templates WHERE fp = :fp")
    suspend fun byFp(fp: String): TemplateRow?

    @Query("SELECT COUNT(*) FROM templates")
    fun countFlow(): Flow<Int>

    /** Coverage: the share of messages a learned template already explains. */
    @Query("SELECT COALESCE(SUM(hitCount), 0) FROM templates WHERE hitCount > 1")
    suspend fun coveredMessages(): Int
}

@Dao
interface IngestStateDao {
    @Query("SELECT * FROM ingest_state WHERE id = 1")
    suspend fun get(): IngestState?

    @Query("SELECT * FROM ingest_state WHERE id = 1")
    fun flow(): Flow<IngestState?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(state: IngestState)
}

@Database(
    entities = [SmsRaw::class, TemplateRow::class, SmsFts::class, IngestState::class],
    version = 1,
    exportSchema = true
)
abstract class SandeshikaDatabase : RoomDatabase() {
    abstract fun sms(): SmsDao
    abstract fun templates(): TemplateDao
    abstract fun ingestState(): IngestStateDao

    companion object {
        private const val NAME = "sandeshika.db"

        @Volatile private var inst: SandeshikaDatabase? = null

        fun get(ctx: Context, encrypted: Boolean, passphrase: ByteArray?): SandeshikaDatabase =
            inst ?: synchronized(this) { inst ?: build(ctx, encrypted, passphrase).also { inst = it } }

        private fun build(ctx: Context, encrypted: Boolean, passphrase: ByteArray?): SandeshikaDatabase {
            val b = Room.databaseBuilder(ctx.applicationContext, SandeshikaDatabase::class.java, NAME)
            if (encrypted) {
                require(passphrase != null && passphrase.isNotEmpty()) {
                    "DB_ENCRYPTION=true but no passphrase was supplied"
                }
                System.loadLibrary("sqlcipher")
                // SupportOpenHelperFactory zeroes the passphrase array after use.
                b.openHelperFactory(SupportOpenHelperFactory(passphrase))
            }
            // No fallbackToDestructiveMigration. Losing a user's message history
            // on a schema bump is not an acceptable failure mode, and it is the
            // exact hazard Medha's own readiness doc calls out as highest
            // consequence. Every migration gets written and tested by hand.
            return b.build()
        }
    }
}
