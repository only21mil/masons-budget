package com.sats21m.vogelvault.data.cache

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/** Result of storing one remote query response. */
data class SnapshotWriteResult(
    val generation: Long,
    val activated: Boolean,
    val rowCount: Long,
    val completeness: String,
)

/**
 * Room boundary for remote query snapshots.
 *
 * Every replacement method is one database transaction: rows are written into a
 * fresh generation, completeness is checked, and only then is that generation
 * activated. Incomplete responses stay inactive, so observers keep receiving the
 * previous complete generation. The newest two complete generations are retained
 * for last-known-good recovery, plus the latest incomplete attempt for diagnosis.
 */
@Dao
abstract class VaultCacheDao {
    @Query(
        """
        SELECT rows.* FROM cached_transactions AS rows
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = rows.query_key
         AND snapshots.generation = rows.generation
        WHERE rows.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
        ORDER BY rows.date DESC, rows.source_file ASC, rows.transaction_id ASC
        """,
    )
    abstract fun observeTransactions(queryKey: String): Flow<List<CachedTransactionEntity>>

    @Query(
        """
        SELECT rows.* FROM cached_todos AS rows
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = rows.query_key
         AND snapshots.generation = rows.generation
        WHERE rows.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
        ORDER BY rows.updated_at_ms DESC, rows.todo_id ASC
        """,
    )
    abstract fun observeTodos(queryKey: String): Flow<List<CachedTodoEntity>>

    @Query(
        """
        SELECT rows.* FROM cached_btc_buys AS rows
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = rows.query_key
         AND snapshots.generation = rows.generation
        WHERE rows.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
        ORDER BY rows.date DESC, rows.source_file ASC, rows.buy_id ASC
        """,
    )
    abstract fun observeBtcBuys(queryKey: String): Flow<List<CachedBtcBuyEntity>>

    @Query(
        """
        SELECT rows.* FROM cached_btc_accounts AS rows
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = rows.query_key
         AND snapshots.generation = rows.generation
        WHERE rows.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
        ORDER BY rows.owner ASC, rows.account_key ASC
        """,
    )
    abstract fun observeBtcAccounts(queryKey: String): Flow<List<CachedBtcAccountEntity>>

    @Query(
        """
        SELECT * FROM query_snapshots
        WHERE query_key = :queryKey AND is_active = 1 AND is_complete = 1
        LIMIT 1
        """,
    )
    abstract fun observeActiveSnapshot(queryKey: String): Flow<QuerySnapshotEntity?>

    @Query(
        """
        SELECT * FROM query_snapshots
        WHERE query_key = :queryKey
        ORDER BY generation DESC
        """,
    )
    abstract suspend fun snapshots(queryKey: String): List<QuerySnapshotEntity>

    @Transaction
    open suspend fun replaceTransactions(
        queryKey: String,
        rows: List<TransactionCacheRow>,
        fetchedAtMs: Long,
        expectedRowCount: Long? = null,
        receivedComplete: Boolean = true,
    ): SnapshotWriteResult {
        val generation = begin(queryKey, KIND_TRANSACTIONS, fetchedAtMs, expectedRowCount)
        insertTransactions(rows.map { it.inSnapshot(queryKey, generation) })
        val stored = countTransactions(queryKey, generation)
        return finish(queryKey, generation, fetchedAtMs, stored, expectedRowCount, receivedComplete)
    }

    @Transaction
    open suspend fun replaceTodos(
        queryKey: String,
        rows: List<TodoCacheRow>,
        fetchedAtMs: Long,
        expectedRowCount: Long? = null,
        receivedComplete: Boolean = true,
    ): SnapshotWriteResult {
        val generation = begin(queryKey, KIND_TODOS, fetchedAtMs, expectedRowCount)
        insertTodos(rows.map { it.inSnapshot(queryKey, generation) })
        val stored = countTodos(queryKey, generation)
        return finish(queryKey, generation, fetchedAtMs, stored, expectedRowCount, receivedComplete)
    }

    @Transaction
    open suspend fun replaceBtcBuys(
        queryKey: String,
        rows: List<BtcBuyCacheRow>,
        fetchedAtMs: Long,
        expectedRowCount: Long? = null,
        receivedComplete: Boolean = true,
    ): SnapshotWriteResult {
        val generation = begin(queryKey, KIND_BTC_BUYS, fetchedAtMs, expectedRowCount)
        insertBtcBuys(rows.map { it.inSnapshot(queryKey, generation) })
        val stored = countBtcBuys(queryKey, generation)
        return finish(queryKey, generation, fetchedAtMs, stored, expectedRowCount, receivedComplete)
    }

    @Transaction
    open suspend fun replaceBtcAccounts(
        queryKey: String,
        rows: List<BtcAccountCacheRow>,
        fetchedAtMs: Long,
        expectedRowCount: Long? = null,
        receivedComplete: Boolean = true,
    ): SnapshotWriteResult {
        val generation = begin(queryKey, KIND_BTC_ACCOUNTS, fetchedAtMs, expectedRowCount)
        insertBtcAccounts(rows.map { it.inSnapshot(queryKey, generation) })
        val stored = countBtcAccounts(queryKey, generation)
        return finish(queryKey, generation, fetchedAtMs, stored, expectedRowCount, receivedComplete)
    }

