package com.sats21m.vogelvault.data.cache

import com.sats21m.vogelvault.data.ConvexResult
import com.sats21m.vogelvault.data.BtcBillPayRow
import com.sats21m.vogelvault.data.BtcBalanceDocumentRow
import com.sats21m.vogelvault.data.BtcSnapshotMetadataRow
import com.sats21m.vogelvault.data.BudgetDocumentSnapshot
import com.sats21m.vogelvault.data.BudgetQueryScope
import com.sats21m.vogelvault.data.ConvexConfig
import com.sats21m.vogelvault.data.ConvexConfigSource
import com.sats21m.vogelvault.data.RowCounts
import com.sats21m.vogelvault.data.IncomeRow
import com.sats21m.vogelvault.data.RowQueryRepository
import com.sats21m.vogelvault.data.RowReadModelLoader
import com.sats21m.vogelvault.data.RowSnapshot
import com.sats21m.vogelvault.data.RowVisibilityScope
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FiatValuation
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine

data class CachedReadModel(
    val data: ReadModel,
    val staleAuthorization: Boolean,
)

data class LoadedReadModel(
    val data: ReadModel,
    val unauthorized: Boolean,
)

/**
 * Composes the direct row loader with stale-tolerant Room snapshots.
 *
 * The loader receives the original Convex results and therefore remains the
 * live source of truth. Its repository decorator stores each complete success
 * and invalidates the matching Room generation on authorization rejection.
 * Room observations are always marked stale because they are only a fallback,
 * never proof that a network read just succeeded.
 */
class CachedRowDataSource(
    private val remote: RowQueryRepository,
    private val dao: VaultCacheDao,
    private val clock: () -> Long = System::currentTimeMillis,
    private val configSource: ConvexConfigSource? = null,
    private val onUnauthorized: (ConvexConfig) -> Boolean = { false },
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
                        transactions = tx.slice,
                        budget = Slice(Freshness.EMPTY, null, null, "Convex rows · budget not cached"),
                        btcAccounts = accounts.slice,
                        btcBuys = buys.slice,
                        todos = task.slice,
                        // Snapshot metadata/price is outside the Room cache landed in #58.
                        btcPriceCents = 0L,
                    ),
                staleAuthorization = slices.any { it.unauthorized },
            )
        }
    }

    suspend fun load(viewer: FamilyMember): LoadedReadModel {
        val first = loadOnce(viewer)
        return if (first.retryWithFallback) {
            loadOnce(viewer).loaded
        } else {
            first.loaded
        }
    }

    private suspend fun loadOnce(viewer: FamilyMember): LoadAttempt {
        val unauthorized = AtomicBoolean(false)
        val rejectionHandled = AtomicBoolean(false)
        val retryWithFallback = AtomicBoolean(false)
        val requestConfig = configSource?.current()
        val cachingRepository =
            CachingRowQueryRepository(
                remote = remote,
                dao = dao,
                clock = clock,
                onUnauthorized = {
                    unauthorized.set(true)
                    if (requestConfig != null && rejectionHandled.compareAndSet(false, true)) {
                        retryWithFallback.set(onUnauthorized(requestConfig))
                    }
                },
            )
        val data = RowReadModelLoader(cachingRepository, clock).load(viewer)
        return LoadAttempt(
            loaded = LoadedReadModel(data, unauthorized.get()),
            retryWithFallback = retryWithFallback.get(),
        )
    }
}

private data class LoadAttempt(
    val loaded: LoadedReadModel,
    val retryWithFallback: Boolean,
)

