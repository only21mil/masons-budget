package com.sats21m.vogelvault.data.cache

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        QuerySnapshotEntity::class,
        CachedTransactionEntity::class,
        CachedTodoEntity::class,
        CachedBtcBuyEntity::class,
        CachedBtcAccountEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class VaultDatabase : RoomDatabase() {
    abstract fun cacheDao(): VaultCacheDao

    companion object {
        const val DATABASE_NAME = "vogel-vault.db"

        /**
         * Production construction intentionally has no destructive migration
         * fallback. A missing future migration must fail closed rather than erase
         * the only on-device last-known-good snapshot.
         */
        fun create(context: Context): VaultDatabase =
            Room
                .databaseBuilder(
                    context.applicationContext,
                    VaultDatabase::class.java,
                    DATABASE_NAME,
                ).build()
    }
}
