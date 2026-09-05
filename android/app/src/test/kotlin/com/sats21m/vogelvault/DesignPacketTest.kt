package com.sats21m.vogelvault

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import com.github.takahirom.roborazzi.captureRoboImage
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.FamilyMember
import com.sats21m.vogelvault.domain.Fixtures
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.Destination
import com.sats21m.vogelvault.ui.LedgerAppearance
import com.sats21m.vogelvault.ui.LedgerUiSettings
import com.sats21m.vogelvault.ui.VaultApp
import com.sats21m.vogelvault.ui.VaultUiState
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.theme.VaultInfo
import com.sats21m.vogelvault.ui.theme.VaultNegative
import com.sats21m.vogelvault.ui.theme.VaultPositive
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultWarning
import com.sats21m.vogelvault.ui.theme.LedgerTreatment
import com.sats21m.vogelvault.ui.theme.LedgerTheme
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.SovereignLedgerTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Android design packet.
 *
 * Renders the real Compose shell to PNG under Robolectric, so the Fold UI can be
 * reviewed with no emulator, no display and no physical device. Mirrors the Linux
 * client's packet.
 *
 * Two postures matter, and they are the whole point of the adaptive layout:
 *   - folded   411dp wide -> bottom navigation bar
 *   - unfolded 841dp wide -> navigation rail
 *
 * Deliberately a review artifact, not a pixel-diff gate. Behaviour is asserted by
 * the domain and threshold tests; a strict image comparison would fail on every
 * font or renderer nudge and train us to ignore it.
 *
 * Note this uses the composable form of `captureRoboImage` rather than a
 * ComposeTestRule: the rule form needs a real Activity to launch, which is not
 * declared for unit tests, and it is not needed just to render a tree.
 */
private fun capture(
    name: String,
    state: VaultUiState,
    displayUnit: DisplayUnit = DisplayUnit.BTC,
    appearance: LedgerAppearance = LedgerAppearance.DAYLIGHT,
) {
    val settings = LedgerUiSettings(appearance = appearance)
    captureRoboImage("build/outputs/roborazzi/$name.png") {
        LedgerTheme(
            treatment = settings.treatment(systemDark = false),
            effectSettings = settings.effectSettings,
            accessibility = settings.accessibility,
        ) {
            VaultApp(
                state = state,
                onNavigate = {},
                onSwitchProfile = {},
                displayUnit = displayUnit,
                ledgerSettings = settings,
            )
        }
    }
}

