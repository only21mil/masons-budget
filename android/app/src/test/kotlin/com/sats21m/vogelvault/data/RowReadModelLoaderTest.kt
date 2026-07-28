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
    fun `loader reaches every required financial projection`() = runBlocking {
        val repository = FakeRows(
            income = ok(
                IncomeRow(
                    id = "income",
                    owner = FamilyMember.VICTOR,
                    date = "2026-07-01",
                    month = "2026-07",
                    amountCents = 3_489_347L,
                    source = "Payroll",
                    loggedBy = null,
                    note = null,
                    archimedesRequestId = null,
                    updatedAtMs = 100L,
                ),
            ),
            billPays = ok(
                BtcBillPayRow(
                    id = "bill-pay",
                    owner = FamilyMember.VICTOR,
                    date = "2026-07-02",
                    month = "2026-07",
                    merchant = "Bills",
                    category = "Utilities",
                    amountUsdCents = 2_563_405L,
                    btcSpentSats = 25_000_000L,
                    btcPriceCents = 10_000_000L,
                    platform = "Strike",
                    note = null,
                    feeUsdCents = 0L,
                    reference = null,
                    updatedAtMs = 101L,
                ),
            ),
            balanceDocuments = ok(
                BtcBalanceDocumentRow(
                    owner = FamilyMember.VICTOR,
                    schemaVersion = 2L,
                    asOf = "2026-07-16",
                    accounts = listOf(
                        BtcBalanceAccountRow(
                            key = "cold",
                            label = "Cold storage",
                            custody = Custody.SELF_CUSTODY,
                            sats = 1L,
                            fiatCents = 1L,
                        ),
                    ),
                    totals = BtcBalanceTotalsRow(
                        sats = 541_782_856L,
                        fiatCents = 60_000_000L,
                        exchangeSats = 41_782_856L,
                        selfCustodySats = 500_000_000L,
                    ),
                    source = "btc-balance-snapshot",
                    basis = null,
                    confidence = null,
                    updatedAtMs = 102L,
                ),
            ),
        )

        val model = RowReadModelLoader(repository) { 456L }.load(FamilyMember.VICTOR)

        assertEquals(1, repository.incomeReads)
        assertEquals(1, repository.balanceDocumentReads)
        assertEquals(1, repository.billPayReads)
        assertEquals(RowVisibilityScope.NET_WORTH, repository.balanceDocumentScope)
        assertEquals(RowVisibilityScope.VISIBLE, repository.billPayScope)
        assertEquals(3_489_347L, model.income.value.single().amountCents)
        assertEquals(541_782_856L, model.btcBalance.value?.totalSats)
        assertEquals(
            1L,
            model.btcBalance.value?.accounts?.single()?.sats,
            "the headline total must come from document totals, not an account sum",
        )
        assertEquals(2_563_405L, model.btcBillPays.value.single().amountUsdCents)
        assertEquals(Freshness.LIVE, model.income.status)
        assertEquals(Freshness.LIVE, model.btcBalance.status)
        assertEquals(Freshness.LIVE, model.btcBillPays.status)
    }

    @Test
    fun `loader names visible BTC scope and uses signed spend contribution`() = runBlocking {
        val repository = FakeRows(
            transactions = ok(
                Transaction(
                    id = "credit",
                    date = "2026-07-20",
                    merchant = "Refund",
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
        assertEquals("2026-07-19", model.btcPriceAsOf)
    }

    @Test
    fun `empty row tables produce honest empty slices`() = runBlocking {
        val model = RowReadModelLoader(FakeRows()) { 456L }.load(FamilyMember.MASON)

        assertEquals(Freshness.EMPTY, model.transactions.status)
        assertEquals(Freshness.EMPTY, model.btcAccounts.status)
        assertEquals(Freshness.EMPTY, model.income.status)
        assertEquals(Freshness.EMPTY, model.btcBalance.status)
        assertEquals(Freshness.EMPTY, model.btcBillPays.status)
        assertEquals(true, model.incomeFiguresUnavailable)
        assertEquals(true, model.netWorthFiguresUnavailable)
        assertEquals(true, model.billPayLedgerUnavailable)
        assertEquals(false, model.todos.suppressFigures, "zero todos remains countable")
        assertEquals(Freshness.EMPTY, model.budget.status)
        assertEquals(emptyList(), model.transactions.value)
        assertEquals(null, model.budget.value)
        assertEquals(0L, model.btcPriceCents)
        assertEquals(null, model.btcPriceAsOf)
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
    private val income: ConvexResult<RowSnapshot<IncomeRow>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val billPays: ConvexResult<RowSnapshot<BtcBillPayRow>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val balanceDocuments: ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val budget: ConvexResult<BudgetDocumentSnapshot> =
        ConvexResult.Ok(BudgetDocumentSnapshot(null, true)),
) : RowQueryRepository {
    var buyScope: RowVisibilityScope? = null
    var accountScope: RowVisibilityScope? = null
    var budgetScope: BudgetQueryScope? = null
    var incomeReads: Int = 0
    var billPayReads: Int = 0
    var balanceDocumentReads: Int = 0
    var billPayScope: RowVisibilityScope? = null
    var balanceDocumentScope: RowVisibilityScope? = null

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

    override suspend fun listIncome(
        viewer: FamilyMember,
        month: String?,
        limit: Int?,
    ): ConvexResult<RowSnapshot<IncomeRow>> {
        incomeReads += 1
        return income
    }

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
    ): ConvexResult<RowSnapshot<BtcBillPayRow>> {
        billPayReads += 1
        billPayScope = scope
        return billPays
    }

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

    override suspend fun listBtcBalanceDocuments(
        viewer: FamilyMember,
        scope: RowVisibilityScope,
    ): ConvexResult<RowSnapshot<BtcBalanceDocumentRow>> {
        balanceDocumentReads += 1
        balanceDocumentScope = scope
        return balanceDocuments
    }

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
