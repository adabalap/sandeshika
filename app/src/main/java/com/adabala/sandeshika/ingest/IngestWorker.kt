package com.adabala.sandeshika.ingest

import android.content.Context
import androidx.work.*
import com.adabala.sandeshika.config.AppConfig
import com.adabala.sandeshika.data.db.*
import com.adabala.sandeshika.di.Graph
import com.adabala.sandeshika.pipeline.TemplateMiner
import java.util.concurrent.TimeUnit

/**
 * Pulls messages from the OS provider into Room, assigns template fingerprints,
 * and maintains the ingestion watermark.
 *
 * Two modes on one worker:
 *  - FORWARD  cheap, frequent. Everything newer than [IngestState.newestSeenAt].
 *  - BACKFILL one page older than [IngestState.oldestSeenAt] per run, so a
 *    40,000-message inbox never becomes one long transaction that Android
 *    kills halfway with no way to tell how far it got.
 *
 * Deliberately not a foreground service. Ingestion is bursty, and Medha already
 * carries the `dataSync` foreground-service cost plus its Android 15 daily
 * runtime cap; a second always-on service would double that liability for work
 * WorkManager schedules perfectly well.
 */
class IngestWorker(
    ctx: Context,
    params: WorkerParameters
) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val reader = SmsReader(applicationContext)
        if (!reader.canRead()) return Result.success()   // permission not granted yet

        val cfg = AppConfig.get(applicationContext).snapshot()
        val db = Graph.database(applicationContext)
        val smsDao = db.sms()
        val tplDao = db.templates()
        val stateDao = db.ingestState()

        val state = stateDao.get() ?: IngestState()
        val mode = inputData.getString(KEY_MODE) ?: MODE_FORWARD

        // Restore learned templates so a cold start does not re-derive slots
        // it already knows, and does not fragment an existing template.
        val miner = TemplateMiner(cfg.templateMergeRatio, cfg.templatePrefixTokens)
        tplDao.all().forEach { t ->
            miner.restore(t.senderNorm.orEmpty(), t.skeleton.split(' '), t.hitCount)
        }

        val historyFloor = if (cfg.historyDays > 0)
            System.currentTimeMillis() - cfg.historyDays * 86_400_000L else 0L

        val page = when (mode) {
            MODE_BACKFILL -> reader.page(
                before = state.oldestSeenAt.takeIf { it != Long.MAX_VALUE },
                limit = cfg.backfillPageSize
            ).filter { it.receivedAt >= historyFloor }
            else -> reader.page(after = state.newestSeenAt, limit = cfg.backfillPageSize)
        }

        if (page.isEmpty()) {
            if (mode == MODE_BACKFILL) {
                stateDao.put(state.copy(backfillComplete = true, lastRunAt = System.currentTimeMillis()))
            }
            return Result.success()
        }

        // Drop anything already stored. contentHash makes re-scans idempotent,
        // and the IGNORE conflict strategy would handle it anyway — but
        // filtering first avoids running the miner over known messages.
        val known = smsDao.existingHashes(page.map { it.contentHash }).toHashSet()
        val fresh = page.filter { it.contentHash !in known }

        val fingerprinted = fresh.map { row ->
            val r = miner.add(row.senderNorm ?: row.senderKind, row.body)
            row.copy(templateFp = r.template.fp)
        }

        smsDao.insertAll(fingerprinted)

        val now = System.currentTimeMillis()
        tplDao.upsertAll(
            miner.all().map { t ->
                TemplateRow(
                    fp = t.fp,
                    senderNorm = null,
                    skeleton = t.skeleton,
                    exemplarSmsId = null,
                    origin = "miner",
                    hitCount = t.count,
                    firstSeen = now,
                    lastSeen = now
                )
            }
        )

        val newest = maxOf(state.newestSeenAt, page.maxOf { it.receivedAt })
        val oldest = minOf(state.oldestSeenAt, page.minOf { it.receivedAt })
        val reachedLimit = cfg.backfillMaxMessages > 0 &&
            state.totalIngested + fresh.size >= cfg.backfillMaxMessages

        stateDao.put(
            state.copy(
                newestSeenAt = newest,
                oldestSeenAt = oldest,
                totalIngested = state.totalIngested + fresh.size,
                backfillComplete = state.backfillComplete || reachedLimit,
                lastRunAt = now
            )
        )

        smsDao.purgeExpiredSensitive(now)

        // Backfill continues one page at a time until the provider runs dry.
        if (mode == MODE_BACKFILL && !reachedLimit) enqueueBackfill(applicationContext)

        return Result.success()
    }

    companion object {
        const val KEY_MODE = "mode"
        const val MODE_FORWARD = "forward"
        const val MODE_BACKFILL = "backfill"

        private const val WORK_SWEEP = "sandeshika.sweep"
        private const val WORK_BACKFILL = "sandeshika.backfill"
        private const val WORK_NOW = "sandeshika.now"

        /** Full history import. Safe to call repeatedly; the watermark resumes. */
        fun enqueueBackfill(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                WORK_BACKFILL,
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<IngestWorker>()
                    .setInputData(workDataOf(KEY_MODE to MODE_BACKFILL))
                    .setConstraints(
                        Constraints.Builder()
                            .setRequiresBatteryNotLow(true)
                            .build()
                    )
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .build()
            )
        }

        /** Debounced kick from the ContentObserver. REPLACE coalesces the burst. */
        fun enqueueNow(ctx: Context, delayMs: Long = 0) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                WORK_NOW,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<IngestWorker>()
                    .setInputData(workDataOf(KEY_MODE to MODE_FORWARD))
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .build()
            )
        }

        /**
         * Safety net for everything the observer misses — process death, Doze,
         * OEM task-killing. 15 min is WorkManager's floor; smaller is clamped.
         */
        fun schedulePeriodicSweep(ctx: Context, minutes: Int) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_SWEEP,
                ExistingPeriodicWorkPolicy.UPDATE,
                PeriodicWorkRequestBuilder<IngestWorker>(
                    minutes.coerceAtLeast(15).toLong(), TimeUnit.MINUTES
                )
                    .setInputData(workDataOf(KEY_MODE to MODE_FORWARD))
                    .build()
            )
        }
    }
}
