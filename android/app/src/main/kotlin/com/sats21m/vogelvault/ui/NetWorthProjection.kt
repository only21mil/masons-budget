package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.sats21m.vogelvault.domain.AccountValuation
import com.sats21m.vogelvault.domain.BtcAccount
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.Freshness
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.Provenance
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.theme.LocalLedgerTheme
import com.sats21m.vogelvault.ui.theme.VaultSpace
import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.pow

/** Rates and weekly Bitcoin contribution specified by Victor in Buzz issue f80c5630. */
internal const val VOO_ANNUAL_GROWTH_BPS = 1_100L
internal const val IBIT_AND_BITCOIN_ANNUAL_GROWTH_BPS = 1_600L
internal const val BITCOIN_WEEKLY_CONTRIBUTION_CENTS = 200_000L

internal fun BtcAccount.displayLabel(): String =
    if (label.equals("coldcard", ignoreCase = true) || key.contains("coldcard", ignoreCase = true)) {
        "Multisig"
    } else {
        label
    }

private val MONTHS_PER_YEAR = BigDecimal(12)
private val WEEKS_PER_YEAR = BigDecimal(52)
private val BASIS_POINTS = BigDecimal(10_000)
private val NET_WORTH_HORIZONS = listOf(10, 20, 30)
private val DEFAULT_NET_WORTH_HORIZON_YEARS = NET_WORTH_HORIZONS.first()

internal data class NetWorthProjectionResult(
    val years: Int,
    val bitcoinCents: Long,
    val vooCents: Long,
    val ibitCents: Long,
    val otherRetirementCents: Long,
    val bitcoinWeeklyContributionCents: Long,
    val vooWeeklyContributionCents: Long,
    val ibitWeeklyContributionCents: Long,
    val otherWeeklyContributionCents: Long,
) {
    val retirementCents: Long
        get() = listOf(vooCents, ibitCents, otherRetirementCents).fold(0L, Math::addExact)
    val totalCents: Long
        get() = Math.addExact(bitcoinCents, retirementCents)
}

private enum class ProjectionAsset { VOO, IBIT, OTHER }

internal fun projectNetWorth(
    bitcoinValueCents: Long,
    retirementAccounts: List<AccountValuation>,
    years: Int,
): NetWorthProjectionResult {
    require(bitcoinValueCents >= 0L)
    require(years > 0)
    val current = mutableMapOf(ProjectionAsset.VOO to 0L, ProjectionAsset.IBIT to 0L, ProjectionAsset.OTHER to 0L)
    val weekly = mutableMapOf(ProjectionAsset.VOO to 0L, ProjectionAsset.IBIT to 0L, ProjectionAsset.OTHER to 0L)

    retirementAccounts.forEach { account ->
        if (account.holdings.isEmpty()) {
            current.add(ProjectionAsset.OTHER, account.valueCents)
            weekly.add(ProjectionAsset.OTHER, account.account.weeklyContributionCents)
        } else {
            account.holdings.forEach { current.add(it.asset(), it.valueCents) }
            allocateContribution(account, weekly)
        }
    }

    return NetWorthProjectionResult(
        years = years,
        bitcoinCents = projectAssetCents(bitcoinValueCents, BITCOIN_WEEKLY_CONTRIBUTION_CENTS, IBIT_AND_BITCOIN_ANNUAL_GROWTH_BPS, years),
        vooCents = projectAssetCents(current.getValue(ProjectionAsset.VOO), weekly.getValue(ProjectionAsset.VOO), VOO_ANNUAL_GROWTH_BPS, years),
        ibitCents = projectAssetCents(current.getValue(ProjectionAsset.IBIT), weekly.getValue(ProjectionAsset.IBIT), IBIT_AND_BITCOIN_ANNUAL_GROWTH_BPS, years),
        otherRetirementCents = projectAssetCents(current.getValue(ProjectionAsset.OTHER), weekly.getValue(ProjectionAsset.OTHER), 0L, years),
        bitcoinWeeklyContributionCents = BITCOIN_WEEKLY_CONTRIBUTION_CENTS,
        vooWeeklyContributionCents = weekly.getValue(ProjectionAsset.VOO),
        ibitWeeklyContributionCents = weekly.getValue(ProjectionAsset.IBIT),
        otherWeeklyContributionCents = weekly.getValue(ProjectionAsset.OTHER),
    )
}

