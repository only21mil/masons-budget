package com.sats21m.vogelvault.data.cache

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        QuerySnapshotEntity::class,
        CachedTransactionEntity::class,
        CachedTodoEntity::class,
        CachedBtcBuyEntity::class,
        CachedBtcAccountEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
@TypeConverters(CacheTypeConverters::class)
abstract class VaultDatabase : RoomDatabase() {
    abstract fun cacheDao(): VaultCacheDao

    companion object {
        const val DATABASE_NAME = "vogel-vault.db"

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE cached_btc_accounts " +
                        "ADD COLUMN fiat_available INTEGER NOT NULL DEFAULT 0",
                )
                db.execSQL(
                    "UPDATE cached_btc_accounts SET fiat_available = 1 " +
                        "WHERE sats = 0 OR fiat_cents != 0",
                )
                db.execSQL(
                    "ALTER TABLE cached_btc_accounts ADD COLUMN fiat_price_cents INTEGER",
                )
                db.execSQL(
                    "ALTER TABLE cached_btc_accounts ADD COLUMN fiat_quoted_at TEXT",
                )
                db.execSQL(
                    "ALTER TABLE cached_btc_accounts ADD COLUMN fiat_source TEXT",
                )
                db.execSQL(
                    "ALTER TABLE cached_btc_accounts ADD COLUMN fiat_confidence TEXT",
                )
            }
        }

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
                )
                .addMigrations(MIGRATION_1_2)
                .build()
    }
}