    private suspend fun begin(
        queryKey: String,
        kind: String,
        fetchedAtMs: Long,
        expectedRowCount: Long?,
    ): Long {
        require(queryKey.isNotBlank()) { "queryKey must not be blank" }
        require(expectedRowCount == null || expectedRowCount >= 0L) {
            "expectedRowCount must be non-negative"
        }
        val generation = nextGeneration(queryKey)
        insertSnapshot(
            QuerySnapshotEntity(
                queryKey = queryKey,
                generation = generation,
                kind = kind,
                startedAtMs = fetchedAtMs,
                finishedAtMs = null,
                expectedRowCount = expectedRowCount,
                rowCount = 0L,
                isComplete = false,
                completeness = COMPLETENESS_WRITING,
                isActive = false,
                activatedAtMs = null,
            ),
        )
        return generation
    }

    private suspend fun finish(
        queryKey: String,
        generation: Long,
        fetchedAtMs: Long,
        storedRowCount: Long,
        expectedRowCount: Long?,
        receivedComplete: Boolean,
    ): SnapshotWriteResult {
        val completeness =
            when {
                !receivedComplete -> COMPLETENESS_UPSTREAM_INCOMPLETE
                expectedRowCount != null && expectedRowCount != storedRowCount -> COMPLETENESS_ROW_COUNT_MISMATCH
                else -> COMPLETENESS_COMPLETE
            }
        val complete = completeness == COMPLETENESS_COMPLETE
        finishSnapshot(
            queryKey = queryKey,
            generation = generation,
            finishedAtMs = fetchedAtMs,
            rowCount = storedRowCount,
            isComplete = complete,
            completeness = completeness,
        )

        if (complete) {
            deactivateSnapshots(queryKey)
            check(activateSnapshot(queryKey, generation, fetchedAtMs) == 1) {
                "complete snapshot could not be activated"
            }
        }
        pruneOldSnapshots(queryKey)
        return SnapshotWriteResult(
            generation = generation,
            activated = complete,
            rowCount = storedRowCount,
            completeness = completeness,
        )
    }

    @Query(
        """
        SELECT COALESCE(MAX(generation), 0) + 1
        FROM query_snapshots
        WHERE query_key = :queryKey
        """,
    )
    abstract suspend fun nextGeneration(queryKey: String): Long

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract suspend fun insertSnapshot(snapshot: QuerySnapshotEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract suspend fun insertTransactions(rows: List<CachedTransactionEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract suspend fun insertTodos(rows: List<CachedTodoEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract suspend fun insertBtcBuys(rows: List<CachedBtcBuyEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract suspend fun insertBtcAccounts(rows: List<CachedBtcAccountEntity>)

    @Query(
        """
        SELECT COUNT(*) FROM cached_transactions
        WHERE query_key = :queryKey AND generation = :generation
        """,
    )
    abstract suspend fun countTransactions(
        queryKey: String,
        generation: Long,
    ): Long

    @Query(
        """
        SELECT COUNT(*) FROM cached_todos
        WHERE query_key = :queryKey AND generation = :generation
        """,
    )
    abstract suspend fun countTodos(
        queryKey: String,
        generation: Long,
    ): Long

    @Query(
        """
        SELECT COUNT(*) FROM cached_btc_buys
        WHERE query_key = :queryKey AND generation = :generation
        """,
    )
    abstract suspend fun countBtcBuys(
        queryKey: String,
        generation: Long,
    ): Long

    @Query(
        """
        SELECT COUNT(*) FROM cached_btc_accounts
        WHERE query_key = :queryKey AND generation = :generation
        """,
    )
    abstract suspend fun countBtcAccounts(
        queryKey: String,
        generation: Long,
    ): Long

    @Query(
        """
        UPDATE query_snapshots
        SET finished_at_ms = :finishedAtMs,
            row_count = :rowCount,
            is_complete = :isComplete,
            completeness = :completeness
        WHERE query_key = :queryKey AND generation = :generation
        """,
    )
    abstract suspend fun finishSnapshot(
        queryKey: String,
        generation: Long,
        finishedAtMs: Long,
        rowCount: Long,
        isComplete: Boolean,
        completeness: String,
    )

    @Query("UPDATE query_snapshots SET is_active = 0 WHERE query_key = :queryKey AND is_active = 1")
    abstract suspend fun deactivateSnapshots(queryKey: String)

    @Query(
        """
        UPDATE query_snapshots
        SET is_active = 1, activated_at_ms = :activatedAtMs
        WHERE query_key = :queryKey
          AND generation = :generation
          AND is_complete = 1
        """,
    )
    abstract suspend fun activateSnapshot(
        queryKey: String,
        generation: Long,
        activatedAtMs: Long,
    ): Int

    @Query(
        """
        DELETE FROM query_snapshots
        WHERE query_key = :queryKey
          AND is_active = 0
          AND generation NOT IN (
              SELECT generation FROM query_snapshots
              WHERE query_key = :queryKey AND is_complete = 1
              ORDER BY activated_at_ms DESC, generation DESC
              LIMIT 2
          )
          AND generation NOT IN (
              SELECT generation FROM query_snapshots
              WHERE query_key = :queryKey AND is_complete = 0
              ORDER BY finished_at_ms DESC, generation DESC
              LIMIT 1
          )
        """,
    )
    abstract suspend fun pruneOldSnapshots(queryKey: String)

    private companion object {
        const val KIND_TRANSACTIONS = "transactions"
        const val KIND_TODOS = "todos"
        const val KIND_BTC_BUYS = "btc_buys"
        const val KIND_BTC_ACCOUNTS = "btc_accounts"

        const val COMPLETENESS_WRITING = "writing"
        const val COMPLETENESS_COMPLETE = "complete"
        const val COMPLETENESS_UPSTREAM_INCOMPLETE = "upstream_incomplete"
        const val COMPLETENESS_ROW_COUNT_MISMATCH = "row_count_mismatch"
    }
}
