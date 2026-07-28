package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking

class RowReadModelLoaderTest {
    @Test
    fun `loader names visible BTC scope and preserves negative projected spend`() = runBlocking {
        val repository = FakeRows(
            transactions = ok(
                Transaction(
                    id = "spend",
                    date = "2026-07-20",
                    merchant = "Purchase",
                    amount = 2_500L,
                    category = "Groceries",
                    owner = FamilyMember.VICTOR,
                    spendAmount = -2_500L,
                    displaySpendAmount = 2_500L,
                ),
            ),
            budget = ConvexResult.Ok(
                BudgetDocumentSnapshot(
                    BudgetDocumentRow(
                        owner = FamilyMember.VICTOR,
                        month = "2026-07",
                        coinbaseOneBalanceCents = 0L,
                        categories = listOf(BudgetCategoryRow("Groceries", null, 50_000L)),
                        effectiveApr = null,
                        strategyNote = null,
                        income = null,
                        mtdIncomeCents = 0L,
                        ytdIncomeCents = 0L,
                        monthlyHistory = emptyList(),
                        updatedAtMs = 123L,
                    ),
                    complete = true,
                ),
            ),
            buys = ok(
                BtcBuy(
                    id = "buy",
                    date = "2026-07-19",
                    source = "DCA",
                    sats = 1_000L,
                    priceUsdCents = 9_500_000L,
                    usdCents = 95L,
                    owner = FamilyMember.VICTOR,
                ),
            ),
            accounts = ok(
                BtcAccount(
                    key = "adult",
                    label = "Adult",
                    custody = Custody.SELF_CUSTODY,
                    sats = 1_000L,
                    fiatCents = 95L,
                    owner = FamilyMember.VICTOR,
                ),
                BtcAccount(
                    key = "child",
                    label = "Child",
                    custody = Custody.EXCHANGE,
                    sats = 500L,
                    fiatCents = 48L,
                    owner = FamilyMember.MASON,
                ),
            ),
        )

        val model = RowReadModelLoader(repository) { 456L }.load(FamilyMember.VICTOR)
        val budget = requireNotNull(model.budget.value)
        val spend = deriveBudgetSpend(
            budget,
            model.transactions.value.budgetTransactionsFor(FamilyMember.VICTOR),
        )

        assertEquals(-2_500L, spend.actualCents)
        assertEquals(-2_500L, model.transactions.value.single().spendAmount)
        assertEquals(2_500L, model.transactions.value.single().displaySpendAmount)
        assertEquals(true, model.transactions.value.single().hasOppositeSpendSign)
        assertEquals(RowVisibilityScope.VISIBLE, repository.buyScope)
        assertEquals(RowVisibilityScope.VISIBLE, repository.accountScope)
        assertEquals(BudgetQueryScope.NET_WORTH, repository.budgetScope)
        assertEquals(2, model.btcAccounts.value.size, "visible child rows stay available for oversight")
        assertEquals(9_500_000L, model.btcPriceCents)
    }

    @Test
    fun `empty row tables produce honest empty slices`() = runBlocking {
        val model = RowReadModelLoader(FakeRows()) { 456L }.load(FamilyMember.MASON)

        assertEquals(Freshness.EMPTY, model.transactions.status)
        assertEquals(Freshness.EMPTY, model.btcAccounts.status)
        assertEquals(Freshness.EMPTY, model.budget.status)
        assertEquals(emptyList(), model.transactions.value)
        assertEquals(null, model.budget.value)
        assertEquals(0L, model.btcPriceCents)
    }

    @Test
    fun `absent row queries degrade to error slices without fixture figures`() = runBlocking {
        val unavailable = ConvexResult.Failed("convex error")
        val model = RowReadModelLoader(
            FakeRows(
                transactions = unavailable,
                todos = unavailable,
                buys = unavailable,
                accounts = unavailable,
                budget = unavailable,
            ),
        ).load(FamilyMember.VICTOR)

        assertEquals(Freshness.ERROR, model.transactions.status)
        assertEquals(Freshness.ERROR, model.budget.status)
        assertEquals(emptyList(), model.transactions.value)
        assertEquals(null, model.budget.value)
    }

    private fun <T> ok(vararg rows: T): ConvexResult<RowSnapshot<T>> =
        ConvexResult.Ok(RowSnapshot(rows.toList(), complete = true))
}

private class FakeRows(
    private val transactions: ConvexResult<RowSnapshot<Transaction>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val todos: ConvexResult<RowSnapshot<TodoItem>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val buys: ConvexResult<RowSnapshot<BtcBuy>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val accounts: ConvexResult<RowSnapshot<BtcAccount>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val budget: ConvexResult<BudgetDocumentSnapshot> =
        ConvexResult.Ok(BudgetDocumentSnapshot(null, true)),
) : RowQueryRepository {
    var buyScope: RowVisibilityScope? = null
    var accountScope: RowVisibilityScope? = null
    var budgetScope: BudgetQueryScope? = null

    override suspend fun listTransactions(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ) = transactions

    override suspend fun listTodos(
        viewer: FamilyMember,
        done: Boolean?,
        limit: Int?,
    ) = todos

    override suspend fun listBtcBuys(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBuy>> {
        buyScope = scope
        return buys
    }

    override suspend fun listBtcBillPays(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true))

    override suspend fun listBtcAccounts(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
        limit: Int?,
    ): ConvexResult<RowSnapshot<BtcAccount>> {
        accountScope = scope
        return accounts
    }

    override suspend fun getBudgetDocument(
        viewer: FamilyMember,
        scope: BudgetQueryScope,
    ): ConvexResult<BudgetDocumentSnapshot> {
        budgetScope = scope
        return budget
    }

    override suspend fun getBtcSnapshotMetadata(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcSnapshotMetadataRow>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true))

    override suspend fun rowCounts(): ConvexResult<RowCounts> =
        ConvexResult.Ok(
            RowCounts(
                transactions = 0,
                todos = 0,
                btcBuys = 0,
                btcBillPays = 0,
                btcAccounts = 0,
                income = 0,
                balanceDocuments = 0,
                budgetDocuments = 0,
                btcBalanceDocuments = 0,
                financeDocuments = 0,
            ),
        )
}