private fun captureStatusAndUnavailableTokens(
    name: String = "folded-status-and-unavailable-tokens",
    treatment: LedgerTreatment = LedgerTreatment.DAYLIGHT_LIGHT,
) {
    captureRoboImage("build/outputs/roborazzi/$name.png") {
        SovereignLedgerTheme(treatment) {
            val colors = LocalLedgerTheme.current.colors
            Column(
                Modifier
                    .fillMaxSize()
                    .background(colors.background)
                    .padding(VaultSpace.lg),
                verticalArrangement = Arrangement.spacedBy(VaultSpace.md),
            ) {
                KpiStrip(
                    listOf(
                        Kpi("Unavailable gain", Money.PRICE_UNAVAILABLE, tone = VaultPositive),
                        Kpi("Unavailable loss", Money.PRICE_UNAVAILABLE, tone = VaultNegative),
                        Kpi("Odd final KPI", "Spans the row"),
                    ),
                )
                LedgerRow("Unavailable ledger figure", figure = Money.PRICE_UNAVAILABLE, figureColor = VaultNegative)
                StatusBanner("Positive status", tone = VaultPositive)
                StatusBanner("Error status", tone = VaultNegative)
                StatusBanner("Warning status", tone = VaultWarning)
                StatusBanner("Informational status", tone = VaultInfo)
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = RobolectricDeviceQualifiers.FOLDED)
class DesignPacketFoldedTest {

    @Test
    fun statusAndUnavailableTokens() {
        captureStatusAndUnavailableTokens()
    }

    @Test
    fun terminalTreatmentRootAndStatusTokens() {
        capture(
            "folded-dashboard-victor-terminal",
            VaultUiState.of(FamilyMember.VICTOR, Destination.DASHBOARD),
            appearance = LedgerAppearance.TERMINAL,
        )
        captureStatusAndUnavailableTokens(
            name = "folded-status-and-unavailable-tokens-terminal",
            treatment = LedgerTreatment.TERMINAL_DARK,
        )
    }

    @Test
    fun adultDestinations() {
        for (destination in Destination.entries) {
            capture(
                "folded-${destination.name.lowercase()}-victor-normal",
                VaultUiState.of(FamilyMember.VICTOR, destination),
            )
        }
    }

    @Test
    fun childDestinations() {
        for (destination in Destination.entries) {
            capture(
                "folded-${destination.name.lowercase()}-mason-normal",
                VaultUiState.of(FamilyMember.MASON, destination),
            )
        }
    }

    @Test
    fun bitcoinDisplayUnits() {
        for (unit in DisplayUnit.entries) {
            capture(
                "folded-bitcoin-victor-${unit.storageKey}",
                VaultUiState.of(FamilyMember.VICTOR, Destination.BITCOIN),
                unit,
            )
        }
    }

    @Test
    fun bitcoinUsdWithoutPrice() {
        val state = VaultUiState.of(FamilyMember.VICTOR, Destination.BITCOIN)
        capture(
            "folded-bitcoin-victor-usd-no-price",
            state.copy(
                data = state.data.copy(
                    btcBuys = state.data.btcBuys.copy(
                        status = Freshness.EMPTY,
                        value = emptyList(),
                    ),
                    btcBalance = state.data.btcBalance.copy(
                        value = Fixtures.btcBalanceWithoutFiatValuation(),
                    ),
                    btcPriceCents = 0L,
                    btcPriceAsOf = null,
                ),
            ),
            DisplayUnit.USD,
        )
    }

    /**
     * The Budget screen on a month that is not the budget file's own.
     *
     * The chip's selected state and the "planned figures are Jul 2026 targets"
     * banner only exist off the default month, so no other capture in the packet
     * puts either in front of a reviewer.
     */
    @Test
    fun budgetOnAnEarlierMonth() {
        capture(
            "folded-budget-victor-2026-06",
            VaultUiState.of(FamilyMember.VICTOR, Destination.BUDGET, selectedMonth = "2026-06"),
        )
    }

    /** Maddox has no dedicated budget data, so his budget is genuinely empty. */
    @Test
    fun maddoxBudgetIsEmpty() {
        capture(
            "folded-budget-maddox-normal",
            VaultUiState.of(FamilyMember.MADDOX, Destination.BUDGET),
        )
    }

    @Test
    fun nonNormalStates() {
        val sampled = listOf(
            Destination.DASHBOARD,
            Destination.BUDGET,
            Destination.ACTIVITY,
            Destination.NET_WORTH,
        )
        val states = listOf(Freshness.STALE, Freshness.ERROR, Freshness.EMPTY, Freshness.LOADING)
        for (destination in sampled) {
            for (status in states) {
                capture(
                    "folded-${destination.name.lowercase()}-victor-${status.name.lowercase()}",
                    VaultUiState.of(FamilyMember.VICTOR, destination, status),
                )
            }
        }
    }
}

/**
 * Unfolded pass. A separate class because the Robolectric device qualifier is
 * class-level, and proving the bottom bar becomes a rail is the point.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = RobolectricDeviceQualifiers.UNFOLDED)
class DesignPacketUnfoldedTest {

    @Test
    fun terminalTreatmentRoot() {
        capture(
            "unfolded-dashboard-victor-terminal",
            VaultUiState.of(FamilyMember.VICTOR, Destination.DASHBOARD),
            appearance = LedgerAppearance.TERMINAL,
        )
    }

    @Test
    fun adultDestinations() {
        for (destination in Destination.entries) {
            capture(
                "unfolded-${destination.name.lowercase()}-victor-normal",
                VaultUiState.of(FamilyMember.VICTOR, destination),
            )
        }
    }

    @Test
    fun childDashboard() {
        capture(
            "unfolded-dashboard-mason-normal",
            VaultUiState.of(FamilyMember.MASON, Destination.DASHBOARD),
        )
    }

    /**
     * The two-pane screens: rail, capped content, 296dp sidebar with recent
     * activity and today's tasks. Named so a reviewer finds them without reading
     * the destination loop.
     */
    @Test
    fun twoPaneDashboardAndBudget() {
        capture(
            "unfolded-dashboard-victor-two-pane",
            VaultUiState.of(FamilyMember.VICTOR, Destination.DASHBOARD),
        )
        capture(
            "unfolded-budget-victor-two-pane",
            VaultUiState.of(FamilyMember.VICTOR, Destination.BUDGET),
        )
    }

    /** The month row has far more width to lay out against beside the rail. */
    @Test
    fun budgetOnAnEarlierMonth() {
        capture(
            "unfolded-budget-victor-2026-06",
            VaultUiState.of(FamilyMember.VICTOR, Destination.BUDGET, selectedMonth = "2026-06"),
        )
    }
}

/**
 * Robolectric screen qualifiers for the two Fold postures.
 *
 * Spelled out rather than using a named device so the widths straddle
 * [com.sats21m.vogelvault.ui.UNFOLDED_MIN_WIDTH_DP] on purpose: 411dp is below the
 * 600dp threshold, 841dp is above it. AdaptiveThresholdTest asserts that.
 */
object RobolectricDeviceQualifiers {
    const val FOLDED = "w411dp-h891dp-normal-long-notround-any-420dpi-keyshidden-nonav"
    const val UNFOLDED = "w841dp-h945dp-normal-long-notround-any-420dpi-keyshidden-nonav"
}