private class CachingRowQueryRepository(
    private val remote: RowQueryRepository,
    private val dao: VaultCacheDao,
    private val clock: () -> Long,
    private val onUnauthorized: () -> Unit,
) : RowQueryRepository {
    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<Transaction>> {
        val result = remote.listTransactions(viewer, month, limit)
        val key = CacheQueryKeys.transactions(viewer.key)
        when (result) {
            is ConvexResult.Ok -> {
                val stamp = clock()
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
                                updatedAtMs = stamp,
                            )
                        },
                    fetchedAtMs = stamp,
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            }
            ConvexResult.Unauthorized -> markUnauthorized(key)
            else -> Unit
        }
        return result
    }

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<TodoItem>> {
        val result = remote.listTodos(viewer, done, limit)
        val key = CacheQueryKeys.todos(viewer.key)
        when (result) {
            is ConvexResult.Ok -> {
                val stamp = clock()
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
                                updatedAtMs = stamp,
                                sourceFile = it.owner.key,
                            )
                        },
                    fetchedAtMs = stamp,
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            }
            ConvexResult.Unauthorized -> markUnauthorized(key)
            else -> Unit
        }
        return result
    }

    override suspend fun listIncome(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<IncomeRow>> =
        reportUnauthorized(remote.listIncome(viewer, month, limit))

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> {
        val result = remote.listBtcBuys(viewer, scope, month, limit)
        val key = CacheQueryKeys.btcBuys(viewer.key, scope.cacheKey)
        when (result) {
            is ConvexResult.Ok -> {
                val stamp = clock()
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
                                updatedAtMs = stamp,
                            )
                        },
                    fetchedAtMs = stamp,
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            }
            ConvexResult.Unauthorized -> markUnauthorized(key)
            else -> Unit
        }
        return result
    }

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> {
        val result = remote.listBtcAccounts(viewer, scope, limit)
        val key = CacheQueryKeys.btcAccounts(viewer.key, scope.cacheKey)
        when (result) {
            is ConvexResult.Ok -> {
                val stamp = clock()
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
                                fiatAvailable = it.fiatValuation != null,
                                fiatPriceCents = it.fiatValuation?.priceCents,
                                fiatQuotedAt = it.fiatValuation?.quotedAt,
                                fiatSource = it.fiatValuation?.source,
                                fiatConfidence = it.fiatValuation?.confidence,
                                asOf = "",
                                schemaVersion = 0L,
                                sourceFile = it.owner.key,
                                updatedAtMs = stamp,
                            )
                        },
                    fetchedAtMs = stamp,
                    expectedRowCount = result.value.expectedCount(),
                    receivedComplete = result.value.complete,
                )
            }
            ConvexResult.Unauthorized -> markUnauthorized(key)
            else -> Unit
        }
        return result
    }

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> =
        reportUnauthorized(remote.listBtcBillPays(viewer, scope, month, limit))

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> =
        reportUnauthorized(remote.getBudgetDocument(viewer, scope))

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> =
        reportUnauthorized(remote.getBtcSnapshotMetadata(viewer, scope))

    override suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> =
        reportUnauthorized(remote.listBtcBalanceDocuments(viewer, scope))

    override suspend fun rowCounts(): ConvexResult<RowCounts> =
        reportUnauthorized(remote.rowCounts())

    private suspend fun markUnauthorized(queryKey: String) {
        onUnauthorized()
        dao.markUnauthorized(queryKey, clock())
    }

    private fun <T> reportUnauthorized(result: ConvexResult<T>): ConvexResult<T> {
        if (result === ConvexResult.Unauthorized) onUnauthorized()
        return result
    }
}

private val RowVisibilityScope.cacheKey: String
    get() =
        when (this) {
            RowVisibilityScope.VISIBLE -> "visible"
            RowVisibilityScope.NET_WORTH -> "netWorth"
        }

private fun RowSnapshot<*>.expectedCount(): Long? = if (complete) rows.size.toLong() else null

private data class CachedSlice<T>(
    val slice: Slice<List<T>>,
    val unauthorized: Boolean,
)

private fun <T> cachedSlice(
    rows: List<T>,
    snapshot: QuerySnapshotEntity?,
    source: String,
): CachedSlice<T> {
    val unauthorized =
        snapshot?.authorization == SnapshotAuthorization.UNAUTHORIZED ||
            snapshot?.freshness == SnapshotFreshness.STALE_AUTH
    val freshness =
        when {
            snapshot == null -> Freshness.EMPTY
            else -> Freshness.STALE
        }
    return CachedSlice(
        slice = Slice(freshness, rows, snapshot?.activatedAtMs, "$source · cached"),
        unauthorized = unauthorized,
    )
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
        fiatValuation = if (fiatAvailable) {
            FiatValuation(
                cents = fiatCents,
                priceCents = fiatPriceCents,
                quotedAt = fiatQuotedAt,
                source = fiatSource,
                confidence = fiatConfidence,
            )
        } else {
            null
        },
    )
