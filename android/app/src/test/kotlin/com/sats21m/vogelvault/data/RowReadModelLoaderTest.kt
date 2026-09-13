package com.sats21m.vogelvault.data

import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBuy
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.TodoItem
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.domain.budgetTransactionsFor
import com.sats21m.vogelvault.domain.deriveBudgetSpend
import com.sats21m.vogelvault.ui.VaultUiState
import java.util.logging.Handler
import java.util.logging.LogRecord
import java.util.logging.Logger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class RowReadModelLoaderTest {
    @Test fun `transfer slices distinguish empty complete incomplete and failed reads`() = runBlocking {
        val empty = RowReadModelLoader(FakeRows()).load(FamilyMember.VICTOR)
        assertEquals(Freshness.LIVE, empty.btcTransfers.status)
        val incomplete = RowReadModelLoader(FakeRows(transfers = ConvexResult.Ok(RowSnapshot(emptyList(), false))))
            .load(FamilyMember.VICTOR)
        assertEquals(Freshness.ERROR, incomplete.btcTransfers.status)
        val failed = RowReadModelLoader(FakeRows(transfers = ConvexResult.Unauthorized)).load(FamilyMember.VICTOR)
        assertEquals(Freshness.ERROR, failed.btcTransfers.status)
        assertEquals(true, failed.rowReadDiagnostics.any { it.projection == RowReadProjection.BITCOIN_TRANSFERS })
    }

    @Test
    fun `English and canonical budget months derive the correct non-zero June actuals`() = runBlocking {
        for (wireMonth in listOf("June 2026", "2026-06")) {
            val repository = FakeRows(
                transactions = ok(
                    Transaction(
                        id = "june-spend",
                        date = "2026-06-18",
                        merchant = "Grocer",
                        amount = 12_345L,
                        category = "Groceries",
                        owner = FamilyMember.VICTOR,
                    ),
                ),
                budget = ConvexResult.Ok(
                    BudgetDocumentSnapshot(budgetDocument(wireMonth), complete = true),
                ),
            )

            val model = RowReadModelLoader(repository) { 456L }.load(FamilyMember.VICTOR)
            val adaptedBudget = requireNotNull(model.budget.value)
            val actual = requireNotNull(
                deriveBudgetSpend(
                    adaptedBudget,
                    model.transactions.value.budgetTransactionsFor(FamilyMember.VICTOR),
                ),
            ).actualCents

            assertEquals(Freshness.LIVE, model.budget.status, wireMonth)
            assertEquals(12_345L, actual, wireMonth)
            assertEquals("2026-06", adaptedBudget.month, wireMonth)
        }
    }

    @Test
    fun `unparseable budget month makes required figures unavailable instead of zero`() = runBlocking {
        val repository = FakeRows(
            transactions = ok(
                Transaction(
                    id = "june-spend",
                    date = "2026-06-18",
                    merchant = "Grocer",
                    amount = 12_345L,
                    category = "Groceries",
                    owner = FamilyMember.VICTOR,
                ),
            ),
            budget = ConvexResult.Ok(
                BudgetDocumentSnapshot(budgetDocument("Juny 2026"), complete = true),
            ),
        )

        val model = RowReadModelLoader(repository) { 456L }.load(FamilyMember.VICTOR)
        assertEquals(Freshness.ERROR, model.budget.status)
        assertTrue(model.budget.requiredProjectionUnavailable)
        assertNull(model.budget.value)
        val actual = model.budget.value?.let {
            deriveBudgetSpend(
                it,
                model.transactions.value.budgetTransactionsFor(FamilyMember.VICTOR),
            )?.actualCents
        }
        assertNull(actual)
        assertNotEquals(0L, actual)
    }

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
    fun `production BTC balance stays live while fiat is unavailable`() = runBlocking {
        val repository = FakeRows(
            balanceDocuments = ok(
                BtcBalanceDocumentRow(
                    owner = FamilyMember.VICTOR,
                    schemaVersion = 2L,
                    asOf = "2026-07-16T01:56:49Z",
                    accounts = listOf(
                        BtcBalanceAccountRow(
                            key = "cold",
                            label = "Cold storage",
                            custody = Custody.SELF_CUSTODY,
                            sats = 541_782_856L,
                            fiatCents = 0L,
                        ),
                    ),
                    totals = BtcBalanceTotalsRow(
                        sats = 541_782_856L,
                        fiatCents = 0L,
                        exchangeSats = 0L,
                        selfCustodySats = 541_782_856L,
                    ),
                    source = "authoritative reconciliation",
                    basis = "self-custody screenshot",
                    confidence = "high",
                    updatedAtMs = 102L,
                ),
            ),
        )

        val model = RowReadModelLoader(repository) { 456L }.load(FamilyMember.RACHEL)

        assertEquals(Freshness.LIVE, model.btcBalance.status)
        assertEquals(541_782_856L, model.btcBalance.value?.totalSats)
        assertTrue(model.btcFiatFiguresUnavailable)
        assertNull(model.btcBalance.value?.fiatValuation)
        assertEquals("high", model.btcBalance.value?.balanceConfidence)
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
                        categories = listOf(BudgetCategoryRow("Groceries", "cart", 50_000L)),
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
        val spend = requireNotNull(
            deriveBudgetSpend(
                budget,
                model.transactions.value.budgetTransactionsFor(FamilyMember.VICTOR),
            ),
        )

        assertEquals(-2_500L, spend.actualCents)
        assertEquals("cart", budget.categories.single().icon)
        assertEquals("cart", spend.categories.single().icon)
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
        assertEquals(Freshness.LIVE, model.income.status)
        assertEquals(Freshness.EMPTY, model.btcBalance.status)
        assertEquals(Freshness.LIVE, model.btcBillPays.status)
        assertEquals(false, model.incomeFiguresUnavailable)
        assertEquals(true, model.netWorthFiguresUnavailable)
        assertEquals(false, model.billPayLedgerUnavailable)
        assertEquals(false, model.todos.suppressFigures, "zero todos remains countable")
        assertEquals(Freshness.EMPTY, model.budget.status)
        assertEquals(emptyList(), model.transactions.value)
        assertEquals(null, model.budget.value)
        assertEquals(0L, model.btcPriceCents)
        assertEquals(null, model.btcPriceAsOf)
    }

    @Test
    fun `complete empty transaction snapshot is a usable true zero`() = runBlocking {
        val model = RowReadModelLoader(
            FakeRows(
                transactions = ConvexResult.Ok(RowSnapshot(emptyList(), complete = true)),
            ),
        ) { 456L }.load(FamilyMember.VICTOR)

        assertEquals(Freshness.LIVE, model.transactions.status)
        assertEquals(emptyList(), model.transactions.value)
        assertEquals(false, model.transactions.requiredProjectionUnavailable)
        assertEquals(456L, model.transactions.updatedAt)
    }

    @Test
    fun `complete empty bill-pay response stays live for budget actuals`() = runBlocking {
        val model = RowReadModelLoader(
            FakeRows(
                transactions = ok(
                    Transaction(
                        id = "june-spend",
                        date = "2026-06-18",
                        merchant = "Grocer",
                        amount = 12_345L,
                        category = "Groceries",
                        owner = FamilyMember.VICTOR,
                    ),
                ),
                budget = ConvexResult.Ok(
                    BudgetDocumentSnapshot(budgetDocument("2026-06"), complete = true),
                ),
                billPays = ConvexResult.Ok(RowSnapshot(emptyList(), complete = true)),
            ),
        ) { 456L }.load(FamilyMember.VICTOR)

        assertEquals(Freshness.LIVE, model.btcBillPays.status)
        assertEquals(emptyList(), model.btcBillPays.value)
        assertFalse(model.budgetActualsUnavailable)
        val spend = requireNotNull(
            deriveBudgetSpend(
                requireNotNull(model.budget.value),
                model.transactions.value.budgetTransactionsFor(FamilyMember.VICTOR),
                model.btcBillPays.value,
            ),
        )
        assertEquals(12_345L, spend.actualCents)
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

    @Test
    fun `loader preserves each remote failure cause through the read model`() = runBlocking {
        val cases: List<
            Pair<ConvexResult<RowSnapshot<Transaction>>, RowReadFailure>,
        > = listOf(
            ConvexResult.Unauthorized to RowReadFailure.UNAUTHORIZED,
            ConvexResult.Disabled to RowReadFailure.DISABLED,
            ConvexResult.NotConfigured to RowReadFailure.NOT_CONFIGURED,
            ConvexResult.Failed(ConvexFailure.Transport) to
                RowReadFailure.TRANSPORT,
            ConvexResult.Failed(ConvexFailure.Http(503)) to RowReadFailure.HTTP,
            ConvexResult.Failed(ConvexFailure.DeploymentMisconfigured) to
                RowReadFailure.DEPLOYMENT_MISCONFIGURED,
            ConvexResult.Failed(ConvexFailure.ServerRejected()) to
                RowReadFailure.SERVER_REJECTED,
            ConvexResult.Failed(ConvexFailure.InvalidResponse) to
                RowReadFailure.MALFORMED_PAYLOAD,
        )

        for ((result, expected) in cases) {
            val model = RowReadModelLoader(FakeRows(transactions = result)).load(
                FamilyMember.VICTOR,
            )

            assertEquals(Freshness.ERROR, model.transactions.status)
            assertEquals(setOf(expected), model.rowReadFailures)
            assertEquals(
                setOf(RowReadDiagnostic(RowReadProjection.TRANSACTIONS, expected)),
                model.rowReadDiagnostics,
            )
            assertTrue(model.transactions.source.endsWith("failure=${expected.sourceTag}"))
            assertTrue("SocketTimeoutException" !in model.transactions.source)
        }
    }

    @Test
    fun `one failed projection does not hide or implicate successful slices`() = runBlocking {
        val model = RowReadModelLoader(
            FakeRows(transactions = ConvexResult.Failed(ConvexFailure.Http(503))),
        ).load(FamilyMember.VICTOR)

        assertEquals(Freshness.ERROR, model.transactions.status)
        assertEquals(Freshness.EMPTY, model.todos.status)
        assertEquals(
            setOf(RowReadDiagnostic(RowReadProjection.TRANSACTIONS, RowReadFailure.HTTP)),
            model.rowReadDiagnostics,
        )
    }

    @Test
    fun `incomplete successful payload is rejected as malformed`() = runBlocking {
        val model = RowReadModelLoader(
            FakeRows(
                transactions = ConvexResult.Ok(RowSnapshot(emptyList(), complete = false)),
            ),
        ).load(FamilyMember.VICTOR)

        assertEquals(Freshness.ERROR, model.transactions.status)
        assertEquals(setOf(RowReadFailure.MALFORMED_PAYLOAD), model.rowReadFailures)
        assertEquals(emptyList(), model.transactions.value)
    }

    @Test
    fun `diagnostic log identifies projection and cause without repository detail`() = runBlocking {
        val messages = mutableListOf<String>()
        val logger = Logger.getLogger(RowReadModelLoader::class.java.name)
        val handler = object : Handler() {
            override fun publish(record: LogRecord) {
                messages += record.message
            }

            override fun flush() = Unit

            override fun close() = Unit
        }
        logger.addHandler(handler)

        try {
            RowReadModelLoader(
                FakeRows(
                    transactions =
                        ConvexResult.Failed(ConvexFailure.Transport),
                ),
            ).load(FamilyMember.VICTOR)
        } finally {
            logger.removeHandler(handler)
        }

        assertTrue(
            messages.any {
                "projection=transactions" in it && "cause=TRANSPORT" in it
            },
        )
        assertTrue(messages.none { "IOException" in it })
    }

    @Test
    fun `ui state maps every diagnosis to specific user copy`() = runBlocking {
        val cases: List<
            Pair<ConvexResult<RowSnapshot<Transaction>>, Pair<Int, Int>>,
        > = listOf(
            ConvexResult.Unauthorized to
                Pair(
                    R.string.convex_row_failure_unauthorized_title,
                    R.string.convex_row_failure_unauthorized_detail,
                ),
            ConvexResult.Disabled to
                Pair(
                    R.string.convex_row_failure_disabled_title,
                    R.string.convex_row_failure_disabled_detail,
                ),
            ConvexResult.NotConfigured to
                Pair(
                    R.string.convex_row_failure_not_configured_title,
                    R.string.convex_row_failure_not_configured_detail,
                ),
            ConvexResult.Failed(ConvexFailure.Transport) to
                Pair(
                    R.string.convex_row_failure_transport_title,
                    R.string.convex_row_failure_transport_detail,
                ),
            ConvexResult.Failed(ConvexFailure.Http(503)) to
                Pair(
                    R.string.convex_row_failure_http_title,
                    R.string.convex_row_failure_http_detail,
                ),
            ConvexResult.Failed(ConvexFailure.DeploymentMisconfigured) to
                Pair(
                    R.string.convex_row_failure_deployment_misconfigured_title,
                    R.string.convex_row_failure_deployment_misconfigured_detail,
                ),
            ConvexResult.Failed(ConvexFailure.ServerRejected()) to
                Pair(
                    R.string.convex_row_failure_server_rejected_title,
                    R.string.convex_row_failure_server_rejected_detail,
                ),
            ConvexResult.Failed(ConvexFailure.MalformedResponse) to
                Pair(
                    R.string.convex_row_failure_malformed_payload_title,
                    R.string.convex_row_failure_malformed_payload_detail,
                ),
        )

        for ((result, expectedResources) in cases) {
            val model = RowReadModelLoader(FakeRows(transactions = result)).load(
                FamilyMember.VICTOR,
            )
            val state = VaultUiState(data = model)

            assertEquals(expectedResources.first, state.rowReadFailureTitleRes)
            assertEquals(expectedResources.second, state.rowReadFailureDetailRes)
            assertEquals(R.string.convex_projection_transactions, state.rowReadFailureProjectionRes)
        }
    }

    private fun <T> ok(vararg rows: T): ConvexResult<RowSnapshot<T>> =
        ConvexResult.Ok(RowSnapshot(rows.toList(), complete = true))

    private fun budgetDocument(month: String) = BudgetDocumentRow(
        owner = FamilyMember.VICTOR,
        month = month,
        coinbaseOneBalanceCents = 0L,
        categories = listOf(BudgetCategoryRow("Groceries", null, 50_000L)),
        effectiveApr = null,
        strategyNote = null,
        income = null,
        mtdIncomeCents = 0L,
        ytdIncomeCents = 0L,
        monthlyHistory = emptyList(),
        updatedAtMs = 123L,
    )
}

private class FakeRows(
    private val transactions: ConvexResult<RowSnapshot<Transaction>> =
        ConvexResult.Missing,
    private val todos: ConvexResult<RowSnapshot<TodoItem>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val buys: ConvexResult<RowSnapshot<BtcBuy>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val accounts: ConvexResult<RowSnapshot<BtcAccount>> =
        ConvexResult.Ok(RowSnapshot(emptyList(), true)),
    private val transfers: ConvexResult<RowSnapshot<com.sats21m.vogelvault.domain.BtcTransfer>> =
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

    override suspend fun listBtcTransfers(
        viewer: FamilyMember, scope: RowVisibilityScope, month: String?, limit: Int?,
    ): ConvexResult<RowSnapshot<com.sats21m.vogelvault.domain.BtcTransfer>> = transfers

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
