package com.sats21m.vogelvault.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.sats21m.vogelvault.R
import com.sats21m.vogelvault.domain.DisplayUnit
import com.sats21m.vogelvault.domain.MarketQuote
import com.sats21m.vogelvault.domain.MarketSymbol
import com.sats21m.vogelvault.domain.Money
import com.sats21m.vogelvault.domain.netWorthScopeFor
import com.sats21m.vogelvault.ui.components.Kpi
import com.sats21m.vogelvault.ui.components.KpiStrip
import com.sats21m.vogelvault.ui.components.LedgerRow
import com.sats21m.vogelvault.ui.components.Panel
import com.sats21m.vogelvault.ui.components.Provenance
import com.sats21m.vogelvault.ui.components.StateBlock
import com.sats21m.vogelvault.ui.components.StatusBanner
import com.sats21m.vogelvault.ui.components.VaultLazyListScope
import com.sats21m.vogelvault.ui.theme.VaultSpace
import com.sats21m.vogelvault.ui.theme.VaultTextMuted
import com.sats21m.vogelvault.ui.theme.VaultWarning
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val RETIREMENT_HORIZONS = listOf(10, 20, 30)
private val DEFAULT_HORIZON_YEARS = RETIREMENT_HORIZONS.first()
private const val WEEKLY_DCA_SATS = 2_100_000L
private const val ADULT_ANNUAL_BONUS_CENTS = 9_700_000L
private val MONTHS_PER_YEAR = BigDecimal(12)
private val WEEKS_PER_MONTH = BigDecimal("4.33")
private val MONTHLY_BTC_GROWTH = BigDecimal("0.15").divide(MONTHS_PER_YEAR)

internal data class RetirementProjectionInputs(
    val startingSats: Long,
    val btcQuote: MarketQuote,
    val balanceAsOf: String,
    val monthlyIncomeCents: Long,
    val monthlyBudgetCents: Long,
    val adultAnnualBonusCents: Long,
) {
    init {
        require(btcQuote.symbol == MarketSymbol.BTC && btcQuote.isUsable)
    }

    val btcPriceCents: Long
        get() = checkNotNull(btcQuote.priceCents)

    val btcPriceAsOf: String
        get() = checkNotNull(btcQuote.fetchedAt)

    val monthlySurplusCents: Long
        get() = (monthlyIncomeCents - monthlyBudgetCents).coerceAtLeast(0L)
}

internal data class RetirementBitcoinStack(
    val sats: Long,
    val balanceAsOf: String,
    val btcQuote: MarketQuote?,
)

internal data class RetirementProjection(
    val years: Int,
    val projectedSats: Long,
    val monthlyDcaSats: Long,
    val monthlySurplusSats: Long,
    val monthlyBonusSats: Long,
)

internal sealed interface RetirementInputResult {
    data class Available(val inputs: RetirementProjectionInputs) : RetirementInputResult
    data class Unavailable(val reason: RetirementUnavailableReason) : RetirementInputResult
}

internal enum class RetirementUnavailableReason {
    BITCOIN_BALANCE,
    MARKET_QUOTE,
    INCOME,
    BUDGET,
    MATH,
}

/**
 * The current in-scope Bitcoin position is useful even when scenario inputs are not.
 * A quote is optional because native BTC/sat display never needs a fiat conversion.
 */
internal fun retirementBitcoinStack(state: VaultUiState): RetirementBitcoinStack? {
    val balance = state.data.netWorthBalanceForDisplay() ?: return null
    if (!state.activeProfile.sharesNetWorth(balance.owner)) return null
    return RetirementBitcoinStack(
        sats = balance.totalSats,
        balanceAsOf = balance.asOf,
        btcQuote = state.operationalBitcoinQuote(),
    )
}

/**
 * Builds only checkable inputs.
 *
 * Canonical BTC fiat and recorded buys are intentionally ignored as conversion
 * sources. The only accepted price is the operational BTC market quote.
 */
internal fun retirementInputs(state: VaultUiState): RetirementInputResult {
    val data = state.data
    val stack = retirementBitcoinStack(state)
        ?: return RetirementInputResult.Unavailable(RetirementUnavailableReason.BITCOIN_BALANCE)
    val quote = stack.btcQuote
        ?: return RetirementInputResult.Unavailable(RetirementUnavailableReason.MARKET_QUOTE)

    val incomeRows = data.income.value.netWorthScopeFor(state.activeProfile)
    if (data.incomeFiguresUnavailable || incomeRows.isEmpty()) {
        return RetirementInputResult.Unavailable(RetirementUnavailableReason.INCOME)
    }

    val budget = data.budget.value
    if (
        data.budget.requiredProjectionUnavailable ||
        budget == null ||
        !state.activeProfile.sharesNetWorth(budget.owner)
    ) {
        return RetirementInputResult.Unavailable(RetirementUnavailableReason.BUDGET)
    }

    val currentIncomeMonth =
        DateTimeFormatter.ofPattern("yyyy-MM").format(
            Instant.ofEpochMilli(state.now).atZone(ZoneId.systemDefault()),
        )
    val currentIncomeRows = incomeRows.filter { it.month == currentIncomeMonth }
    if (currentIncomeRows.isEmpty()) {
        return RetirementInputResult.Unavailable(RetirementUnavailableReason.INCOME)
    }
    val monthlyIncome = currentIncomeRows.sumLongOrNull { it.amountCents }
        ?: return RetirementInputResult.Unavailable(RetirementUnavailableReason.MATH)
    val monthlyBudget = budget.categories.sumLongOrNull { it.budgetCents }
        ?: return RetirementInputResult.Unavailable(RetirementUnavailableReason.MATH)
    if (runCatching { Math.subtractExact(monthlyIncome, monthlyBudget) }.isFailure) {
        return RetirementInputResult.Unavailable(RetirementUnavailableReason.MATH)
    }
    return RetirementInputResult.Available(
        RetirementProjectionInputs(
            startingSats = stack.sats,
            btcQuote = quote,
            balanceAsOf = stack.balanceAsOf,
            monthlyIncomeCents = monthlyIncome,
            monthlyBudgetCents = monthlyBudget,
            adultAnnualBonusCents =
                if (state.activeProfile.isAdult) ADULT_ANNUAL_BONUS_CENTS else 0L,
        ),
    )
}

