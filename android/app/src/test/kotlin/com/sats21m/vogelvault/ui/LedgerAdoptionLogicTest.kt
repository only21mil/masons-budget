package com.sats21m.vogelvault.ui

import com.sats21m.vogelvault.domain.BtcBillPay
import com.sats21m.vogelvault.domain.BillPayBudgetEffect
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.theme.LedgerPalettes
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.resolve
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LedgerAdoptionLogicTest {

    @Test
    fun `navigation uses fg2 at rest and treatment-aware selected ink`() {
        listOf(LedgerPalettes.TerminalDark, LedgerPalettes.DaylightLight).forEach { colors ->
            assertEquals(colors.foregroundSecondary, ledgerNavigationUnselectedTint(colors))
            assertEquals(
                colors.foreground,
                ledgerNavigationSelectedTint(Destination.DASHBOARD, colors),
            )
            assertEquals(
                colors.bitcoin,
                ledgerNavigationSelectedTint(Destination.BITCOIN, colors),
            )
        }
    }

    @Test
    fun `price hero uses only the operational quote and names its basis`() {
        val quote = MarketQuote(
            symbol = MarketSymbol.BTC,
            priceCents = 9_425_012L,
            source = "Vogel price service",
            fetchedAt = "2026-08-26T12:00:00Z",
            status = MarketQuoteStatus.LIVE,
        )

        assertEquals("\$94,250.12", formatOperationalBitcoinPrice(quote))
        assertEquals(
            "Market quote · 2026-08-26T12:00:00Z",
            operationalBitcoinPriceBasis(quote),
        )
        assertEquals(Money.PRICE_UNAVAILABLE, formatOperationalBitcoinPrice(null))
    }

    @Test
    fun `family scoping card distinguishes visibility task privacy and net worth`() {
        assertEquals(
            FamilyScopeSummary(
                finance = "Adult household + child oversight",
                tasks = "Rachel only",
                netWorth = "Adult household only",
            ),
            familyScopeSummary(FamilyMember.RACHEL),
        )
        assertEquals(
            FamilyScopeSummary(
                finance = "Mason only",
                tasks = "Mason only",
                netWorth = "Mason only",
            ),
            familyScopeSummary(FamilyMember.MASON),
        )
    }

    @Test
    fun `settings preserve effect choices while Daylight and accessibility suppress rendering`() {
        val settings = LedgerUiSettings(
            appearance = LedgerAppearance.DAYLIGHT,
            scanlinesEnabled = true,
            phosphorGlowEnabled = true,
        )

        assertEquals(LedgerTreatment.DAYLIGHT_LIGHT, settings.treatment(systemDark = true))
        val daylight = settings.effectSettings.resolve(
            LedgerTreatment.DAYLIGHT_LIGHT,
            settings.accessibility,
        )
        assertFalse(daylight.showScanlines)
        assertFalse(daylight.showPhosphorGlow)

        val terminal = settings.effectSettings.resolve(
            LedgerTreatment.TERMINAL_DARK,
            settings.accessibility,
        )
        assertTrue(terminal.showScanlines)
        assertTrue(terminal.showPhosphorGlow)

        val reduced = settings.effectSettings.resolve(
            LedgerTreatment.TERMINAL_DARK,
            settings.accessibility.copy(reduceMotion = true),
        )
        assertFalse(reduced.showScanlines)
        assertFalse(reduced.showPhosphorGlow)
        assertFalse(reduced.animate)
    }

    @Test
    fun `awards never treat demo or failed slices as earned milestones`() {
        fun projection(state: VaultUiState) = DashboardProjection(
            activity = emptyList(),
            accounts = emptyList(),
            balance = state.data.btcBalance.value,
            incomeEntries = emptyList(),
            spendCents = null,
            incomeCents = null,
            openTodos = 0,
        )

        val demo = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.DEMO),
        )
        assertTrue(dashboardAwards(demo, projection(demo)).none(DashboardAward::earned))

        val failedData = Fixtures.envelope(FamilyMember.VICTOR, Freshness.ERROR)
        val failed = VaultUiState(activeProfile = FamilyMember.VICTOR, data = failedData)
        assertTrue(dashboardAwards(failed, projection(failed)).none(DashboardAward::earned))

        val live = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            data = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE),
        )
        assertTrue(
            dashboardAwards(live, projection(live))
                .single { it.label == "Ledger closer" }
                .earned,
        )
    }

    @Test
    fun `Today money out includes adult rows and bill pay fees while completed tasks remain in list`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val billPay = BtcBillPay(
            id = "today-bill",
            date = "2026-07-26",
            merchant = "River bill",
            category = "Housing",
            budgetEffect = BillPayBudgetEffect.BUDGET_CATEGORY,
            amountUsdCents = 10_000L,
            btcSpentSats = 12_000L,
            feeUsdCents = 25L,
            platform = "River",
            note = null,
            owner = FamilyMember.RACHEL,
        )
        val state = VaultUiState(
            activeProfile = FamilyMember.VICTOR,
            data = fixture.copy(
                btcBillPays = fixture.btcBillPays.copy(value = listOf(billPay)),
            ),
            now = Fixtures.NOW_MILLIS,
        )

        val summary = moneyOutToday(state, ZoneOffset.UTC)
        assertEquals(24_918L, summary?.totalCents)
        assertEquals(listOf("tx-0001", "tx-0002", "today-bill"), summary?.sourceIds)

        val completed = fixture.todos.value.first().copy(
            id = "completed-today",
            due = "2026-07-26",
            done = true,
        )
        assertTrue(
            todosForToday(fixture.todos.value + completed, FamilyMember.VICTOR, "2026-07-26")
                .any { it.id == completed.id && it.done },
        )
    }

    @Test
    fun `Today money out fails closed when either ledger projection is unavailable`() {
        val fixture = Fixtures.envelope(FamilyMember.VICTOR, Freshness.LIVE)
        val state = VaultUiState(
            data = fixture.copy(
                btcBillPays = fixture.btcBillPays.copy(status = Freshness.ERROR),
            ),
        )

        assertNull(moneyOutToday(state, ZoneOffset.UTC))
    }

    @Test
    fun `payment rail comes from the stable card wire including retired fallback`() {
        assertEquals(PaymentRailKind.BOLT, paymentRailKind("zeus_lightning"))
        assertEquals(PaymentRailKind.CHAIN, paymentRailKind("zeus_on_chain"))
        assertEquals(PaymentRailKind.BOLT, paymentRailKind("lightning"))
        assertEquals(PaymentRailKind.CHAIN, paymentRailKind("on-chain"))
        assertNull(paymentRailKind("coinbase_card"))
        assertNull(paymentRailKind("unknown-wire"))
    }

    @Test
    fun `category delete UI uses canonical profile source`() {
        assertEquals("budget", budgetCategoryDeleteSourceFile(FamilyMember.VICTOR))
        assertEquals("budget", budgetCategoryDeleteSourceFile(FamilyMember.RACHEL))
        assertEquals("mason-budget", budgetCategoryDeleteSourceFile(FamilyMember.MASON))
        assertNull(budgetCategoryDeleteSourceFile(FamilyMember.MADDOX))
    }

    @Test
    fun `onboarding and shared navigation expose their exact counts`() {
        assertEquals(3, OnboardingStep.entries.size)
        assertEquals("Step 1 of 3", onboardingProgressLabel(0))
        assertEquals("Step 3 of 3", onboardingProgressLabel(2))
        val overflow = foldedOverflowDestinations(Destination.entries.toList())
        assertEquals(0, overflow.size)
        assertEquals(5, foldedPrimaryDestinations(Destination.entries.toList()).size)
    }
}
