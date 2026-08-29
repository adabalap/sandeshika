package com.adabala.sandeshika

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.adabala.sandeshika.classify.Category

/**
 * Stores what the user has told us we got wrong.
 *
 * ## Why plain SQLite and not Room
 *
 * Room would mean adding KSP annotation processing to the build. The schema
 * here is one table with four columns and no relations, so the code Room
 * would generate is code worth writing by hand — and this project builds
 * exclusively through CI, where an annotation-processor misconfiguration
 * costs a full round trip to discover. The complexity is not worth what it
 * buys at this size.
 *
 * ## Why corrections are keyed by shape, not by message
 *
 * A correction keyed to one message would fix one message. Real inboxes
 * repeat: 311 near-identical Bata offers, 97 school attendance notices. Keying
 * on [com.adabala.sandeshika.classify.MessageRedactor.shapeKey] means
 * correcting one instance re-labels every duplicate immediately, which is the
 * difference between a feature people use and a chore they abandon.
 *
 * ## Why corrections are not just training data
 *
 * They are applied as exact-match overrides *before* the rules run, as well
 * as being fed to the model. A user who has explicitly said "this is a bill"
 * should see it filed as a bill on the very next scan — not probably, and not
 * after enough similar examples accumulate. Feeding them only to the model
 * would make an explicit instruction into a statistical hint.
 */
class CorrectionStore(context: Context) : SQLiteOpenHelper(
    context.applicationContext, DB_NAME, null, DB_VERSION
) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE corrections(
                shape_key TEXT PRIMARY KEY NOT NULL,
                category  TEXT NOT NULL,
                sample    TEXT,
                created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldV: Int, newV: Int) {
        // Corrections are user-entered and not reproducible, so a future
        // migration must preserve them rather than recreate the table. There
        // is nothing to migrate at version 1; this exists so the next person
        // sees the intent before writing a DROP.
    }

    /**
     * Records a correction, replacing any earlier one for the same shape.
     *
     * Named `save` rather than `put` deliberately: a method called `put` on
     * this class shadows `ContentValues.put` inside the `apply` block below,
     * and while Kotlin resolves the receiver's member first, code whose
     * correctness depends on the reader knowing that rule is code waiting to
     * be mis-edited.
     */
    fun save(shapeKey: String, category: Category, sample: String) {
        writableDatabase.insertWithOnConflict(
            "corrections",
            null,
            ContentValues().apply {
                put("shape_key", shapeKey)
                put("category", category.name)
                put("sample", sample.take(300))
                put("created_at", System.currentTimeMillis())
            },
            SQLiteDatabase.CONFLICT_REPLACE
        )
        cache = null
    }

    fun remove(shapeKey: String) {
        writableDatabase.delete("corrections", "shape_key = ?", arrayOf(shapeKey))
        cache = null
    }

    /**
     * All corrections, loaded once and held in memory.
     *
     * A scan classifies tens of thousands of messages, and a database round
     * trip per message would dominate the runtime for a table that is
     * realistically a few hundred rows. Loaded once, invalidated on write.
     */
    fun all(): Map<String, Category> {
        cache?.let { return it }
        val out = mutableMapOf<String, Category>()
        readableDatabase.query(
            "corrections", arrayOf("shape_key", "category"),
            null, null, null, null, null
        ).use { c ->
            while (c.moveToNext()) {
                val cat = runCatching { Category.valueOf(c.getString(1)) }.getOrNull()
                // A category removed in a later version leaves rows behind.
                // Skipping them beats crashing on someone's saved data.
                if (cat != null) out[c.getString(0)] = cat
            }
        }
        cache = out
        return out
    }

    /** Sample bodies per category, for training the model. */
    fun trainingExamples(): List<Pair<String, Category>> {
        val out = mutableListOf<Pair<String, Category>>()
        readableDatabase.query(
            "corrections", arrayOf("sample", "category"),
            "sample IS NOT NULL", null, null, null, null
        ).use { c ->
            while (c.moveToNext()) {
                val cat = runCatching { Category.valueOf(c.getString(1)) }.getOrNull() ?: continue
                out.add(c.getString(0) to cat)
            }
        }
        return out
    }

    fun count(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM corrections", null)
        .use { if (it.moveToFirst()) it.getInt(0) else 0 }

    @Volatile private var cache: Map<String, Category>? = null

    private companion object {
        const val DB_NAME = "sandeshika.db"
        const val DB_VERSION = 1
    }
}