/**
 * Port of RetirementView.projectBtc.
 *
 * Values remain BigDecimal until the final satoshi boundary. The scenario uses
 * the operational quote as a constant conversion rate and applies 15% / 12 monthly
 * growth, matching Apple; that is an assumption, not a market forecast.
 */
internal fun projectRetirement(
    inputs: RetirementProjectionInputs,
    years: Int,
): RetirementProjection? {
    if (years <= 0 || inputs.startingSats < 0L || inputs.btcPriceCents <= 0L) return null

    val price = BigDecimal(inputs.btcPriceCents)
    val satsPerBtc = BigDecimal(Money.SATS_PER_BTC)
    val monthlyDca = BigDecimal(WEEKLY_DCA_SATS).multiply(WEEKS_PER_MONTH)
    val monthlySurplus =
        BigDecimal(inputs.monthlySurplusCents)
            .multiply(satsPerBtc)
            .divide(price, 16, RoundingMode.HALF_UP)
    val monthlyBonus =
        BigDecimal(inputs.adultAnnualBonusCents)
            .multiply(satsPerBtc)
            .divide(price, 16, RoundingMode.HALF_UP)
            .divide(MONTHS_PER_YEAR, 16, RoundingMode.HALF_UP)

    var projected = BigDecimal(inputs.startingSats)
    val monthlyContribution = monthlyDca + monthlySurplus + monthlyBonus
    repeat(years * 12) {
        projected = projected.multiply(BigDecimal.ONE + MONTHLY_BTC_GROWTH) + monthlyContribution
    }

    return runCatching {
        RetirementProjection(
            years = years,
            projectedSats = projected.toSats(),
            monthlyDcaSats = monthlyDca.toSats(),
            monthlySurplusSats = monthlySurplus.toSats(),
            monthlyBonusSats = monthlyBonus.toSats(),
        )
    }.getOrNull()
}

private fun BigDecimal.toSats(): Long =
    setScale(0, RoundingMode.HALF_UP).longValueExact()

internal fun VaultLazyListScope.retirement(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    retirementHoldings(state, displayUnit)
    item { RetirementScreen(state, displayUnit) }
}

@Composable
private fun RetirementScreen(
    state: VaultUiState,
    displayUnit: DisplayUnit,
) {
    var horizon by rememberSaveable { mutableIntStateOf(DEFAULT_HORIZON_YEARS) }
    val stack = retirementBitcoinStack(state)
    val inputResult = retirementInputs(state)

    Column(verticalArrangement = Arrangement.spacedBy(VaultSpace.md)) {
        if (stack != null) CurrentBitcoinStack(stack, displayUnit)
        when (inputResult) {
            is RetirementInputResult.Unavailable -> RetirementUnavailable(inputResult.reason)
            is RetirementInputResult.Available -> {
                val inputs = inputResult.inputs
                val projection = projectRetirement(inputs, horizon)
                if (projection == null) {
                    Panel(stringResource(R.string.retirement_projection_title)) {
                        StateBlock(
                            com.sats21m.vogelvault.domain.Freshness.ERROR,
                            stringResource(R.string.retirement_math_unavailable_title),
                            stringResource(R.string.retirement_math_unavailable_detail),
                        )
                    }
                } else {
                    HorizonSelector(RETIREMENT_HORIZONS, horizon) { horizon = it }
                    ProjectionSummary(inputs, projection, displayUnit)
                    ProjectionBreakdown(inputs, projection, displayUnit)
                    ProjectionAssumptions(inputs)
                }
            }
        }
    }
}

@Composable
private fun CurrentBitcoinStack(
    stack: RetirementBitcoinStack,
    displayUnit: DisplayUnit,
) {
    KpiStrip(
        listOf(
            Kpi(
                "Current Bitcoin stack",
                formatFinancialAmount(
                    FinancialAmount(sats = stack.sats),
                    displayUnit,
                    stack.btcQuote,
                ),
                stringResource(R.string.retirement_balance_as_of_hint, stack.balanceAsOf),
            ),
        ),
    )
}

