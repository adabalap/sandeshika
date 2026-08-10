package com.adabala.sandeshika.di

import android.content.Context
import com.adabala.sandeshika.BuildConfig
import com.adabala.sandeshika.data.db.SandeshikaDatabase
import com.adabala.sandeshika.security.DbKeyProvider

/**
 * Minimal service locator. Hilt would be reasonable, but for a graph this
 * small it is a KSP processor and a compile-time cost to solve a problem the
 * app does not have yet. Swap it in when the graph earns it.
 */
object Graph {
    @Volatile private var db: SandeshikaDatabase? = null

    fun database(ctx: Context): SandeshikaDatabase = db ?: synchronized(this) {
        db ?: SandeshikaDatabase.get(
            ctx = ctx,
            encrypted = BuildConfig.DB_ENCRYPTION,
            passphrase = if (BuildConfig.DB_ENCRYPTION) DbKeyProvider.passphrase(ctx) else null
        ).also { db = it }
    }
}
