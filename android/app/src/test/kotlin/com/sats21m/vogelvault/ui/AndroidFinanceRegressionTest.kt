package com.sats21m.vogelvault.ui

import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.unit.dp
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.BtcBalance
import com.sats21m.vogelvault.domain.Custody
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.FinanceAccount
import com.sats21m.vogelvault.domain.FinanceDocument
import com.sats21m.vogelvault.domain.FinanceHolding
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketQuoteSnapshot
import com.sats21m.vogelvault.domain.MarketQuoteStatus
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Slice
import com.sats21m.vogelvault.ui.theme.VogelVaultTheme
import java.time.Instant
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h900dp-normal-notlong-notround-any-420dpi-keyshidden-nonav")
class AndroidFinanceRegressionTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var activityController: ActivityController<ComponentActivity>

    @Before
    fun openHost() {
        activityController = Robolectric.buildActivity(ComponentActivity::class.java)
        activityController.get().setTheme(R.style.Theme_VogelVault)
        activityController.setup()
    }

    @After
    fun closeHost() {
        activityController.pause().stop().destroy()
    }

    @Test
    fun `live BTC quote values Total stack and Multisig when embedded fiat is absent`() {
        // A live operational quote may fill only the missing USD side, and the
        // accessibility contract must identify that quote-derived value as estimated.
        val coldcard = bitcoinAccount(
            key = "coldcard",
            label = "Coldcard",
            sats = 75_000_000L,
            owner = FamilyMember.VICTOR,
        )
        val balance = bitcoinBalance(
            owner = FamilyMember.VICTOR,
            totalSats = 100_000_000L,
            accounts = listOf(coldcard),
        )
        val state = financeState(
            profile = FamilyMember.VICTOR,
            balance = balance,
            accounts = emptyList(),
        )

        show(Destination.BITCOIN, state, DisplayUnit.USD)

        compose.onNodeWithContentDescription(
            "Total stack, \$100,000.00, estimated figure",
        ).fetchSemanticsNode()
        contentList().performScrollToNode(hasContentDescription("Multisig", substring = true))
        compose.onNodeWithContentDescription(
            "Multisig, Victor · Estimated, Self custody, \$75,000.00",
        ).fetchSemanticsNode()
    }

    @Test
    fun `absent BTC quote keeps missing embedded fiat unavailable`() {
        val coldcard = bitcoinAccount(
            key = "coldcard",
            label = "Coldcard",
            sats = 75_000_000L,
            owner = FamilyMember.VICTOR,
        )
        val balance = bitcoinBalance(
            owner = FamilyMember.VICTOR,
            totalSats = 100_000_000L,
            accounts = listOf(coldcard),
        )
        val state = financeState(
            profile = FamilyMember.VICTOR,
            balance = balance,
            accounts = emptyList(),
            marketQuotes = unavailableQuotes(),
        )

        show(Destination.BITCOIN, state, DisplayUnit.USD)

        compose.onNodeWithContentDescription("Total stack, unavailable")
            .fetchSemanticsNode()
        contentList().performScrollToNode(hasContentDescription("Multisig", substring = true))
        compose.onNodeWithContentDescription(
            "Multisig, Victor, Self custody, unavailable",
        ).fetchSemanticsNode()
    }

    @Test
    fun `Mason net worth combines only his Bitcoin and retirement`() {
        // The combined child total must use only the child's scoped sources.
        val balance = bitcoinBalance(
            owner = FamilyMember.MASON,
            totalSats = 25_000_000L,
            accounts = listOf(
                bitcoinAccount("mason-stack", "Mason Stack", 25_000_000L, FamilyMember.MASON),
            ),
        )
        val state = financeState(
            profile = FamilyMember.MASON,
            balance = balance,
            accounts = listOf(
                retirementAccount("mason-401k", "Mason 401(k)", 100_000L, FamilyMember.MASON),
                retirementAccount("adult-401k", "Adult 401(k)", 500_000L, FamilyMember.VICTOR),
            ),
        )

        show(Destination.NET_WORTH, state, DisplayUnit.USD)

        compose.onNode(hasContentDescription("\$26,000.00", substring = true))
            .fetchSemanticsNode()
        assertEquals(
            0,
            compose.onAllNodesWithContentDescription("Adult 401(k)", substring = true)
                .fetchSemanticsNodes().size,
            "Adult retirement must not enter Mason's screen or total",
        )
    }

    @Test
    fun `net worth stays clean while retirement keeps holding and scenario detail`() {
        // Current Bitcoin is factual snapshot data, independent from projection inputs.
        val balance = bitcoinBalance(
            owner = FamilyMember.VICTOR,
            totalSats = 100_000_000L,
            accounts = listOf(
                bitcoinAccount("coldcard", "Coldcard", 100_000_000L, FamilyMember.VICTOR),
            ),
        )
        val holding = FinanceHolding(
            name = "Index holding",
            category = "ETF",
            ticker = "VOO",
            valueCents = 100_000L,
            costBasisCents = 90_000L,
            gainBps = 1_111L,
            sharesDecimal = "10",
            avgCostCents = 9_000L,
            currentPricePerShareCents = 10_000L,
            isProxy = false,
        )
        val base = financeState(
            profile = FamilyMember.VICTOR,
            balance = balance,
            accounts = listOf(
                retirementAccount(
                    key = "victor-401k",
                    provider = "Retirement Provider",
                    cents = 100_000L,
                    owner = FamilyMember.VICTOR,
                    holdings = listOf(holding),
                ),
            ),
        )
        val state = base.copy(
            data = base.data.copy(
                income = Slice(Freshness.EMPTY, emptyList(), null, "test income unavailable"),
            ),
        )

        show(Destination.NET_WORTH, state, DisplayUnit.BTC)

        contentList().performScrollToNode(hasContentDescription("Retirement Provider", substring = true))
        compose.onNodeWithContentDescription("Retirement Provider", substring = true)
            .fetchSemanticsNode()
        contentList().performScrollToNode(hasContentDescription("Net worth projections"))
        compose.onNodeWithContentDescription("Net worth projections").fetchSemanticsNode()
        assertEquals(
            0,
            compose.onAllNodesWithContentDescription("Index holding", substring = true).fetchSemanticsNodes().size,
            "holding detail belongs on the separate Retirement tab",
        )

        show(Destination.RETIREMENT, state, DisplayUnit.BTC)

        contentList().performScrollToNode(hasContentDescription("Index holding", substring = true))
        compose.onNodeWithContentDescription("Index holding", substring = true)
            .fetchSemanticsNode()
        contentList().performScrollToNode(hasContentDescription("Current Bitcoin", substring = true))
        compose.onNodeWithContentDescription(
            "Current Bitcoin stack, 1.00000000 BTC, balance as of 2026-07-31",
        ).fetchSemanticsNode()
        contentList().performScrollToNode(hasText("Income unavailable"))
        compose.onNodeWithText("Income unavailable").fetchSemanticsNode()
    }

    @Test
    fun `net worth horizon exposes and updates its selected state`() {
        val state = financeState(
            profile = FamilyMember.VICTOR,
            balance = bitcoinBalance(
                owner = FamilyMember.VICTOR,
                totalSats = 100_000_000L,
                accounts = listOf(
                    bitcoinAccount("coldcard", "Coldcard", 100_000_000L, FamilyMember.VICTOR),
                ),
            ),
            accounts = listOf(
                retirementAccount("victor-401k", "Retirement Provider", 100_000L, FamilyMember.VICTOR),
            ),
        )

        show(Destination.NET_WORTH, state, DisplayUnit.USD)
        contentList().performScrollToNode(hasText("10 years"))

        compose.onNodeWithText("HORIZON")
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
        compose.onNodeWithText("10 years").assertIsSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected"))
        compose.onNodeWithText("20 years").assertIsNotSelected().performClick()
        settle()
        compose.onNodeWithText("10 years").assertIsNotSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Not selected"))
        compose.onNodeWithText("20 years").assertIsSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected"))
    }

    @Test
    fun `retirement horizon exposes and updates its selected state`() {
        val state = financeState(
            profile = FamilyMember.VICTOR,
            balance = bitcoinBalance(
                owner = FamilyMember.VICTOR,
                totalSats = 100_000_000L,
                accounts = listOf(
                    bitcoinAccount("coldcard", "Coldcard", 100_000_000L, FamilyMember.VICTOR),
                ),
            ),
            accounts = listOf(
                retirementAccount("victor-401k", "Retirement Provider", 100_000L, FamilyMember.VICTOR),
            ),
        )

        show(Destination.RETIREMENT, state, DisplayUnit.USD)
        contentList().performScrollToNode(hasText("10 years"))

        compose.onNodeWithText("HORIZON")
            .assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
        compose.onNodeWithText("10 years").assertIsSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected"))
        compose.onNodeWithText("30 years").assertIsNotSelected().performClick()
        settle()
        compose.onNodeWithText("10 years").assertIsNotSelected()
        compose.onNodeWithText("30 years").assertIsSelected()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Selected"))
    }

    @Test
    fun `one selected Bitcoin unit remains selected across financial destinations`() {
        val destination = mutableStateOf(Destination.SETTINGS)
        val displayUnit = mutableStateOf(DisplayUnit.BTC)
        val state = financeState(
            profile = FamilyMember.VICTOR,
            balance = bitcoinBalance(
                owner = FamilyMember.VICTOR,
                totalSats = 100_000_000L,
                accounts = listOf(
                    bitcoinAccount("coldcard", "Coldcard", 100_000_000L, FamilyMember.VICTOR),
                ),
            ),
            accounts = listOf(
                retirementAccount("victor-401k", "Retirement Provider", 100_000L, FamilyMember.VICTOR),
            ),
        )
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        ScreenHost(
                            destination = destination.value,
                            state = state.copy(destination = destination.value),
                            displayUnit = displayUnit.value,
                            onDisplayUnitChange = { displayUnit.value = it },
                        )
                    }
                }
            }
        }
        settle()

        contentList().performScrollToNode(hasContentDescription("SATS display unit"))
        compose.onNodeWithContentDescription("SATS display unit").performClick()
        settle()
        compose.onNodeWithContentDescription("SATS display unit").assertIsSelected()

        compose.runOnUiThread { destination.value = Destination.BITCOIN }
        settle()
        compose.onNodeWithContentDescription("Total stack, 100 000 000 sats")
            .fetchSemanticsNode()

        compose.runOnUiThread { destination.value = Destination.NET_WORTH }
        settle()
        contentList().performScrollToNode(hasContentDescription("Bitcoin stack, 100 000 000 sats, estimated figure"))
        compose.onNodeWithContentDescription("Bitcoin stack, 100 000 000 sats, estimated figure")
            .fetchSemanticsNode()

        compose.runOnUiThread { destination.value = Destination.SETTINGS }
        settle()
        contentList().performScrollToNode(hasContentDescription("SATS display unit"))
        compose.onNodeWithContentDescription("SATS display unit").assertIsSelected()
    }

    private fun show(destination: Destination, state: VaultUiState, displayUnit: DisplayUnit) {
        compose.runOnUiThread {
            activityController.get().setContent {
                VogelVaultTheme {
                    Box(Modifier.size(width = 411.dp, height = 900.dp)) {
                        ScreenHost(
                            destination = destination,
                            state = state.copy(destination = destination),
                            displayUnit = displayUnit,
                        )
                    }
                }
            }
        }
        settle()
    }

    // The unit chips above the list scroll too; the ledger column is the other scroll node.
    private fun contentList() =
        compose.onAllNodes(hasScrollAction() and hasTestTag(BITCOIN_UNIT_TOGGLE_TEST_TAG).not())[0]

    private fun settle() {
        repeat(3) {
            shadowOf(Looper.getMainLooper()).idle()
            compose.waitForIdle()
        }
    }

    private fun financeState(
        profile: FamilyMember,
        balance: BtcBalance,
        accounts: List<FinanceAccount>,
        marketQuotes: MarketQuoteSnapshot = quotes(),
    ): VaultUiState {
        val data = Fixtures.envelope(profile, Freshness.LIVE).copy(
            btcBalance = Slice(Freshness.LIVE, balance, 1L, "test Bitcoin balance"),
        )
        return VaultUiState(
            activeProfile = profile,
            data = data,
            now = Instant.parse("2026-07-31T12:05:00Z").toEpochMilli(),
            financeDocument = FinanceDocument(
                updatedAtMs = 1L,
                lastUpdated = "2026-07-31",
                retirementTotalCents = null,
                accounts = accounts,
            ),
            financeStatus = Freshness.LIVE,
            marketQuotes = marketQuotes,
            marketQuoteStatus = Freshness.LIVE,
        )
    }

    private fun bitcoinAccount(
        key: String,
        label: String,
        sats: Long,
        owner: FamilyMember,
    ) = BtcAccount(
        key = key,
        label = label,
        custody = Custody.SELF_CUSTODY,
        sats = sats,
        fiatCents = 0L,
        owner = owner,
    )

    private fun bitcoinBalance(
        owner: FamilyMember,
        totalSats: Long,
        accounts: List<BtcAccount>,
    ) = BtcBalance(
        owner = owner,
        asOf = "2026-07-31",
        accounts = accounts,
        totalSats = totalSats,
        fiatCents = 0L,
        exchangeSats = 0L,
        selfCustodySats = totalSats,
    )

    private fun retirementAccount(
        key: String,
        provider: String,
        cents: Long,
        owner: FamilyMember,
        holdings: List<FinanceHolding> = emptyList(),
    ) = FinanceAccount(
        key = key,
        owner = owner,
        provider = provider,
        totalValueCents = cents,
        weeklyContributionCents = 0L,
        weeklyContributionDay = null,
        holdings = holdings,
    )

    private fun quotes() = MarketQuoteSnapshot(
        listOf(
            MarketQuote(
                MarketSymbol.BTC,
                10_000_000L,
                "test market service",
                "2026-07-31T12:00:00Z",
                MarketQuoteStatus.LIVE,
            ),
            MarketQuote(
                MarketSymbol.VOO,
                10_000L,
                "test market service",
                "2026-07-31T12:00:00Z",
                MarketQuoteStatus.LIVE,
            ),
            MarketQuote(
                MarketSymbol.IBIT,
                null,
                "test market service",
                null,
                MarketQuoteStatus.UNAVAILABLE,
            ),
        ),
    )

    private fun unavailableQuotes() = MarketQuoteSnapshot(
        MarketSymbol.entries.map { symbol ->
            MarketQuote(
                symbol,
                null,
                "test market service",
                null,
                MarketQuoteStatus.UNAVAILABLE,
            )
        },
    )
}