@Composable
private fun RetirementUnavailable(reason: RetirementUnavailableReason) {
    val title: String
    val detail: String
    when (reason) {
        RetirementUnavailableReason.BITCOIN_BALANCE -> {
            title = stringResource(R.string.retirement_balance_unavailable_title)
            detail = stringResource(R.string.retirement_balance_unavailable_detail)
        }
        RetirementUnavailableReason.MARKET_QUOTE -> {
            title = stringResource(R.string.retirement_price_unavailable_title)
            detail = stringResource(R.string.retirement_price_unavailable_detail)
        }
        RetirementUnavailableReason.INCOME -> {
            title = stringResource(R.string.retirement_income_unavailable_title)
            detail = stringResource(R.string.retirement_income_unavailable_detail)
        }
        RetirementUnavailableReason.BUDGET -> {
            title = stringResource(R.string.retirement_budget_unavailable_title)
            detail = stringResource(R.string.retirement_budget_unavailable_detail)
        }
        RetirementUnavailableReason.MATH -> {
            title = stringResource(R.string.retirement_math_unavailable_title)
            detail = stringResource(R.string.retirement_math_unavailable_detail)
        }
    }
    Panel(stringResource(R.string.retirement_projection_title)) {
        StateBlock(com.sats21m.vogelvault.domain.Freshness.EMPTY, title, detail)
    }
}

@Composable
private fun ProjectionSummary(
    inputs: RetirementProjectionInputs,
    projection: RetirementProjection,
    displayUnit: DisplayUnit,
) {
    val quote = inputs.btcQuote
    KpiStrip(
        listOf(
            Kpi(
                stringResource(R.string.retirement_projected_bitcoin_label, projection.years),
                formatFinancialAmount(
                    FinancialAmount(sats = projection.projectedSats),
                    displayUnit,
                    quote,
                ),
                stringResource(R.string.retirement_scenario_hint),
                provenance = Provenance.ESTIMATED,
            ),
        ),
    )
}

@Composable
private fun ProjectionBreakdown(
    inputs: RetirementProjectionInputs,
    projection: RetirementProjection,
    displayUnit: DisplayUnit,
) {
    val quote = inputs.btcQuote
    Panel(stringResource(R.string.retirement_monthly_inputs_title)) {
        LedgerRow(
            primary = stringResource(R.string.retirement_dca_label),
            secondary = stringResource(R.string.retirement_dca_detail),
            figure = formatFinancialAmount(
                FinancialAmount(sats = projection.monthlyDcaSats),
                displayUnit,
                quote,
            ),
        )
        LedgerRow(
            primary = stringResource(R.string.retirement_surplus_label),
            secondary = stringResource(
                R.string.retirement_surplus_detail,
                formatFinancialAmount(
                    FinancialAmount(usdCents = inputs.monthlyIncomeCents),
                    displayUnit,
                    quote,
                ),
                formatFinancialAmount(
                    FinancialAmount(usdCents = inputs.monthlyBudgetCents),
                    displayUnit,
                    quote,
                ),
            ),
            figure = formatFinancialAmount(
                FinancialAmount(
                    usdCents = inputs.monthlySurplusCents,
                    sats = projection.monthlySurplusSats,
                ),
                displayUnit,
                quote,
            ),
        )
        if (inputs.adultAnnualBonusCents > 0L) {
            LedgerRow(
                primary = stringResource(R.string.retirement_bonus_label),
                secondary = stringResource(
                    R.string.retirement_bonus_detail,
                    formatFinancialAmount(
                        FinancialAmount(usdCents = inputs.adultAnnualBonusCents),
                        displayUnit,
                        quote,
                    ),
                ),
                figure = formatFinancialAmount(
                    FinancialAmount(sats = projection.monthlyBonusSats),
                    displayUnit,
                    quote,
                ),
            )
        }
    }
}

@Composable
private fun ProjectionAssumptions(inputs: RetirementProjectionInputs) {
    Panel(stringResource(R.string.retirement_assumptions_title)) {
        Column(
            Modifier.padding(VaultSpace.md),
            verticalArrangement = Arrangement.spacedBy(VaultSpace.sm),
        ) {
            AssumptionLine(
                stringResource(
                    R.string.retirement_price_assumption,
                    Money.formatUsd(inputs.btcPriceCents),
                    inputs.btcPriceAsOf,
                ),
            )
            AssumptionLine(stringResource(R.string.retirement_growth_assumption))
            AssumptionLine(stringResource(R.string.retirement_contribution_assumption))
            AssumptionLine(stringResource(R.string.retirement_securities_excluded))
        }
    }
    Spacer(Modifier.padding(bottom = VaultSpace.xs))
    StatusBanner(
        stringResource(R.string.retirement_scenario_warning_title),
        stringResource(R.string.retirement_scenario_warning_detail),
        tone = VaultWarning,
    )
}

@Composable
private fun AssumptionLine(text: String) {
    Text(
        "• $text",
        style = MaterialTheme.typography.bodySmall,
        color = VaultTextMuted,
    )
}
