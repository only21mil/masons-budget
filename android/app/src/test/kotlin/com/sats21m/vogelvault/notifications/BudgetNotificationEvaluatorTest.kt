package com.sats21m.vogelvault.notifications

import com.sats21m.vogelvault.domain.Budget
import com.sats21m.vogelvault.domain.BudgetCategory
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Transaction
import com.sats21m.vogelvault.ui.VaultUiState
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Every suppression case here carries a control that produces a real alert from
 * the same fixture family.
 *
 * A bare `assertTrue(alerts.isEmpty())` passes when the evaluator returns nothing
 * at all, so it cannot tell a working gate from a broken evaluator. The controls
 * below fail in that case, which makes each empty result attributable to the one
 * production line the test names.
 */
class BudgetNotificationEvaluatorTest {
    private val evaluator = BudgetNotificationEvaluator()

    @Test
    fun `rachel receives canonical adult household alert`() {
        val state =
            state(
                viewer = FamilyMember.RACHEL,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("adult", 8_501L, FamilyMember.VICTOR),
                    ),
            )

        val alert = evaluator.evaluate(state).single()

        assertEquals(FamilyMember.VICTOR, alert.owner)
        assertEquals(BudgetAlertLevel.NEARING_LIMIT, alert.level)
        assertEquals(8_501L, alert.spentCents)
        assertEquals(ADULT_GROCERIES_CENTS, alert.budgetCents)
    }

    @Test
    fun `budget-category bill pay participates in thresholds while credit-card payment is excluded`() {
        val budgetPayment = billPay(
            id = "bitcoin-groceries",
            amountCents = 8_501L,
            effect = BillPayBudgetEffect.BUDGET_CATEGORY,
        )
        val withBudgetPayment =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions = emptyList(),
            ).withBillPays(Freshness.LIVE, listOf(budgetPayment))

        val alert = evaluator.evaluate(withBudgetPayment).single()
        assertEquals(BudgetAlertLevel.NEARING_LIMIT, alert.level)
        assertEquals(8_501L, alert.spentCents)

        val creditCardPayment = budgetPayment.copy(
            id = "bitcoin-credit-card-payment",
            amountUsdCents = 99_999L,
            budgetEffect = BillPayBudgetEffect.CREDIT_CARD_PAYMENT,
        )
        assertEquals(
            emptyList(),
            evaluator.evaluate(withBudgetPayment.withBillPays(Freshness.LIVE, listOf(creditCardPayment))),
            "credit-card bill pays are transfers, not budget spend",
        )
    }

    @Test
    fun `failed bill-pay ledger suppresses notification thresholds`() {
        val state =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions = listOf(transaction("ordinary-spend", 8_501L, FamilyMember.VICTOR)),
            ).withBillPays(Freshness.ERROR, emptyList())

        assertEquals(
            emptyList(),
            evaluator.evaluate(state),
            "a failed required ledger must not publish a partial threshold result",
        )
    }

    @Test
    fun `child can never receive an adult budget figure`() {
        // A child's own spend is the only spend a child can see, so it is the only
        // spend that can carry an adult budget figure back to them.
        val masonOverspend = transaction("mason-groceries", 10_001L, FamilyMember.MASON)
        val masonOnAdultBudget =
            state(
                viewer = FamilyMember.MASON,
                budgetOwner = FamilyMember.VICTOR,
                transactions = listOf(masonOverspend),
            )
        val masonOnOwnBudget =
            state(
                viewer = FamilyMember.MASON,
                budgetOwner = FamilyMember.MASON,
                transactions = listOf(masonOverspend),
                groceriesCents = CHILD_GROCERIES_CENTS,
            )
        val maddoxOnAdultBudget =
            state(
                viewer = FamilyMember.MADDOX,
                budgetOwner = FamilyMember.VICTOR,
                transactions = listOf(transaction("maddox-groceries", 10_001L, FamilyMember.MADDOX)),
            )

        // Control: the same overspend does alert against the child's own budget,
        // and reports the child's own figure.
        val own = evaluator.evaluate(masonOnOwnBudget).single()
        assertEquals(FamilyMember.MASON, own.owner)
        assertEquals(BudgetAlertLevel.OVER_LIMIT, own.level)
        assertEquals(CHILD_GROCERIES_CENTS, own.budgetCents)

        assertEquals(
            emptyList(),
            evaluator.evaluate(masonOnAdultBudget),
            "mason must never be handed an adult budget figure",
        )
        assertEquals(
            emptyList(),
            evaluator.evaluate(maddoxOnAdultBudget),
            "maddox must never be handed an adult budget figure",
        )
    }

    @Test
    fun `adult alert excludes child spending from household budget`() {
        val state =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("victor", 8_600L, FamilyMember.VICTOR),
                        transaction("rachel", 400L, FamilyMember.RACHEL),
                        transaction("mason", 3_000L, FamilyMember.MASON),
                        transaction("maddox", 2_000L, FamilyMember.MADDOX),
                    ),
            )

        val alert = evaluator.evaluate(state).single()

        // 8_600 + 400 household, never the 5_000 of child spend Victor can see but
        // does not share. Including it would report 14_000 and cross the limit.
        assertEquals(9_000L, alert.spentCents, "household spend only")
        assertEquals(BudgetAlertLevel.NEARING_LIMIT, alert.level)
        assertEquals(ADULT_GROCERIES_CENTS, alert.budgetCents)
    }

    @Test
    fun `refunds reduce spend before threshold evaluation`() {
        val refundedOverLimit =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("purchase", 12_000L, FamilyMember.VICTOR),
                        transaction("refund", -1_500L, FamilyMember.RACHEL),
                    ),
            )
        val purchaseOnly = adultGroceriesSpend(10_500L)
        val refundedBelowThreshold =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("purchase", 10_500L, FamilyMember.VICTOR),
                        transaction("refund", -2_100L, FamilyMember.RACHEL),
                    ),
            )

        // The published figure is net: dropping the refund reports 12_000, and
        // taking its magnitude reports 13_500.
        val alert = evaluator.evaluate(refundedOverLimit).single()
        assertEquals(10_500L, alert.spentCents)
        assertEquals(BudgetAlertLevel.OVER_LIMIT, alert.level)

        // Control: 10_500 alone is over the limit; the refund is what silences it.
        assertEquals(BudgetAlertLevel.OVER_LIMIT, evaluator.evaluate(purchaseOnly).single().level)
        assertEquals(
            emptyList(),
            evaluator.evaluate(refundedBelowThreshold),
            "a refund taking net spend to 8_400 must clear the alert",
        )
    }

    @Test
    fun `thresholds are strict and over budget wins`() {
        val atEightyFive = adultGroceriesSpend(8_500L)
        val justOverEightyFive = adultGroceriesSpend(8_501L)
        val exactlyAtBudget = adultGroceriesSpend(ADULT_GROCERIES_CENTS)
        val overBudget = adultGroceriesSpend(ADULT_GROCERIES_CENTS + 1L)

        // Control: one cent past 85% does alert, so the empty result below is the
        // strict comparison rather than an inert fixture.
        val nearing = evaluator.evaluate(justOverEightyFive).single()
        assertEquals(BudgetAlertLevel.NEARING_LIMIT, nearing.level)
        assertEquals(8_501L, nearing.spentCents)

        assertEquals(
            emptyList(),
            evaluator.evaluate(atEightyFive),
            "exactly 85% of budget is not yet nearing the limit",
        )

        val atBudget = evaluator.evaluate(exactlyAtBudget).single()
        assertEquals(
            BudgetAlertLevel.NEARING_LIMIT,
            atBudget.level,
            "spending the whole budget is not over it",
        )
        assertEquals(ADULT_GROCERIES_CENTS, atBudget.spentCents)

        assertEquals(BudgetAlertLevel.OVER_LIMIT, evaluator.evaluate(overBudget).single().level)
    }

    @Test
    fun `demo loading and unauthorized figures never notify`() {
        val live = adultGroceriesSpend(ADULT_GROCERIES_CENTS + 1L)

        // Controls: live figures notify, and so do stale-but-real cached ones.
        assertEquals(BudgetAlertLevel.OVER_LIMIT, evaluator.evaluate(live).single().level)
        assertEquals(
            BudgetAlertLevel.OVER_LIMIT,
            evaluator.evaluate(live.withStatuses(Freshness.STALE)).single().level,
            "a stale cache still holds real figures",
        )

        for (blocked in listOf(Freshness.DEMO, Freshness.LOADING, Freshness.ERROR, Freshness.EMPTY)) {
            assertEquals(
                emptyList(),
                evaluator.evaluate(live.withBudgetStatus(blocked)),
                "a $blocked budget must not notify",
            )
            assertEquals(
                emptyList(),
                evaluator.evaluate(live.withTransactionsStatus(blocked)),
                "$blocked transactions must not notify",
            )
        }

        assertEquals(
            emptyList(),
            evaluator.evaluate(live.copy(staleAuthorization = true)),
            "a rejected read token must not notify",
        )
    }

    @Test
    fun `dispatcher publishes once per owner month category and level`() {
        val july =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("july-groceries", 10_001L, FamilyMember.VICTOR),
                        transaction("july-dining", 20_001L, FamilyMember.VICTOR, category = DINING),
                    ),
            )
        val august =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction(
                            "august-groceries",
                            10_001L,
                            FamilyMember.VICTOR,
                            month = NEXT_MONTH,
                        ),
                    ),
                month = NEXT_MONTH,
            )
        val deduplicator = FakeDeduplicator()
        val publisher = FakePublisher()
        val dispatcher = BudgetNotificationDispatcher(evaluator, deduplicator, publisher)

        dispatcher.dispatch(july, enabled = true)
        dispatcher.dispatch(july, enabled = true)

        // Two categories over their limits publish once each: a dedupe key that
        // drops the category would swallow the second.
        assertEquals(listOf(GROCERIES, DINING), publisher.alerts.map(BudgetAlert::category))
        assertEquals(2, deduplicator.sent.size)

        dispatcher.dispatch(august, enabled = true)

        assertEquals(3, publisher.alerts.size, "a new month is a new alert")
        assertEquals(NEXT_MONTH, publisher.alerts.last().month)
        assertEquals(3, deduplicator.sent.size)
    }

    @Test
    fun `dispatcher can publish nearing and over levels once each`() {
        val nearing = adultGroceriesSpend(8_501L)
        val over = adultGroceriesSpend(ADULT_GROCERIES_CENTS + 1L)
        val deduplicator = FakeDeduplicator()
        val publisher = FakePublisher()
        val dispatcher = BudgetNotificationDispatcher(evaluator, deduplicator, publisher)

        dispatcher.dispatch(nearing, enabled = true)
        dispatcher.dispatch(over, enabled = true)
        dispatcher.dispatch(over, enabled = true)
        dispatcher.dispatch(nearing, enabled = true)

        assertEquals(
            listOf(BudgetAlertLevel.NEARING_LIMIT, BudgetAlertLevel.OVER_LIMIT),
            publisher.alerts.map(BudgetAlert::level),
        )
        assertEquals(listOf(8_501L, ADULT_GROCERIES_CENTS + 1L), publisher.alerts.map(BudgetAlert::spentCents))
        assertEquals(2, deduplicator.sent.size)
    }

    @Test
    fun `overflowing category totals are suppressed`() {
        val single = adultGroceriesSpend(Long.MAX_VALUE)
        val overflowing =
            state(
                viewer = FamilyMember.VICTOR,
                budgetOwner = FamilyMember.VICTOR,
                transactions =
                    listOf(
                        transaction("max-1", Long.MAX_VALUE, FamilyMember.VICTOR),
                        transaction("max-2", Long.MAX_VALUE, FamilyMember.RACHEL),
                        transaction("max-3", Long.MAX_VALUE, FamilyMember.VICTOR),
                    ),
            )

        // Control: one unbounded figure is representable and does alert. Three of
        // them wrap a Long back around to 9_223_372_036_854_775_805 — a plausible
        // positive total that must be refused rather than published.
        assertEquals(Long.MAX_VALUE, evaluator.evaluate(single).single().spentCents)

        assertEquals(
            emptyList(),
            evaluator.evaluate(overflowing),
            "a wrapped category total must never reach a notification",
        )
    }

    @Test
    fun `dispatcher does not consume dedupe while permission is unavailable`() {
        val state = adultGroceriesSpend(ADULT_GROCERIES_CENTS + 1L)
        val deduplicator = FakeDeduplicator()
        val denied = FakePublisher(canPublish = false)

        BudgetNotificationDispatcher(evaluator, deduplicator, denied).dispatch(state, enabled = true)

        assertEquals(emptyList(), denied.alerts, "a publisher without permission is never handed an alert")
        assertEquals(emptySet(), deduplicator.sent, "a blocked dispatch must not consume the dedupe entry")

        // Control on the same deduplicator: once permission arrives the alert is
        // still owed, which is what "does not consume" has to mean.
        val granted = FakePublisher()
        BudgetNotificationDispatcher(evaluator, deduplicator, granted).dispatch(state, enabled = true)

        assertEquals(1, granted.alerts.size)
        assertEquals(ADULT_GROCERIES_CENTS + 1L, granted.alerts.single().spentCents)

        val disabledDeduplicator = FakeDeduplicator()
        val disabledPublisher = FakePublisher()
        BudgetNotificationDispatcher(evaluator, disabledDeduplicator, disabledPublisher)
            .dispatch(state, enabled = false)

        assertEquals(emptyList(), disabledPublisher.alerts, "a disabled toggle must not notify")
        assertEquals(emptySet(), disabledDeduplicator.sent)
    }

    private fun adultGroceriesSpend(amountCents: Long): VaultUiState =
        state(
            viewer = FamilyMember.VICTOR,
            budgetOwner = FamilyMember.VICTOR,
            transactions = listOf(transaction("spend", amountCents, FamilyMember.VICTOR)),
        )

    private fun state(
        viewer: FamilyMember,
        budgetOwner: FamilyMember,
        transactions: List<Transaction>,
        month: String = MONTH,
        groceriesCents: Long = ADULT_GROCERIES_CENTS,
    ): VaultUiState {
        val base = Fixtures.envelope(viewer, Freshness.LIVE)
        return VaultUiState(
            activeProfile = viewer,
            data =
                base.copy(
                    budget =
                        base.budget.copy(
                            status = Freshness.LIVE,
                            value =
                                Budget(
                                    month = month,
                                    categories =
                                        listOf(
                                            // Reported spend is deliberately absurd: the evaluator
                                            // must re-derive actuals from transactions.
                                            BudgetCategory(
                                                name = GROCERIES,
                                                budgetCents = groceriesCents,
                                                spentCents = 99_999_999L,
                                            ),
                                            BudgetCategory(
                                                name = DINING,
                                                budgetCents = 20_000L,
                                                spentCents = 99_999_999L,
                                            ),
                                        ),
                                    owner = budgetOwner,
                                ),
                        ),
                    transactions =
                        base.transactions.copy(
                            status = Freshness.LIVE,
                            value = transactions,
                        ),
                ),
        )
    }

    private fun VaultUiState.withBudgetStatus(status: Freshness): VaultUiState =
        copy(data = data.copy(budget = data.budget.copy(status = status)))

    private fun VaultUiState.withTransactionsStatus(status: Freshness): VaultUiState =
        copy(data = data.copy(transactions = data.transactions.copy(status = status)))

    private fun VaultUiState.withStatuses(status: Freshness): VaultUiState =
        withBudgetStatus(status).withTransactionsStatus(status)

    private fun VaultUiState.withBillPays(
        status: Freshness,
        billPays: List<BtcBillPay>,
    ): VaultUiState =
        copy(data = data.copy(btcBillPays = data.btcBillPays.copy(status = status, value = billPays)))

    private fun billPay(
        id: String,
        amountCents: Long,
        effect: BillPayBudgetEffect,
    ) = BtcBillPay(
        id = id,
        date = "$MONTH-10",
        merchant = id,
        category = GROCERIES,
        budgetEffect = effect,
        amountUsdCents = amountCents,
        btcSpentSats = 1_000L,
        btcPriceCents = 200_000L,
        feeUsdCents = 0L,
        platform = "river_bitcoin_bill_pay",
        note = null,
        owner = FamilyMember.VICTOR,
    )

    private fun transaction(
        id: String,
        amount: Long,
        owner: FamilyMember,
        category: String = GROCERIES,
        month: String = MONTH,
    ): Transaction =
        Transaction(
            id = id,
            date = "$month-10",
            merchant = id,
            amount = amount,
            category = category,
            owner = owner,
        )

    private class FakeDeduplicator : BudgetAlertDeduplicator {
        val sent = mutableSetOf<String>()

        override fun wasSent(key: String): Boolean = key in sent

        override fun markSent(key: String) {
            sent += key
        }
    }

    private class FakePublisher(
        private val canPublish: Boolean = true,
    ) : BudgetAlertPublisher {
        val alerts = mutableListOf<BudgetAlert>()

        override fun canPublish(): Boolean = canPublish

        override fun publish(alert: BudgetAlert) {
            alerts += alert
        }
    }

    private companion object {
        const val MONTH = "2026-07"
        const val NEXT_MONTH = "2026-08"
        const val GROCERIES = "Groceries"
        const val DINING = "Dining"
        const val ADULT_GROCERIES_CENTS = 10_000L
        const val CHILD_GROCERIES_CENTS = 5_000L
    }
}
