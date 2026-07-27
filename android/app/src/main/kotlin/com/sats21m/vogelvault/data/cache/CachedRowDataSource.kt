package com.sats21m.vogelvault.data.cache

import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.RowQueryRepository
import com.sats21m.vogelvault.data.RowSnapshot
import com.sats21m.vogelvault.data.RowVisibilityScope
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

data class CachedReadModel(
    val data: ReadModel,
    val staleAuthorization: Boolean,
)

/**
 * The single integration boundary between typed Convex rows and Room snapshots.
 *
 * Queries remain unbounded here: an explicitly bounded response is incomplete
 * and must never replace a complete generation. Tokens are absent from every
 * cache key.
 */
class CachedRowDataSource(
    private val remote: RowQueryRepository,
    private val dao: VaultCacheDao,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun observe(viewer: FamilyMember): Flow<CachedReadModel> {
        val transactionsKey = CacheQueryKeys.transactions(viewer.key)
        val todosKey = CacheQueryKeys.todos(viewer.key)
        val btcBuysKey = CacheQueryKeys.btcBuys(viewer.key, RowVisibilityScope.VISIBLE.cacheKey)
        val btcAccountsKey = CacheQueryKeys.btcAccounts(viewer.key, RowVisibilityScope.VISIBLE.cacheKey)

        val transactions =
            combine(
                dao.observeTransactions(transactionsKey),
                dao.observeSnapshotState(transactionsKey),
            ) { rows, snapshot ->
                cachedSlice(rows.map { it.toDomain() }, snapshot, "Convex rows · transactions")
            }
        val todos =
            combine(dao.observeTodos(todosKey), dao.observeSnapshotState(todosKey)) { rows, snapshot ->
                cachedSlice(rows.map { it.toDomain() }, snapshot, "Convex rows · todos")
            }
        val btcBuys =
            combine(dao.observeBtcBuys(btcBuysKey), dao.observeSnapshotState(btcBuysKey)) { rows, snapshot ->
                cachedSlice(rows.map { it.toDomain() }, snapshot, "Convex rows · bitcoin buys")
            }
        val btcAccounts =
            combine(
                dao.observeBtcAccounts(btcAccountsKey),
                dao.observeSnapshotState(btcAccountsKey),
            ) { rows, snapshot ->
                cachedSlice(rows.map { it.toDomain() }, snapshot, "Convex rows · bitcoin accounts")
            }

        return combine(transactions, todos, btcBuys, btcAccounts) { tx, task, buys, accounts ->
            val slices = listOf(tx, task, buys, accounts)
            CachedReadModel(
                data =
                    ReadModel(
                        transactions = tx,
                        budget = Slice(Freshness.EMPTY, null, null, "Convex rows · budget not cached"),
                        btcAccounts = accounts,
                        btcBuys = buys,
                        todos = task,
                        // Snapshot metadata/price is outside the Room cache landed in #58.
                        btcPriceCents = 0L,
                    ),
                staleAuthorization = slices.any { it.status == Freshness.STALE },
            )
        }
    }

    suspend fun refresh(viewer: FamilyMember) {
        refreshTransactions(viewer)
        refreshTodos(viewer)
        refreshBtcBuys(viewer)
        refreshBtcAccounts(viewer)
    }

    private suspend fun refreshTransactions(viewer: FamilyMember) {
        val key = CacheQueryKeys.transactions(viewer.key)
        when (val result = remote.listTransactions(viewer)) {
            is ConvexResult.Ok ->
                dao.replaceTransactions(
                    queryKey = key,
                    rows =
                        result.value.rows.map {
                            TransactionCacheRow(
                                sourceFile = it.owner.key,
                                transactionId = it.id,
                                owner = it.owner,
                                date = it.date,
                                month = it.date.take(7),
                                merchant = it.merchant,
                                amountCents = it.amount,
                                category = it.category,
                                card = it.card,
                                note = it.note,
                                updatedAtMs = clock(),
                            )
                        },
                    fetchedAtMs = clock(),
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            ConvexResult.Unauthorized -> dao.markUnauthorized(key, clock())
            else -> Unit
        }
    }

    private suspend fun refreshTodos(viewer: FamilyMember) {
        val key = CacheQueryKeys.todos(viewer.key)
        when (val result = remote.listTodos(viewer)) {
            is ConvexResult.Ok ->
                dao.replaceTodos(
                    queryKey = key,
                    rows =
                        result.value.rows.map {
                            TodoCacheRow(
                                todoId = it.id,
                                owner = it.owner,
                                title = it.title,
                                done = it.done,
                                flagged = it.flagged,
                                project = it.project,
                                area = it.area,
                                due = it.due,
                                updatedAtMs = clock(),
                                sourceFile = it.owner.key,
                            )
                        },
                    fetchedAtMs = clock(),
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            ConvexResult.Unauthorized -> dao.markUnauthorized(key, clock())
            else -> Unit
        }
    }

    private suspend fun refreshBtcBuys(viewer: FamilyMember) {
        val key = CacheQueryKeys.btcBuys(viewer.key, RowVisibilityScope.VISIBLE.cacheKey)
        when (val result = remote.listBtcBuys(viewer, RowVisibilityScope.VISIBLE)) {
            is ConvexResult.Ok ->
                dao.replaceBtcBuys(
                    queryKey = key,
                    rows =
                        result.value.rows.map {
                            BtcBuyCacheRow(
                                sourceFile = it.owner.key,
                                buyId = it.id,
                                owner = it.owner,
                                date = it.date,
                                month = it.date.take(7),
                                source = it.source,
                                sats = it.sats,
                                priceUsdCents = it.priceUsdCents,
                                usdCents = it.usdCents,
                                costBasisStatus = it.costBasisStatus,
                                updatedAtMs = clock(),
                            )
                        },
                    fetchedAtMs = clock(),
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            ConvexResult.Unauthorized -> dao.markUnauthorized(key, clock())
            else -> Unit
        }
    }

    private suspend fun refreshBtcAccounts(viewer: FamilyMember) {
        val key = CacheQueryKeys.btcAccounts(viewer.key, RowVisibilityScope.VISIBLE.cacheKey)
        when (val result = remote.listBtcAccounts(viewer, RowVisibilityScope.VISIBLE)) {
            is ConvexResult.Ok ->
                dao.replaceBtcAccounts(
                    queryKey = key,
                    rows =
                        result.value.rows.map {
                            BtcAccountCacheRow(
                                owner = it.owner,
                                accountKey = it.key,
                                label = it.label,
                                custody = it.custody.key,
                                sats = it.sats,
                                fiatCents = it.fiatCents,
                                asOf = "",
                                schemaVersion = 0L,
                                sourceFile = it.owner.key,
                                updatedAtMs = clock(),
                            )
                        },
                    fetchedAtMs = clock(),
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            ConvexResult.Unauthorized -> dao.markUnauthorized(key, clock())
            else -> Unit
        }
    }
}

private val RowVisibilityScope.cacheKey: String
    get() =
        when (this) {
            RowVisibilityScope.VISIBLE -> "visible"
            RowVisibilityScope.NET_WORTH -> "netWorth"
        }

private fun RowSnapshot<*>.expectedCount(): Long? = if (complete) rows.size.toLong() else null

private fun <T> cachedSlice(
    rows: List<T>,
    snapshot: QuerySnapshotEntity?,
    source: String,
): Slice<List<T>> {
    val freshness =
        when {
            snapshot == null -> Freshness.EMPTY
            snapshot.authorization == SnapshotAuthorization.UNAUTHORIZED ||
                snapshot.freshness == SnapshotFreshness.STALE_AUTH -> Freshness.STALE
            else -> Freshness.LIVE
        }
    return Slice(freshness, rows, snapshot?.activatedAtMs, source)
}

private fun CachedTransactionEntity.toDomain() =
    Transaction(transactionId, date, merchant, amountCents, category, card, note, owner)

private fun CachedTodoEntity.toDomain() =
    TodoItem(todoId, title, done, project, area, due, flagged, owner)

private fun CachedBtcBuyEntity.toDomain() =
    BtcBuy(buyId, date, source, sats, priceUsdCents, usdCents, costBasisStatus, owner)

private fun CachedBtcAccountEntity.toDomain() =
    BtcAccount(
        accountKey,
        label,
        requireNotNull(Custody.entries.firstOrNull { it.key == custody }) {
            "Unknown cached custody: $custody"
        },
        sats,
        fiatCents,
        owner,
    )
