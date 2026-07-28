package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BudgetIncome
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.ReadModel
import com.sats21m.vogelvault.domain.Slice
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * Builds the UI read model from bounded public row queries.
 *
 * Every call deliberately omits `limit`, which requests a complete replacement
 * snapshot. An incomplete response is rejected rather than rendered as if it
 * were the whole ledger.
 */
class RowReadModelLoader(
    private val repository: RowQueryRepository,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    suspend fun load(viewer: FamilyMember): ReadModel = coroutineScope {
        val transactions = async { repository.listTransactions(viewer) }
        val todos = async { repository.listTodos(viewer) }
        // VISIBLE is intentional for the oversight surfaces. Net-worth totals
        // are narrowed again by sharesNetWorthWith in the domain/UI.
        val btcBuys = async {
            repository.listBtcBuys(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val btcAccounts = async {
            repository.listBtcAccounts(viewer, scope = RowVisibilityScope.VISIBLE)
        }
        val budget = async {
            repository.getBudgetDocument(viewer, scope = BudgetQueryScope.NET_WORTH)
        }

        val stamp = nowMillis()
        val transactionSlice = transactions.await().toSlice(
            emptyList(),
            "Convex rows · transactions",
            stamp,
        )
        val todoSlice = todos.await().toSlice(emptyList(), "Convex rows · todos", stamp)
        val buySlice = btcBuys.await().toSlice(emptyList(), "Convex rows · bitcoin buys", stamp)
        val accountSlice =
            btcAccounts.await().toSlice(emptyList(), "Convex rows · bitcoin accounts", stamp)
        val budgetSlice = budget.await().toBudgetSlice(stamp)
        val latestBuy = buySlice.value.maxByOrNull { it.date }

        ReadModel(
            transactions = transactionSlice,
            budget = budgetSlice,
            btcAccounts = accountSlice,
            btcBuys = buySlice,
            todos = todoSlice,
            // Public account rows already carry their exact fiat valuation, but
            // the current ReadModel asks for a price. The newest buy is the only
            // exact integer-cent price exposed by this API. It is explicitly
            // dated so the UI cannot present it as live; zero is the honest
            // answer when there are no buys.
            btcPriceCents = latestBuy?.priceUsdCents ?: 0L,
            btcPriceAsOf = latestBuy?.date,
        )
    }
}

private fun BudgetDocumentRow.toDomain(): Budget = Budget(
    month = month,
    categories = categories.map { BudgetCategory(it.name, it.budgetCents, spentCents = 0L) },
    income = income?.let {
        BudgetIncome(
            weeklyGrossCents = it.weeklyGrossCents,
            monthlyGrossCents = it.monthlyGrossCents,
            mtdIncomeCents = it.mtdIncomeCents,
            ytdIncomeCents = it.ytdIncomeCents,
            payFrequency = it.payFrequency,
        )
    },
    strategyNote = strategyNote,
    owner = owner,
)

private fun ConvexResult<BudgetDocumentSnapshot>.toBudgetSlice(stamp: Long): Slice<Budget?> =
    when (this) {
        is ConvexResult.Ok -> when {
            !value.complete -> errorSlice(null, "Convex rows · budget")
            value.document == null -> emptySlice(null, "Convex rows · budget")
            else -> liveSlice(value.document.toDomain(), "Convex rows · budget", stamp)
        }
        ConvexResult.Missing -> emptySlice(null, "Convex rows · budget")
        else -> errorSlice(null, "Convex rows · budget")
    }

private fun <T> ConvexResult<RowSnapshot<T>>.toSlice(
    empty: List<T>,
    source: String,
    stamp: Long,
): Slice<List<T>> = when (this) {
    is ConvexResult.Ok -> when {
        !value.complete -> errorSlice(empty, source)
        value.rows.isEmpty() -> emptySlice(empty, source)
        else -> liveSlice(value.rows, source, stamp)
    }
    ConvexResult.Missing -> emptySlice(empty, source)
    else -> errorSlice(empty, source)
}

private fun <T> liveSlice(value: T, source: String, stamp: Long): Slice<T> =
    Slice(Freshness.LIVE, value, stamp, source)

private fun <T> emptySlice(value: T, source: String): Slice<T> =
    Slice(Freshness.EMPTY, value, null, source)

private fun <T> errorSlice(value: T, source: String): Slice<T> =
    Slice(Freshness.ERROR, value, null, source)
