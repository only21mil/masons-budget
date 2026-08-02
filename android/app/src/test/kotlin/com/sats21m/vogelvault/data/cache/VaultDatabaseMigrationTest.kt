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
 * The v2 -> v3 upgrade runs against a real on-device cache that already holds
 * rows. A test that deletes the database and builds a fresh v3 file never
 * executes [VaultDatabase.MIGRATION_2_3] at all, so the upgrade path that ships
 * to a phone would be unverified.
 *
 * These tests build a genuine v2 database from the checked-in exported schema —
 * every table, index, and the `room_master_table` identity hash Room validates
 * on open — put data in it, then open the real [VaultDatabase] so Room runs the
 * migration exactly as it would after an app update.
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

    private fun createVersion2Database(databaseName: String) {
        val context: Application = RuntimeEnvironment.getApplication()
        context.deleteDatabase(databaseName)
        val schema =
            JSONObject(File(schemaDirectory, "2.json").readText())
                .getJSONObject("database")
        val identityHash = schema.getString("identityHash")

        val path = context.getDatabasePath(databaseName)
        path.parentFile?.mkdirs()
        val db =
            android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(path, null)
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
            // Room refuses to open a database whose recorded identity does not
            // match the schema it expects for that version.
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS room_master_table " +
                    "(id INTEGER PRIMARY KEY, identity_hash TEXT)",
            )
            db.execSQL(
                "INSERT OR REPLACE INTO room_master_table (id, identity_hash) VALUES (42, ?)",
                arrayOf(identityHash),
            )
            db.version = 2
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

    private fun openMigrated(databaseName: String): VaultDatabase {
        val context: Application = RuntimeEnvironment.getApplication()
        return Room
            .databaseBuilder(context, VaultDatabase::class.java, databaseName)
            .addMigrations(VaultDatabase.MIGRATION_1_2, VaultDatabase.MIGRATION_2_3)
            .build()
    }

    @Test
    fun `v2 to v3 upgrade preserves cached rows and adds amount_sats as absent`() {
        val databaseName = "migration-v2-v3.db"
        createVersion2Database(databaseName)
        seedLegacyTransaction(databaseName, "tx-legacy")

        val migrated = openMigrated(databaseName)
        try {
            // Opening triggers MIGRATION_2_3; Room validates the v3 schema after.
            val cursor =
                migrated.openHelper.readableDatabase.query(
                    "SELECT transaction_id, amount_cents, updated_at_ms, amount_sats " +
                        "FROM cached_transactions",
                )
            cursor.use {
                assertTrue(it.moveToFirst(), "the pre-upgrade row survived")
                assertEquals("tx-legacy", it.getString(0))
                assertEquals(-125_000L, it.getLong(1))
                assertEquals(1234L, it.getLong(2))
                // Absent, never 0: a real zero-sat write must stay distinguishable
                // from a row that predates the column.
                assertTrue(it.isNull(3), "amount_sats is absent on pre-upgrade rows")
                assertEquals(1, it.count)
            }
            assertEquals(3, migrated.openHelper.readableDatabase.version)
        } finally {
            migrated.close()
        }
    }

    @Test
    fun `migrated cache still accepts a sats-bearing write`() {
        val databaseName = "migration-v2-v3-write.db"
        createVersion2Database(databaseName)
        seedLegacyTransaction(databaseName, "tx-legacy")

        val migrated = openMigrated(databaseName)
        try {
            migrated.openHelper.writableDatabase.execSQL(
                "UPDATE cached_transactions SET amount_sats = 50000 " +
                    "WHERE transaction_id = 'tx-legacy'",
            )
            val cursor =
                migrated.openHelper.readableDatabase.query(
                    "SELECT amount_sats FROM cached_transactions",
                )
            cursor.use {
                assertTrue(it.moveToFirst())
                assertEquals(50_000L, it.getLong(0))
            }
        } finally {
            migrated.close()
        }
    }
}
