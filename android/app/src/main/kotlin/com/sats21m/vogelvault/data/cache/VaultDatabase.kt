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
    version = 5,
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

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE cached_transactions ADD COLUMN amount_sats INTEGER",
                )
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE cached_transactions ADD COLUMN bitcoin_account_key TEXT",
                )
            }
        }

        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE cached_btc_buys " +
                        "ADD COLUMN fee_usd_cents INTEGER NOT NULL DEFAULT 0",
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
                .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5)
                .build()
    }
}