private fun allocateContribution(account: AccountValuation, destination: MutableMap<ProjectionAsset, Long>) {
    val contribution = account.account.weeklyContributionCents
    val total = account.holdings.fold(0L) { sum, holding -> Math.addExact(sum, holding.valueCents) }
    if (contribution <= 0L || total <= 0L) {
        destination.add(ProjectionAsset.OTHER, contribution.coerceAtLeast(0L))
        return
    }
    var allocated = 0L
    account.holdings.forEachIndexed { index, holding ->
        val share = if (index == account.holdings.lastIndex) {
            contribution - allocated
        } else {
            BigDecimal(contribution)
                .multiply(BigDecimal(holding.valueCents))
                .divide(BigDecimal(total), 0, RoundingMode.DOWN)
                .longValueExact()
        }
        destination.add(holding.asset(), share)
        allocated = Math.addExact(allocated, share)
    }
}

private fun com.sats21m.vogelvault.domain.HoldingValuation.asset(): ProjectionAsset =
    when (holding.ticker?.trim()?.uppercase()) {
        "VOO" -> ProjectionAsset.VOO
        "IBIT" -> ProjectionAsset.IBIT
        else -> ProjectionAsset.OTHER
    }

private fun MutableMap<ProjectionAsset, Long>.add(asset: ProjectionAsset, amount: Long) {
    this[asset] = Math.addExact(getValue(asset), amount)
}

internal fun projectAssetCents(current: Long, weeklyContribution: Long, annualGrowthBps: Long, years: Int): Long {
    val annualRate = BigDecimal(annualGrowthBps).divide(BASIS_POINTS)
    val monthlyRate = BigDecimal.valueOf((1.0 + annualRate.toDouble()).pow(1.0 / 12.0) - 1.0)
    val monthlyContribution = BigDecimal(weeklyContribution)
        .multiply(WEEKS_PER_YEAR)
        .divide(MONTHS_PER_YEAR, 16, RoundingMode.HALF_UP)
    var projected = BigDecimal(current)
    repeat(Math.multiplyExact(years, 12)) {
        projected = projected.multiply(BigDecimal.ONE + monthlyRate).add(monthlyContribution)
    }
    return projected.setScale(0, RoundingMode.HALF_UP).longValueExact()
}

@Composable
internal fun NetWorthProjectionPanel(state: VaultUiState, displayUnit: DisplayUnit) {
    val colors = LocalLedgerTheme.current.colors
    var years by rememberSaveable { mutableIntStateOf(DEFAULT_NET_WORTH_HORIZON_YEARS) }
    val selection = state.netWorthSelection()
    val accounts = state.retirementAccountsResult().getOrNull()
    val projection = runCatching {
        selection?.bitcoinValueCents?.let { bitcoin ->
            accounts?.let { projectNetWorth(bitcoin, it, years) }
        }
    }.getOrNull()

    Panel("Net worth projections", "Scenario, not a forecast") {
        Column(Modifier.padding(VaultSpace.md)) {
            HorizonSelector(NET_WORTH_HORIZONS, years) { years = it }
            if (projection == null) {
                StateBlock(
                    Freshness.EMPTY,
                    "Projection unavailable",
                    "A complete Bitcoin value, retirement snapshot, and market quote are required.",
                )
            } else {
                KpiStrip(
                    listOf(
                        Kpi("Net worth at ${projection.years} years", formatProjectionCents(state, projection.totalCents, displayUnit), provenance = Provenance.ESTIMATED),
                        Kpi("Retirement", formatProjectionCents(state, projection.retirementCents, displayUnit), provenance = Provenance.ESTIMATED),
                        Kpi("Bitcoin", formatProjectionCents(state, projection.bitcoinCents, displayUnit), provenance = Provenance.ESTIMATED),
                    ),
                )
                LedgerRow("VOO", "11%/year · weekly contributions included", formatProjectionCents(state, projection.vooCents, displayUnit))
                LedgerRow("IBIT", "16%/year · weekly contributions included", formatProjectionCents(state, projection.ibitCents, displayUnit))
                LedgerRow("Bitcoin", "16%/year · $2,000/week", formatProjectionCents(state, projection.bitcoinCents, displayUnit))
                if (projection.otherRetirementCents > 0L) {
                    LedgerRow("Other retirement", "Held flat · weekly contributions included", formatProjectionCents(state, projection.otherRetirementCents, displayUnit))
                }
                Text(
                    "Victor specified VOO at 11% per year and IBIT and Bitcoin at 16% per year. The scenario uses the monthly rates equivalent to those annual returns, converts weekly contributions using 52 weeks per year, and splits each account's contribution by its current holding weights.",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.foregroundSecondary,
                    modifier = Modifier.padding(top = VaultSpace.sm),
                )
            }
        }
    }
}

private fun formatProjectionCents(state: VaultUiState, cents: Long, displayUnit: DisplayUnit): String =
    when (displayUnit) {
        DisplayUnit.USD -> Money.formatUsd(cents)
        DisplayUnit.BTC, DisplayUnit.SATS -> state.formatFinanceCentsOrNull(cents, displayUnit)
            ?: Money.PRICE_UNAVAILABLE
    }
