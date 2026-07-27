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
 * previous complete generation. An authorization rejection explicitly marks that
 * generation stale: its rows remain available for recovery, but current-data
 * observers stop emitting them. The newest two complete generations are retained
 * for last-known-good recovery, plus the latest incomplete attempt for diagnosis.
 */
@Dao
abstract class VaultCacheDao {
    @Query(
        """
        SELECT cached.* FROM cached_transactions AS cached
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = cached.query_key
         AND snapshots.generation = cached.generation
        WHERE cached.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
          AND snapshots.authorization = 'authorized'
          AND snapshots.freshness = 'current'
        ORDER BY cached.date DESC, cached.source_file ASC, cached.transaction_id ASC
        """,
    )
    abstract fun observeTransactions(queryKey: String): Flow<List<CachedTransactionEntity>>

    @Query(
        """
        SELECT cached.* FROM cached_todos AS cached
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = cached.query_key
         AND snapshots.generation = cached.generation
        WHERE cached.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
          AND snapshots.authorization = 'authorized'
          AND snapshots.freshness = 'current'
        ORDER BY cached.updated_at_ms DESC, cached.todo_id ASC
        """,
    )
    abstract fun observeTodos(queryKey: String): Flow<List<CachedTodoEntity>>

    @Query(
        """
        SELECT cached.* FROM cached_btc_buys AS cached
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = cached.query_key
         AND snapshots.generation = cached.generation
        WHERE cached.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
          AND snapshots.authorization = 'authorized'
          AND snapshots.freshness = 'current'
        ORDER BY cached.date DESC, cached.source_file ASC, cached.buy_id ASC
        """,
    )
    abstract fun observeBtcBuys(queryKey: String): Flow<List<CachedBtcBuyEntity>>

    @Query(
        """
        SELECT cached.* FROM cached_btc_accounts AS cached
        INNER JOIN query_snapshots AS snapshots
          ON snapshots.query_key = cached.query_key
         AND snapshots.generation = cached.generation
        WHERE cached.query_key = :queryKey
          AND snapshots.is_active = 1
          AND snapshots.is_complete = 1
          AND snapshots.authorization = 'authorized'
          AND snapshots.freshness = 'current'
        ORDER BY cached.owner ASC, cached.account_key ASC
        """,
    )
    abstract fun observeBtcAccounts(queryKey: String): Flow<List<CachedBtcAccountEntity>>

    @Query(
        """
        SELECT * FROM query_snapshots
        WHERE query_key = :queryKey
          AND is_active = 1
          AND is_complete = 1
          AND authorization = 'authorized'
          AND freshness = 'current'
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

    /**
     * Records that Convex rejected the read credential for this query.
     *
     * The last complete generation remains on disk and active for diagnosis and
     * recovery, but is no longer current and cannot be emitted by row observers.
     */
    @Transaction
    open suspend fun markUnauthorized(
        queryKey: String,
        rejectedAtMs: Long,
    ): Int {
        require(queryKey.isNotBlank()) { "queryKey must not be blank" }
        require(rejectedAtMs >= 0L) { "rejectedAtMs must be non-negative" }
        return invalidateActiveSnapshotForAuthorization(queryKey, rejectedAtMs)
    }

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
                authorization = SnapshotAuthorization.AUTHORIZED,
                freshness = SnapshotFreshness.CURRENT,
                invalidatedAtMs = null,
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
        UPDATE query_snapshots
        SET authorization = 'unauthorized',
            freshness = 'stale_auth',
            invalidated_at_ms = :rejectedAtMs
        WHERE query_key = :queryKey
          AND is_active = 1
          AND is_complete = 1
        """,
    )
    abstract suspend fun invalidateActiveSnapshotForAuthorization(
        queryKey: String,
        rejectedAtMs: Long,
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
