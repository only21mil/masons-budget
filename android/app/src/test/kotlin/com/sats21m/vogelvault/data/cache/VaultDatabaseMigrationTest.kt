package com.sats21m.vogelvault.data.cache

import android.app.Application
import androidx.room.Room
import org.json.JSONObject
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The cache upgrades run against real on-device databases that already hold
 * rows. A test that deletes the database and builds a fresh current-version
 * file never executes the migrations that ship to a phone.
 *
 * These tests build genuine historical databases from checked-in exported
 * schemas — every table, index, and the `room_master_table` identity hash Room
 * validates on open — put data in them, then open the real [VaultDatabase] so
 * Room runs and validates the migration exactly as it would after an update.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class VaultDatabaseMigrationTest {
    private val schemaDirectory =
        listOf(
            File("schemas/com.sats21m.vogelvault.data.cache.VaultDatabase"),
            File("app/schemas/com.sats21m.vogelvault.data.cache.VaultDatabase"),
        ).firstOrNull { it.isDirectory }
            ?: fail("exported Room schemas are not on disk; they are the only source for a migration test")

    private fun createVersionDatabase(databaseName: String, version: Int) {
        val context: Application = RuntimeEnvironment.getApplication()
        context.deleteDatabase(databaseName)
        val schema =
            JSONObject(File(schemaDirectory, "$version.json").readText())
                .getJSONObject("database")
        val identityHash = schema.getString("identityHash")

        val path = context.getDatabasePath(databaseName)
        path.parentFile?.mkdirs()
        val db = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(path, null)
        try {
            val entities = schema.getJSONArray("entities")
            for (index in 0 until entities.length()) {
                val entity = entities.getJSONObject(index)
                val tableName = entity.getString("tableName")
                db.execSQL(
                    entity.getString("createSql").replace("\${TABLE_NAME}", tableName),
                )
                val indices = entity.optJSONArray("indices") ?: continue
                for (i in 0 until indices.length()) {
                    db.execSQL(
                        indices
                            .getJSONObject(i)
                            .getString("createSql")
                            .replace("\${TABLE_NAME}", tableName),
                    )
                }
            }
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS room_master_table " +
                    "(id INTEGER PRIMARY KEY, identity_hash TEXT)",
            )
            db.execSQL(
                "INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES (42, ?)",
                arrayOf(identityHash),
            )
            db.version = version
        } finally {
            db.close()
        }
    }

    private fun seedLegacyTransaction(databaseName: String, transactionId: String) {
        val context: Application = RuntimeEnvironment.getApplication()
        val db =
            android.database.sqlite.SQLiteDatabase.openDatabase(
                context.getDatabasePath(databaseName).path,
                null,
                android.database.sqlite.SQLiteDatabase.OPEN_READWRITE,
            )
        try {
            db.execSQL(
                """
                INSERT INTO cached_transactions (
                    query_key, generation, source_file, transaction_id, owner,
                    date, month, merchant, amount_cents, category, card, note,
                    updated_at_ms
                ) VALUES (
                    'victor', 1, 'transactions', ?, 'VICTOR',
                    '2026-07-20', '2026-07', 'Payroll', -125000, 'Income', NULL,
                    NULL, 1234
                )
                """.trimIndent(),
                arrayOf(transactionId),
            )
        } finally {
            db.close()
        }
    }

    private fun seedVersion3BitcoinTransaction(databaseName: String) {
        val context: Application = RuntimeEnvironment.getApplication()
        val db =
            android.database.sqlite.SQLiteDatabase.openDatabase(
                context.getDatabasePath(databaseName).path,
                null,
                android.database.sqlite.SQLiteDatabase.OPEN_READWRITE,
            )
        try {
            db.execSQL(
                """
                INSERT INTO cached_transactions (
                    query_key, generation, source_file, transaction_id, owner,
                    date, month, merchant, amount_cents, category, card, note,
                    updated_at_ms, amount_sats
                ) VALUES (
                    'victor', 7, 'transactions', 'btc-v3', 'VICTOR',
                    '2026-08-20', '2026-08', 'Legacy Lightning', 2500, 'Other',
                    'lightning', 'preserve me', 9876, 21000
                )
                """.trimIndent(),
            )
        } finally {
            db.close()
        }
    }

    private fun seedVersion4BitcoinBuy(databaseName: String) {
        val context: Application = RuntimeEnvironment.getApplication()
        val db =
            android.database.sqlite.SQLiteDatabase.openDatabase(
                context.getDatabasePath(databaseName).path,
                null,
                android.database.sqlite.SQLiteDatabase.OPEN_READWRITE,
            )
        try {
            db.execSQL(
                """
                INSERT INTO query_snapshots (
                    query_key, generation, kind, started_at_ms, finished_at_ms,
                    expected_row_count, row_count, is_complete, completeness,
                    is_active, activated_at_ms, authorization, freshness, invalidated_at_ms
                ) VALUES (
                    'btc-buys|victor|visible', 1, 'btc_buys', 100, 101,
                    1, 1, 1, 'complete', 1, 101, 'authorized', 'current', NULL
                )
                """.trimIndent(),
            )
            db.execSQL(
                """
                INSERT INTO cached_btc_buys (
                    query_key, generation, source_file, buy_id, owner, date, month,
                    source, sats, price_usd_cents, usd_cents, note, status,
                    cost_basis_status, logged_by, archimedes_request_id, updated_at_ms
                ) VALUES (
                    'btc-buys|victor|visible', 1, 'bitcoin-buys', 'buy-v4', 'victor',
                    '2026-08-25', '2026-08', 'River', 100000, 6500000, 6500,
                    NULL, NULL, NULL, 'android', NULL, 1800000000000
                )
                """.trimIndent(),
            )
        } finally {
            db.close()
        }
    }

    private fun openMigrated(databaseName: String): VaultDatabase {
        val context: Application = RuntimeEnvironment.getApplication()
        return Room
            .databaseBuilder(context, VaultDatabase::class.java, databaseName)
            .addMigrations(
                VaultDatabase.MIGRATION_1_2,
                VaultDatabase.MIGRATION_2_3,
                VaultDatabase.MIGRATION_3_4,
                VaultDatabase.MIGRATION_4_5,
            )
            .build()
    }

    @Test
    fun `v2 cache upgrades through v5 without losing rows`() {
        val databaseName = "migration-v2-v5.db"
        createVersionDatabase(databaseName, 2)
        seedLegacyTransaction(databaseName, "tx-legacy")

        val migrated = openMigrated(databaseName)
        try {
            val cursor =
                migrated.openHelper.readableDatabase.query(
                    "SELECT transaction_id, amount_cents, updated_at_ms, amount_sats, " +
                        "bitcoin_account_key FROM cached_transactions",
                )
            cursor.use {
                assertTrue(it.moveToFirst(), "the pre-upgrade row survived")
                assertEquals("tx-legacy", it.getString(0))
                assertEquals(-125_000L, it.getLong(1))
                assertEquals(1234L, it.getLong(2))
                assertTrue(it.isNull(3), "amount_sats is absent on pre-upgrade rows")
                assertTrue(it.isNull(4), "bitcoin_account_key is absent on pre-upgrade rows")
                assertEquals(1, it.count)
            }
            assertEquals(5, migrated.openHelper.readableDatabase.version)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun `migrated cache still accepts Bitcoin posting fields`() {
        val databaseName = "migration-v2-v4-write.db"
        createVersionDatabase(databaseName, 2)
        seedLegacyTransaction(databaseName, "tx-legacy")

        val migrated = openMigrated(databaseName)
        try {
            migrated.openHelper.writableDatabase.execSQL(
                "UPDATE cached_transactions SET amount_sats = 50000, " +
                    "bitcoin_account_key = 'river-wallet' WHERE transaction_id = 'tx-legacy'",
            )
            val cursor =
                migrated.openHelper.readableDatabase.query(
                    "SELECT amount_sats, bitcoin_account_key FROM cached_transactions",
                )
            cursor.use {
                assertTrue(it.moveToFirst())
                assertEquals(50_000L, it.getLong(0))
                assertEquals("river-wallet", it.getString(1))
            }
        } finally {
            migrated.close()
        }
    }

    @Test
    fun `v3 Bitcoin row survives through v5 and gains a nullable account key`() {
        val databaseName = "migration-v3-v5-bitcoin.db"
        createVersionDatabase(databaseName, 3)
        seedVersion3BitcoinTransaction(databaseName)

        val context: Application = RuntimeEnvironment.getApplication()
        val migrated =
            Room.databaseBuilder(context, VaultDatabase::class.java, databaseName)
                .addMigrations(VaultDatabase.MIGRATION_3_4, VaultDatabase.MIGRATION_4_5)
                .build()
        try {
            val cursor = migrated.openHelper.readableDatabase.query(
                "SELECT query_key, generation, source_file, transaction_id, owner, date, month, " +
                    "merchant, amount_cents, category, card, note, updated_at_ms, amount_sats, " +
                    "bitcoin_account_key FROM cached_transactions",
            )
            cursor.use {
                assertTrue(it.moveToFirst(), "the v3 Bitcoin row survived")
                assertEquals("victor", it.getString(0))
                assertEquals(7L, it.getLong(1))
                assertEquals("transactions", it.getString(2))
                assertEquals("btc-v3", it.getString(3))
                assertEquals("VICTOR", it.getString(4))
                assertEquals("2026-08-20", it.getString(5))
                assertEquals("2026-08", it.getString(6))
                assertEquals("Legacy Lightning", it.getString(7))
                assertEquals(2_500L, it.getLong(8))
                assertEquals("Other", it.getString(9))
                assertEquals("lightning", it.getString(10))
                assertEquals("preserve me", it.getString(11))
                assertEquals(9_876L, it.getLong(12))
                assertEquals(21_000L, it.getLong(13))
                assertTrue(it.isNull(14), "pre-v4 rows gain an absent account key")
                assertEquals(1, it.count)
            }
            assertEquals(5, migrated.openHelper.readableDatabase.version)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun `v4 Bitcoin buy survives and defaults its missing fee to zero`() {
        val databaseName = "migration-v4-v5-bitcoin-buy.db"
        createVersionDatabase(databaseName, 4)
        seedVersion4BitcoinBuy(databaseName)

        val context: Application = RuntimeEnvironment.getApplication()
        val migrated =
            Room.databaseBuilder(context, VaultDatabase::class.java, databaseName)
                .addMigrations(VaultDatabase.MIGRATION_4_5)
                .build()
        try {
            val cursor = migrated.openHelper.readableDatabase.query(
                "SELECT buy_id, usd_cents, fee_usd_cents FROM cached_btc_buys",
            )
            cursor.use {
                assertTrue(it.moveToFirst(), "the v4 Bitcoin buy survived")
                assertEquals("buy-v4", it.getString(0))
                assertEquals(6_500L, it.getLong(1))
                assertEquals(0L, it.getLong(2))
                assertEquals(1, it.count)
            }
            assertEquals(5, migrated.openHelper.readableDatabase.version)
        } finally {
            migrated.close()
        }
    }
}
